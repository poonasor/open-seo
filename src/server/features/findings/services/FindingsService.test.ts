import type { Client } from "@libsql/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  mockConnectedEmptyProviders,
  resetFindingsDb,
  startFindingsService,
  type FindingsService,
} from "./findings-test-support";

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let service: FindingsService;

beforeAll(async () => {
  ({ client, FindingsService: service } = await startFindingsService());
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-27T00:00:00.000Z");
  await resetFindingsDb(client);
  mockConnectedEmptyProviders();
});

afterEach(() => {
  vi.useRealTimers();
});

const create = (overrides: Record<string, unknown> = {}) =>
  service.createFinding("proj_1", {
    prefix: "PM",
    site: "example.com",
    finding: "Pricing page has no FAQ",
    actor: "tester",
    ...overrides,
  });

const move = (
  toStage: Parameters<typeof service.moveStage>[2]["toStage"],
  extra: Record<string, unknown> = {},
) =>
  service.moveStage("proj_1", "PM-F001", {
    toStage,
    actor: "tester",
    ...extra,
  });

describe("id allocation", () => {
  it("numbers findings per prefix and never reuses a deleted number", async () => {
    expect((await create()).finding.id).toBe("PM-F001");
    expect((await create()).finding.id).toBe("PM-F002");
    expect((await create({ prefix: "BL" })).finding.id).toBe("BL-F001");

    await client.execute("DELETE FROM findings WHERE id = 'PM-F002'");
    expect((await create()).finding.id).toBe("PM-F003");
  });

  it("lets an import claim a high id, continues after it, and rejects a taken one", async () => {
    expect((await create({ id: "PM-F014" })).finding.number).toBe(14);
    expect((await create()).finding.id).toBe("PM-F015");

    await expect(create({ id: "PM-F014" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("keeps a prefix owned by one project", async () => {
    await create();
    await expect(
      service.createFinding("proj_2", {
        prefix: "PM",
        site: "other.com",
        finding: "x",
        actor: "tester",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("stage transitions", () => {
  it("moves in order, records events, and starts the re-measure clock at live", async () => {
    await create();
    for (const stage of ["brief", "draft", "spec", "filed", "live"] as const) {
      await move(stage);
    }
    const { finding, events } = await service.getFinding("proj_1", "PM-F001");
    expect(finding.stage).toBe("live");
    expect(finding.liveAt).toBe("2026-10-27T00:00:00.000Z");
    // 28-day window + 3-day Search Console lag.
    expect(finding.remeasureDueAt).toBe("2026-11-27T00:00:00.000Z");
    expect(events.map((e) => e.toStage)).toEqual([
      "finding",
      "brief",
      "draft",
      "spec",
      "filed",
      "live",
    ]);
  });

  it("allows Finding -> Spec for technical fixes", async () => {
    await create();
    expect((await move("spec")).finding.stage).toBe("spec");
  });

  it("rejects a move that lost a race and records no event for it", async () => {
    await create();
    // Both read the finding at "finding"; only one guarded update can win.
    const [first, second] = await Promise.allSettled([
      move("brief"),
      move("spec"),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({
      status: "rejected",
      reason: { code: "CONFLICT" },
    });

    const { finding, events } = await service.getFinding("proj_1", "PM-F001");
    expect(finding.stage).toBe("brief");
    expect(events.map((e) => e.toStage)).toEqual(["finding", "brief"]);
  });

  it("refuses to skip to Live unless importing", async () => {
    await create();
    await expect(move("live")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });

    const imported = await move("re_measured", {
      import: true,
      liveAt: "2026-09-01T00:00:00.000Z",
    });
    expect(imported.finding.stage).toBe("re_measured");
    expect(imported.finding.remeasureDueAt).toBe("2026-10-02T00:00:00.000Z");
  });
});

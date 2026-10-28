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
  providerMocks,
  resetFindingsDb,
  startFindingsService,
  type FindingsService,
} from "./findings-test-support";

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let service: FindingsService;
let runScheduledRemeasures: () => Promise<void>;

beforeAll(async () => {
  ({ client, FindingsService: service } = await startFindingsService());
  ({ runScheduledRemeasures } = await import("./remeasure"));
});

afterAll(() => {
  client.close();
});

const LIVE_DAY = "2026-09-01T00:00:00.000Z";
// Day 31: the after window (to 2026-09-29) ended 3 days ago.
const DUE = "2026-10-02T00:00:00.000Z";

const rows = (clicks: number, impressions: number, position: number) => [
  {
    keys: ["pricing software"],
    clicks,
    impressions,
    ctr: clicks / impressions,
    position,
  },
];

// Search Console answers by window: the before window ends the day before
// the finding went live.
function mockWindows(
  before: ReturnType<typeof rows>,
  after: ReturnType<typeof rows>,
) {
  providerMocks.querySearchAnalytics.mockImplementation(
    async (_site: string, request: { endDate: string }) =>
      request.endDate <= "2026-08-31" ? before : after,
  );
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(LIVE_DAY);
  await resetFindingsDb(client);
  mockConnectedEmptyProviders();
  await service.createFinding("proj_1", {
    id: "PM-F001",
    site: "example.com",
    finding: "Pricing page has no FAQ",
    targetPage: "https://example.com/pricing",
    stage: "live",
    liveAt: LIVE_DAY,
    actor: "tester",
  });
  providerMocks.querySearchAnalytics.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

const detail = () => service.getFinding("proj_1", "PM-F001");

describe("scheduled re-measure", () => {
  it("moves a due finding to Re-measured with a verdict, measurement and event", async () => {
    mockWindows(rows(50, 1000, 8), rows(80, 1500, 5));
    vi.setSystemTime(DUE);
    await runScheduledRemeasures();

    const { finding, measurements, events } = await detail();
    expect(finding.stage).toBe("re_measured");
    expect(finding.verdict).toBe("moved");
    const remeasure = measurements.find((m) => m.kind === "remeasure");
    expect(remeasure).toMatchObject({
      verdict: "moved",
      windowStart: "2026-08-04",
      windowEnd: "2026-09-29",
    });
    expect(remeasure?.deltas).toMatchObject({
      clicks: { before: 50, after: 80 },
      position: { placesGained: 3 },
    });
    expect(events.at(-1)).toMatchObject({
      fromStage: "live",
      toStage: "re_measured",
      actor: "system:remeasure",
    });
    expect(providerMocks.createDataforseoClient).not.toHaveBeenCalled();
  });

  it("stores the reason when the data is too thin", async () => {
    mockWindows(rows(1, 40, 8), rows(2, 60, 7));
    vi.setSystemTime(DUE);
    await runScheduledRemeasures();

    const { finding, measurements } = await detail();
    expect(finding.verdict).toBe("data_too_thin");
    const deltas = JSON.stringify(
      measurements.find((m) => m.kind === "remeasure")?.deltas,
    );
    expect(deltas).toContain("100 impressions");
  });

  it("is idempotent: a second run reads nothing and adds nothing", async () => {
    mockWindows(rows(50, 1000, 8), rows(50, 1000, 8));
    vi.setSystemTime(DUE);
    await runScheduledRemeasures();
    providerMocks.querySearchAnalytics.mockClear();
    await runScheduledRemeasures();

    expect(providerMocks.querySearchAnalytics).not.toHaveBeenCalled();
    const { measurements, events } = await detail();
    expect(measurements.filter((m) => m.kind === "remeasure")).toHaveLength(1);
    expect(events.filter((e) => e.toStage === "re_measured")).toHaveLength(1);
  });

  it("leaves a finding alone until its after window has closed", async () => {
    mockWindows(rows(50, 1000, 8), rows(80, 1500, 5));
    vi.setSystemTime("2026-09-20T00:00:00.000Z");
    await runScheduledRemeasures();

    expect((await detail()).finding.stage).toBe("live");
    expect(providerMocks.querySearchAnalytics).not.toHaveBeenCalled();
  });

  it("retries next tick when Search Console fails", async () => {
    providerMocks.querySearchAnalytics.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.setSystemTime(DUE);
    await runScheduledRemeasures();
    expect((await detail()).finding.stage).toBe("live");

    mockWindows(rows(50, 1000, 8), rows(50, 1000, 8));
    await runScheduledRemeasures();
    expect((await detail()).finding.stage).toBe("re_measured");
  });
});

describe("remeasureFinding (manual)", () => {
  it("refuses while the windows are not complete", async () => {
    vi.setSystemTime("2026-09-20T00:00:00.000Z");
    await expect(
      service.remeasureFinding("proj_1", "PM-F001", "mcp:user_1"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await detail()).finding.stage).toBe("live");
  });

  it("re-measures once complete, and a repeat changes nothing", async () => {
    mockWindows(rows(50, 1000, 8), rows(30, 600, 8));
    vi.setSystemTime(DUE);
    const first = await service.remeasureFinding(
      "proj_1",
      "PM-F001",
      "mcp:user_1",
    );
    expect(first.finding).toMatchObject({
      stage: "re_measured",
      verdict: "worse",
    });
    const again = await service.remeasureFinding(
      "proj_1",
      "PM-F001",
      "mcp:user_1",
    );
    expect(again.measurements).toHaveLength(first.measurements.length);
  });
});

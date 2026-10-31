import type { Client } from "@libsql/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { VikunjaClient } from "@/server/features/findings/vikunja/vikunjaClient";
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

const listProjectTasks = vi.fn();
const vikunja: VikunjaClient = {
  listProjectTasks,
  taskUrl: (id) => `https://tasks.example.com/tasks/${id}`,
};

beforeEach(async () => {
  await resetFindingsDb(client);
  mockConnectedEmptyProviders();
  listProjectTasks.mockResolvedValue([
    { id: 11, title: "PM-F001 Fix title tag", done: false },
    { id: 12, title: "PM-F0012 unrelated", done: false },
    { id: 13, title: "Mention PM-F002 mid-title", done: true },
  ]);
});

async function seed() {
  const input = { prefix: "PM", site: "example.com", actor: "test" };
  await service.createFinding("proj_1", { ...input, finding: "one" });
  await service.createFinding("proj_1", { ...input, finding: "two" });
  await service.moveStage("proj_1", "PM-F001", {
    toStage: "spec",
    actor: "test",
  });
}

const sync = (dryRun: boolean) =>
  service.syncFindingsVikunja("proj_1", {
    dryRun,
    actor: "vikunja-sync",
    mappings: [{ prefix: "PM", vikunjaProjectId: "7" }],
    client: vikunja,
  });

describe("syncFindingsVikunja", () => {
  it("a dry run reports the plan and writes nothing", async () => {
    await seed();
    const result = await sync(true);

    expect(result.changes).toMatchObject([
      { findingId: "PM-F001", vikunjaTaskId: "11", movedToFiled: true },
    ]);
    const { finding } = await service.getFinding("proj_1", "PM-F001");
    expect(finding).toMatchObject({ stage: "spec", vikunjaTaskId: null });
    const prefixes = await client.execute(
      "SELECT vikunja_project_id FROM finding_prefixes",
    );
    expect(prefixes.rows[0]?.vikunja_project_id).toBeNull();
  });

  it("applies: links the task, files a Spec finding, stores the mapping, and is idempotent", async () => {
    await seed();
    await sync(false);

    const { finding, events } = await service.getFinding("proj_1", "PM-F001");
    expect(finding).toMatchObject({
      stage: "filed",
      vikunjaTaskId: "11",
      vikunjaTaskUrl: "https://tasks.example.com/tasks/11",
      vikunjaDone: false,
    });
    expect(events.at(-1)).toMatchObject({
      fromStage: "spec",
      toStage: "filed",
      actor: "vikunja-sync",
    });

    // The mapping now lives in the database, so no mapping is passed.
    const again = await service.syncFindingsVikunja("proj_1", {
      dryRun: false,
      actor: "vikunja-sync",
      client: vikunja,
    });
    expect(again.changes).toEqual([]);
    expect(listProjectTasks).toHaveBeenLastCalledWith("7");
  });

  it("records done state without moving a finding to live", async () => {
    await seed();
    await sync(false);
    listProjectTasks.mockResolvedValue([
      { id: 11, title: "PM-F001 Fix title tag", done: true },
    ]);
    const result = await sync(false);

    expect(result.changes).toMatchObject([
      { findingId: "PM-F001", doneChanged: true, movedToFiled: false },
    ]);
    const { finding } = await service.getFinding("proj_1", "PM-F001");
    expect(finding).toMatchObject({ stage: "filed", vikunjaDone: true });
  });
});

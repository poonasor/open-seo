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

const goLive = async (overrides: Record<string, unknown> = {}) => {
  await create(overrides);
  for (const stage of ["brief", "draft", "spec", "filed", "live"] as const) {
    await service.moveStage("proj_1", "PM-F001", {
      toStage: stage,
      actor: "tester",
    });
  }
  return service.getFinding("proj_1", "PM-F001");
};

// The stub rows below hold exactly the columns the baseline reads.
async function seedRankSnapshot(snapshot: {
  keyword: string;
  device: "desktop" | "mobile";
  position: number | null;
  checkedAt: string;
  status?: string;
  projectId?: string;
}) {
  const runId = `run_${snapshot.keyword}_${snapshot.device}_${snapshot.checkedAt}_${snapshot.status ?? "completed"}`;
  await client.execute({
    sql: `INSERT INTO rank_check_runs (id, config_id, project_id, status, started_at)
          VALUES (?, 'cfg_1', ?, ?, ?)`,
    args: [
      runId,
      snapshot.projectId ?? "proj_1",
      snapshot.status ?? "completed",
      snapshot.checkedAt,
    ],
  });
  await client.execute({
    sql: `INSERT INTO rank_snapshots (run_id, tracking_keyword_id, keyword, device, position, checked_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      runId,
      `kw_${snapshot.keyword}`,
      snapshot.keyword,
      snapshot.device,
      snapshot.position,
      snapshot.checkedAt,
    ],
  });
}

async function seedAiAnswer(answer: {
  prompt: string;
  engine: string;
  collectedAt: string;
  mentioned: boolean;
  cited: boolean;
}) {
  await client.execute(
    "INSERT OR IGNORE INTO ai_trackers (id, project_id) VALUES ('trk_1', 'proj_1')",
  );
  await client.execute({
    sql: `INSERT OR IGNORE INTO ai_prompts (id, tracker_id, topic, text)
          VALUES (?, 'trk_1', 'topic', ?)`,
    args: [`p_${answer.prompt}`, answer.prompt],
  });
  const observationId = `o_${answer.prompt}_${answer.engine}_${answer.collectedAt}`;
  await client.execute({
    sql: `INSERT INTO ai_observations (id, run_id, prompt_id, engine, status, collected_at)
          VALUES (?, 'ai_run_1', ?, ?, 'completed', ?)`,
    args: [
      observationId,
      `p_${answer.prompt}`,
      answer.engine,
      answer.collectedAt,
    ],
  });
  await client.execute({
    sql: `INSERT INTO ai_matches (id, observation_id, domain, own, mentioned, cited)
          VALUES (?, ?, 'example.com', 1, ?, ?)`,
    args: [
      `m_${observationId}`,
      observationId,
      Number(answer.mentioned),
      Number(answer.cited),
    ],
  });
}

describe("baseline at Live", () => {
  it("records a baseline from Search Console, stored ranks and stored AI answers", async () => {
    providerMocks.querySearchAnalytics.mockResolvedValue([
      {
        keys: ["pricing software"],
        clicks: 100,
        impressions: 1000,
        ctr: 0.1,
        position: 5,
      },
      {
        keys: ["best pricing software"],
        clicks: 20,
        impressions: 500,
        ctr: 0.04,
        position: 12,
      },
      // Anonymous queries carry no keyword to track or re-measure.
      { keys: [], clicks: 3, impressions: 30, ctr: 0.1, position: 1 },
    ]);
    providerMocks.inspectUrl.mockResolvedValue({
      indexStatusResult: {
        coverageState: "Submitted and indexed",
        lastCrawlTime: "2026-10-20T00:00:00.000Z",
        googleCanonical: "https://example.com/pricing",
      },
    });
    await seedRankSnapshot({
      keyword: "pricing software",
      device: "desktop",
      position: 9,
      checkedAt: "2026-10-01T00:00:00.000Z",
    });
    await seedRankSnapshot({
      keyword: "pricing software",
      device: "desktop",
      position: 4,
      checkedAt: "2026-10-10T00:00:00.000Z",
    });
    await seedRankSnapshot({
      keyword: "pricing software",
      device: "mobile",
      position: 6,
      checkedAt: "2026-10-10T00:00:00.000Z",
    });
    // A failed run stored a position, but a baseline reads completed runs only.
    await seedRankSnapshot({
      keyword: "pricing software",
      device: "mobile",
      position: 1,
      checkedAt: "2026-10-25T00:00:00.000Z",
      status: "failed",
    });
    // Another project's snapshots stay out.
    await seedRankSnapshot({
      keyword: "pricing software",
      device: "desktop",
      position: 1,
      checkedAt: "2026-10-26T00:00:00.000Z",
      projectId: "proj_2",
    });
    await seedAiAnswer({
      prompt: "what is the best pricing software",
      engine: "chatgpt",
      collectedAt: "2026-10-01T00:00:00.000Z",
      mentioned: false,
      cited: false,
    });
    await seedAiAnswer({
      prompt: "what is the best pricing software",
      engine: "chatgpt",
      collectedAt: "2026-10-15T00:00:00.000Z",
      mentioned: true,
      cited: false,
    });
    // A tracked prompt matching no target keyword is not this finding's answer.
    await seedAiAnswer({
      prompt: "how to bake bread",
      engine: "chatgpt",
      collectedAt: "2026-10-15T00:00:00.000Z",
      mentioned: true,
      cited: true,
    });

    const { measurements } = await goLive({
      targetPage: "https://example.com/pricing",
    });

    expect(measurements).toHaveLength(1);
    expect(measurements[0]).toMatchObject({
      kind: "baseline",
      rulesVersion: "1",
      // 28 days ending before Search Console's 3-day lag.
      windowStart: "2026-09-27",
      windowEnd: "2026-10-24",
    });
    expect(measurements[0].metrics).toEqual({
      searchConsole: {
        clicks: 120,
        impressions: 1500,
        ctr: 120 / 1500,
        position: (5 * 1000 + 12 * 500) / 1500,
        topQueries: [
          {
            query: "pricing software",
            clicks: 100,
            impressions: 1000,
            ctr: 0.1,
            position: 5,
          },
          {
            query: "best pricing software",
            clicks: 20,
            impressions: 500,
            ctr: 0.04,
            position: 12,
          },
        ],
      },
      urlInspection: {
        indexState: "Submitted and indexed",
        lastCrawl: "2026-10-20T00:00:00.000Z",
        googleCanonical: "https://example.com/pricing",
      },
      rankTracking: [
        {
          keyword: "pricing software",
          tracked: true,
          desktop: 4,
          mobile: 6,
          checkedAt: "2026-10-10T00:00:00.000Z",
        },
        {
          keyword: "best pricing software",
          tracked: false,
          desktop: null,
          mobile: null,
          checkedAt: null,
        },
      ],
      aiVisibility: [
        {
          prompt: "what is the best pricing software",
          engine: "chatgpt",
          mentioned: true,
          cited: false,
          collectedAt: "2026-10-15T00:00:00.000Z",
        },
      ],
    });
    expect(measurements[0].sources).toEqual(
      [
        "search_console_performance",
        "url_inspection",
        "rank_tracking_stored",
        "ai_visibility_stored",
      ].map((tool) => ({ tool, date: "2026-10-27T00:00:00.000Z" })),
    );

    expect(providerMocks.querySearchAnalytics).toHaveBeenCalledWith(
      "sc-domain:example.com",
      expect.objectContaining({
        startDate: "2026-09-27",
        endDate: "2026-10-24",
        dimensions: ["query"],
        rowLimit: 1000,
        dimensionFilterGroups: [
          {
            groupType: "and",
            filters: [
              {
                dimension: "page",
                operator: "equals",
                expression: "https://example.com/pricing",
              },
            ],
          },
        ],
      }),
    );
    expect(providerMocks.inspectUrl).toHaveBeenCalledWith(
      "sc-domain:example.com",
      "https://example.com/pricing",
      undefined,
    );
    expect(providerMocks.createDataforseoClient).not.toHaveBeenCalled();
  });

  it("stores data missing when Search Console is not connected and still goes live", async () => {
    providerMocks.getByProjectId.mockResolvedValue(null);

    const { finding, measurements } = await goLive({
      targetPage: "https://example.com/pricing",
    });

    expect(finding.stage).toBe("live");
    expect(measurements[0].metrics).toEqual({
      searchConsole: "data missing",
      urlInspection: "data missing",
      rankTracking: "data missing",
      aiVisibility: "data missing",
    });
    expect(measurements[0].sources).toEqual([]);
    expect(providerMocks.createDataforseoClient).not.toHaveBeenCalled();
  });

  it("stores data missing for a finding whose page does not exist yet", async () => {
    const { measurements } = await goLive();

    expect(providerMocks.querySearchAnalytics).not.toHaveBeenCalled();
    expect(providerMocks.inspectUrl).not.toHaveBeenCalled();
    expect(measurements[0].metrics).toMatchObject({
      searchConsole: "data missing",
      urlInspection: "data missing",
    });
  });

  it("keeps one baseline when a finding goes live twice in the same window", async () => {
    providerMocks.querySearchAnalytics.mockResolvedValue([
      {
        keys: ["pricing software"],
        clicks: 1,
        impressions: 2,
        ctr: 0.5,
        position: 3,
      },
    ]);
    await goLive({ targetPage: "https://example.com/pricing" });

    await service.moveStage("proj_1", "PM-F001", {
      toStage: "filed",
      actor: "tester",
      import: true,
    });
    await service.moveStage("proj_1", "PM-F001", {
      toStage: "live",
      actor: "tester",
      import: true,
    });

    const { measurements } = await service.getFinding("proj_1", "PM-F001");
    expect(measurements).toHaveLength(1);
  });

  it("takes a baseline for an import created at live", async () => {
    await create({
      id: "PM-F010",
      stage: "live",
      liveAt: "2026-09-01T00:00:00.000Z",
      targetPage: "https://example.com/pricing",
    });

    const { measurements } = await service.getFinding("proj_1", "PM-F010");
    expect(measurements[0].kind).toBe("baseline");
    // The window is the standard last 28 days, not the backdated liveAt.
    expect(measurements[0].windowEnd).toBe("2026-10-24");
    expect(providerMocks.createDataforseoClient).not.toHaveBeenCalled();
  });
});

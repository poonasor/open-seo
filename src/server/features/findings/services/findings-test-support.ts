import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { vi } from "vitest";
import type * as FindingsServiceModule from "./FindingsService";

// Shared harness for the findings service tests: a real in-memory SQLite with
// the findings tables from the real migration (so constraints, id allocation
// and stage events run as generated SQL) plus stubs for the rank-tracker and
// AI-visibility tables the baseline reads. The providers a baseline
// summarizes are mocked at the client boundary, so the real GscService runs.
export const providerMocks = {
  querySearchAnalytics: vi.fn(),
  inspectUrl: vi.fn(),
  createDataforseoClient: vi.fn(),
  getByProjectId: vi.fn(),
};

export type FindingsService = typeof FindingsServiceModule.FindingsService;

/** Builds the database, mocks its collaborators, and imports the service
 *  against them. Call once per test file, before the tests. */
export async function startFindingsService(): Promise<{
  client: Client;
  FindingsService: FindingsService;
}> {
  const client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/db/runBatch", () => ({
    runBatch: async (build: (tx: unknown) => readonly Promise<unknown>[]) => {
      const results: unknown[] = [];
      for (const statement of build(testDb)) results.push(await statement);
      return results;
    },
  }));
  vi.doMock("@/server/lib/gscClient", async () => {
    const { GscApiError, GscTokenError } =
      await import("@/server/lib/gscErrors");
    return {
      GscApiError,
      GscTokenError,
      createGscClient: () => ({
        querySearchAnalytics: providerMocks.querySearchAnalytics,
        inspectUrl: providerMocks.inspectUrl,
      }),
    };
  });
  vi.doMock(
    "@/server/features/gsc/repositories/GscConnectionRepository",
    () => ({
      GscConnectionRepository: { getByProjectId: providerMocks.getByProjectId },
    }),
  );
  // A baseline is free reads only; if anything in its graph reaches a paid
  // client, this mock turns that into a loud zero-call assertion.
  vi.doMock("@/server/lib/dataforseo/client", () => ({
    createDataforseoClient: providerMocks.createDataforseoClient,
  }));

  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY);`,
      `INSERT INTO projects (id) VALUES ('proj_1'), ('proj_2');`,
      `CREATE TABLE rank_check_runs (
        id text PRIMARY KEY, config_id text NOT NULL, project_id text NOT NULL,
        status text NOT NULL, started_at text NOT NULL, completed_at text);`,
      `CREATE TABLE rank_snapshots (
        id integer PRIMARY KEY AUTOINCREMENT, run_id text NOT NULL,
        tracking_keyword_id text NOT NULL, keyword text NOT NULL,
        device text NOT NULL, position integer, url text, checked_at text NOT NULL);`,
      `CREATE TABLE ai_trackers (id text PRIMARY KEY, project_id text NOT NULL);`,
      `CREATE TABLE ai_prompts (
        id text PRIMARY KEY, tracker_id text NOT NULL, topic text NOT NULL,
        text text NOT NULL);`,
      `CREATE TABLE ai_observations (
        id text PRIMARY KEY, run_id text NOT NULL, prompt_id text NOT NULL,
        engine text NOT NULL, status text NOT NULL, collected_at text);`,
      `CREATE TABLE ai_matches (
        id text PRIMARY KEY, observation_id text NOT NULL, domain text NOT NULL,
        own integer NOT NULL, mentioned integer NOT NULL, cited integer NOT NULL);`,
      ...[
        "drizzle/sqlite/0064_mean_franklin_storm.sql",
        "drizzle/sqlite/0065_flat_norrin_radd.sql",
      ].flatMap((file) =>
        readFileSync(file, "utf8").split("--> statement-breakpoint"),
      ),
    ].join("\n"),
  );
  const { FindingsService } = await import("./FindingsService");
  return { client, FindingsService };
}

export async function resetFindingsDb(client: Client) {
  await client.executeMultiple(
    `DELETE FROM finding_stage_events; DELETE FROM findings;
     DELETE FROM finding_prefixes; DELETE FROM finding_measurements;
     DELETE FROM ai_matches; DELETE FROM ai_observations; DELETE FROM ai_prompts;
     DELETE FROM ai_trackers; DELETE FROM rank_snapshots;
     DELETE FROM rank_check_runs;`,
  );
}

/** Search Console connected, but with nothing to say: a source with no data is
 *  recorded as "data missing" without failing anything. */
export function mockConnectedEmptyProviders() {
  providerMocks.getByProjectId.mockResolvedValue({
    siteUrl: "sc-domain:example.com",
    connectedByUserId: "user_1",
    gscAccountId: "acct_1",
    connectedAccountEmail: "owner@example.com",
  });
  providerMocks.querySearchAnalytics.mockResolvedValue([]);
  providerMocks.inspectUrl.mockResolvedValue({});
}

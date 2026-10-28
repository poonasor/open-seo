import { resolveDateRange } from "@/server/features/gsc/searchAnalytics";
import { GscService } from "@/server/features/gsc/services/GscService";
import { RULES_VERSION } from "@/server/features/findings/findingsDomain";
import { FindingsRepository } from "@/server/features/findings/repositories/FindingsRepository";

// The baseline freezes everything free we can say about a finding's page the
// moment it goes live, so the re-measure has numbers to move against: Search
// Console performance and inspection for the page, plus what the rank tracker
// and the AI-visibility tracker already have stored. Nothing here starts a run
// or calls a paid API, and a source that is absent records "data missing"
// rather than blocking the stage move.

const DATA_MISSING = "data missing";

// Search Console rows come back click-sorted; keep the measurement row small.
const TOP_QUERIES = 10;

type BaselineTopQuery = {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

type BaselineMetrics = {
  searchConsole:
    | {
        clicks: number;
        impressions: number;
        ctr: number;
        position: number;
        topQueries: BaselineTopQuery[];
      }
    | typeof DATA_MISSING;
  urlInspection:
    | {
        indexState: string | null;
        lastCrawl: string | null;
        googleCanonical: string | null;
      }
    | typeof DATA_MISSING;
  // One row per target keyword (the Search Console top queries for the page);
  // `tracked: false` is the "not tracked" case. A null position is a real
  // result: checked, but not found within the tracked depth.
  rankTracking:
    | Array<{
        keyword: string;
        tracked: boolean;
        desktop: number | null;
        mobile: number | null;
        checkedAt: string | null;
      }>
    | typeof DATA_MISSING;
  // One row per tracked prompt matching a target keyword: the latest stored
  // answer per engine, and whether it mentions and cites the site.
  aiVisibility:
    | Array<{
        prompt: string;
        engine: string;
        mentioned: boolean;
        cited: boolean;
        collectedAt: string | null;
      }>
    | typeof DATA_MISSING;
};

type BaselineFinding = {
  id: string;
  targetPage: string | null;
};

type RankSnapshot = Awaited<
  ReturnType<typeof FindingsRepository.latestRankSnapshotsForKeywords>
>[number];

/** The target keywords of a finding are the queries its page currently shows
 *  for — the only keyword set the free reads can produce on their own. */
async function searchConsoleSection(
  projectId: string,
  targetPage: string | null,
): Promise<BaselineMetrics["searchConsole"]> {
  if (!targetPage) return DATA_MISSING;
  try {
    const { rows } = await GscService.getPerformance({
      projectId,
      dimensions: ["query"],
      dateRange: "last_28_days",
      filters: [
        { dimension: "page", operator: "equals", expression: targetPage },
      ],
      rowLimit: 1000,
    });
    const queries: BaselineTopQuery[] = rows.flatMap((row) => {
      const query = row.keys?.[0];
      // Anonymous queries have no key and cannot be tracked or re-measured.
      if (!query) return [];
      return [
        {
          query,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
        },
      ];
    });
    const impressions = queries.reduce((sum, q) => sum + q.impressions, 0);
    const clicks = queries.reduce((sum, q) => sum + q.clicks, 0);
    return {
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      // Impression-weighted, because a query seen twice matters twice.
      position:
        impressions > 0
          ? queries.reduce((sum, q) => sum + q.position * q.impressions, 0) /
            impressions
          : 0,
      topQueries: queries.slice(0, TOP_QUERIES),
    };
  } catch (error) {
    return missing("Search Console performance", error);
  }
}

async function urlInspectionSection(
  projectId: string,
  targetPage: string | null,
): Promise<BaselineMetrics["urlInspection"]> {
  if (!targetPage) return DATA_MISSING;
  try {
    const { results } = await GscService.inspectUrls({
      projectId,
      urls: [targetPage],
    });
    const inspection = results[0]?.result?.indexStatusResult;
    if (!inspection || results[0]?.error) return DATA_MISSING;
    return {
      indexState: inspection.coverageState ?? inspection.verdict ?? null,
      lastCrawl: inspection.lastCrawlTime ?? null,
      googleCanonical: inspection.googleCanonical ?? null,
    };
  } catch (error) {
    return missing("URL inspection", error);
  }
}

async function rankTrackingSection(
  projectId: string,
  topQueries: BaselineTopQuery[],
): Promise<BaselineMetrics["rankTracking"]> {
  if (topQueries.length === 0) return DATA_MISSING;
  try {
    const snapshots = await FindingsRepository.latestRankSnapshotsForKeywords(
      projectId,
      topQueries.map((q) => q.query),
    );
    // One latest position per keyword per device. A tie (two configs, same
    // instant) lets the later row win; SQL row order is unspecified, so either
    // snapshot is as good as the other.
    const latest = new Map<string, Map<string, RankSnapshot>>();
    for (const snapshot of snapshots) {
      const devices =
        latest.get(snapshot.keyword) ?? new Map<string, RankSnapshot>();
      const held = devices.get(snapshot.device);
      if (!held || snapshot.checkedAt >= held.checkedAt) {
        devices.set(snapshot.device, snapshot);
      }
      latest.set(snapshot.keyword, devices);
    }
    return topQueries.map(({ query }) => {
      const devices = latest.get(query.toLowerCase());
      const desktop = devices?.get("desktop");
      const mobile = devices?.get("mobile");
      const checked = [desktop, mobile].filter(
        (snapshot): snapshot is RankSnapshot => snapshot !== undefined,
      );
      return {
        keyword: query,
        tracked: checked.length > 0,
        desktop: desktop?.position ?? null,
        mobile: mobile?.position ?? null,
        checkedAt:
          checked.length > 0
            ? checked.reduce((newest, s) =>
                s.checkedAt > newest.checkedAt ? s : newest,
              ).checkedAt
            : null,
      };
    });
  } catch (error) {
    return missing("stored rank-tracker positions", error);
  }
}

async function aiVisibilitySection(
  projectId: string,
  topQueries: BaselineTopQuery[],
): Promise<BaselineMetrics["aiVisibility"]> {
  if (topQueries.length === 0) return DATA_MISSING;
  try {
    const answers =
      await FindingsRepository.latestAiVisibilityForTracker(projectId);
    const keywords = topQueries.map((q) => q.query.toLowerCase());
    // A prompt matches when it contains a target keyword: tracked prompts are
    // phrased around the queries the page is after.
    const matching = answers.filter((answer) =>
      keywords.some((keyword) => answer.prompt.toLowerCase().includes(keyword)),
    );
    if (matching.length === 0) return DATA_MISSING;
    return matching.map((answer) => ({
      prompt: answer.prompt,
      engine: answer.engine,
      mentioned: answer.mentioned === true,
      cited: answer.cited === true,
      collectedAt: answer.collectedAt,
    }));
  } catch (error) {
    return missing("stored AI-visibility answers", error);
  }
}

/** A missing source is recorded, not raised: it must never block the move. */
function missing(source: string, error: unknown): typeof DATA_MISSING {
  console.warn(`Finding baseline: ${source} unavailable`, error);
  return DATA_MISSING;
}

/**
 * Collects and stores the baseline measurement for a finding that has just
 * gone live. A source that fails records "data missing" instead of throwing;
 * only a broken database can still fail the write.
 */
export async function recordBaseline(
  projectId: string,
  finding: BaselineFinding,
): Promise<void> {
  const now = new Date().toISOString();
  const { startDate, endDate } = resolveDateRange({
    dateRange: "last_28_days",
  });
  const searchConsole = await searchConsoleSection(
    projectId,
    finding.targetPage,
  );
  const [urlInspection, rankTracking, aiVisibility] = await Promise.all([
    urlInspectionSection(projectId, finding.targetPage),
    rankTrackingSection(
      projectId,
      searchConsole === DATA_MISSING ? [] : searchConsole.topQueries,
    ),
    aiVisibilitySection(
      projectId,
      searchConsole === DATA_MISSING ? [] : searchConsole.topQueries,
    ),
  ]);

  const metrics: BaselineMetrics = {
    searchConsole,
    urlInspection,
    rankTracking,
    aiVisibility,
  };
  const sources = (
    [
      ["search_console_performance", searchConsole !== DATA_MISSING],
      ["url_inspection", urlInspection !== DATA_MISSING],
      ["rank_tracking_stored", rankTracking !== DATA_MISSING],
      ["ai_visibility_stored", aiVisibility !== DATA_MISSING],
    ] as const
  )
    .filter(([, present]) => present)
    .map(([tool]) => ({ tool, date: now }));

  await FindingsRepository.insertMeasurement({
    findingId: finding.id,
    kind: "baseline",
    rulesVersion: RULES_VERSION,
    windowStart: startDate,
    windowEnd: endDate,
    metrics: JSON.stringify(metrics),
    sources: JSON.stringify(sources),
  });
}

import { z } from "zod";
import { FindingsRepository } from "@/server/features/findings/repositories/FindingsRepository";
import { RULES_VERSION } from "@/server/features/findings/findingsDomain";
import {
  isIndexed,
  judge,
  remeasureWindows,
  type Verdict,
  type WindowTotals,
} from "@/server/features/findings/remeasureRules";
import {
  DATA_MISSING,
  aiVisibilitySection,
  queryPagePerformance,
  rankTrackingSection,
  urlInspectionSection,
} from "@/server/features/findings/services/baselineSnapshot";
import { GscNotConnectedError, GscTokenError } from "@/server/lib/gscErrors";

// Re-measure: once a Live finding's 28-day after window has closed, pull the
// same free reads the baseline used for the 28 days before and after it went
// live, compare, store the verdict and move the finding to Re-measured. No
// paid API is called, and nothing here starts a rank-tracker or AI run.

type RemeasureFinding = {
  id: string;
  projectId: string;
  targetPage: string | null;
  liveAt: string | null;
};

// What the baseline stored that the comparison needs; anything else in it is
// ignored, and an older or partial baseline just leaves these unknown.
const baselineSchema = z.object({
  urlInspection: z.union([
    z.object({ indexState: z.string().nullable() }),
    z.literal(DATA_MISSING),
  ]),
  rankTracking: z.union([
    z.array(
      z.object({
        keyword: z.string(),
        desktop: z.number().nullable(),
        mobile: z.number().nullable(),
      }),
    ),
    z.literal(DATA_MISSING),
  ]),
});

function round(value: number, places = 4) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function changeRatio(before: number, after: number) {
  return before > 0 ? round((after - before) / before) : null;
}

async function loadBaseline(findingId: string) {
  const rows = await FindingsRepository.listMeasurements(findingId);
  const baseline = rows.find(
    (m) => m.kind === "baseline" && m.rulesVersion === RULES_VERSION,
  );
  if (!baseline) return null;
  try {
    return baselineSchema.parse(JSON.parse(baseline.metrics));
  } catch {
    return null;
  }
}

const emptyTotals: WindowTotals = {
  clicks: 0,
  impressions: 0,
  ctr: 0,
  position: 0,
};

/** Search Console for one window. A page that cannot be read at all (no
 *  target page, no connection, a lost grant) is a verdict, not a retry; any
 *  other failure throws so the next tick tries again. */
async function readWindow(
  finding: RemeasureFinding,
  window: { startDate: string; endDate: string },
): Promise<{
  totals?: Awaited<ReturnType<typeof queryPagePerformance>>;
  error?: string;
}> {
  if (!finding.targetPage) return { error: "The finding has no target page." };
  try {
    return {
      totals: await queryPagePerformance(
        finding.projectId,
        finding.targetPage,
        window,
      ),
    };
  } catch (error) {
    if (error instanceof GscNotConnectedError) {
      return { error: "Search Console is not connected for this project." };
    }
    if (error instanceof GscTokenError) {
      return { error: "Search Console access was lost." };
    }
    throw error;
  }
}

/** Runs the re-measure for a live finding whose windows are complete. Returns
 *  false when nothing was recorded: windows still open, or the guarded move
 *  matched no row because another run got there first. */
export async function recordRemeasure(
  finding: RemeasureFinding,
  actor: string,
) {
  if (!finding.liveAt) return false;
  const windows = remeasureWindows(finding.liveAt, new Date());
  if (!windows.complete) return false;

  const [before, after, baseline] = await Promise.all([
    readWindow(finding, windows.before),
    readWindow(finding, windows.after),
    loadBaseline(finding.id),
  ]);
  const unreadable = before.error ?? after.error;

  const afterTotals = after.totals ?? null;
  const topQueries = afterTotals?.topQueries ?? [];
  const [urlInspection, rankTracking, aiVisibility] = await Promise.all([
    urlInspectionSection(finding.projectId, finding.targetPage),
    rankTrackingSection(finding.projectId, topQueries),
    aiVisibilitySection(finding.projectId, topQueries),
  ]);

  const beforeTotals = before.totals ?? emptyTotals;
  const afterOrEmpty = afterTotals ?? emptyTotals;
  const beforeIndexState =
    baseline && baseline.urlInspection !== DATA_MISSING
      ? baseline.urlInspection.indexState
      : null;
  const afterIndexState =
    urlInspection === DATA_MISSING ? null : urlInspection.indexState;

  const result: { verdict: Verdict; reason: string } = unreadable
    ? { verdict: "data_too_thin", reason: unreadable }
    : judge({
        before: beforeTotals,
        after: afterOrEmpty,
        beforeIndexed: isIndexed(beforeIndexState),
        afterIndexed: isIndexed(afterIndexState),
      });

  // Tracked positions: the baseline's stored position per keyword against the
  // latest stored one for the same keyword.
  const trackedPositions =
    baseline && baseline.rankTracking !== DATA_MISSING
      ? baseline.rankTracking.map((row) => {
          const latest =
            rankTracking === DATA_MISSING
              ? undefined
              : rankTracking.find((r) => r.keyword === row.keyword);
          return {
            keyword: row.keyword,
            desktop: { before: row.desktop, after: latest?.desktop ?? null },
            mobile: { before: row.mobile, after: latest?.mobile ?? null },
          };
        })
      : [];

  const deltas = {
    clicks: {
      before: beforeTotals.clicks,
      after: afterOrEmpty.clicks,
      change: afterOrEmpty.clicks - beforeTotals.clicks,
      changeRatio: changeRatio(beforeTotals.clicks, afterOrEmpty.clicks),
    },
    impressions: {
      before: beforeTotals.impressions,
      after: afterOrEmpty.impressions,
      change: afterOrEmpty.impressions - beforeTotals.impressions,
      changeRatio: changeRatio(
        beforeTotals.impressions,
        afterOrEmpty.impressions,
      ),
    },
    ctr: {
      before: round(beforeTotals.ctr),
      after: round(afterOrEmpty.ctr),
      change: round(afterOrEmpty.ctr - beforeTotals.ctr),
    },
    // Positive = moved up the results.
    position: {
      before: round(beforeTotals.position, 2),
      after: round(afterOrEmpty.position, 2),
      placesGained: round(beforeTotals.position - afterOrEmpty.position, 2),
    },
    indexState: { before: beforeIndexState, after: afterIndexState },
    trackedPositions,
    reason: result.reason,
  };

  const now = new Date().toISOString();
  const sources = (
    [
      ["search_console_performance", !unreadable],
      ["url_inspection", urlInspection !== DATA_MISSING],
      ["rank_tracking_stored", rankTracking !== DATA_MISSING],
      ["ai_visibility_stored", aiVisibility !== DATA_MISSING],
    ] as const
  )
    .filter(([, present]) => present)
    .map(([tool]) => ({ tool, date: now }));

  return FindingsRepository.moveStage({
    projectId: finding.projectId,
    id: finding.id,
    from: "live",
    to: "re_measured",
    actor,
    note: `Verdict ${result.verdict}: ${result.reason}`,
    remeasure: {
      verdict: result.verdict,
      measurement: {
        findingId: finding.id,
        kind: "remeasure",
        rulesVersion: RULES_VERSION,
        windowStart: windows.before.startDate,
        windowEnd: windows.after.endDate,
        metrics: JSON.stringify({
          windows: { before: windows.before, after: windows.after },
          before: { searchConsole: before.totals ?? DATA_MISSING },
          after: {
            searchConsole: afterTotals ?? DATA_MISSING,
            urlInspection,
            rankTracking,
            aiVisibility,
          },
        }),
        deltas: JSON.stringify(deltas),
        verdict: result.verdict,
        sources: JSON.stringify(sources),
      },
    },
  });
}

// A tick handles a few findings: each makes up to six free reads.
const BATCH_SIZE = 5;

/** The five-minute cron's re-measure pass. A finding that fails is logged and
 *  retried next tick without holding up the rest of the batch. */
export async function runScheduledRemeasures() {
  const due = await FindingsRepository.listDueForRemeasure(
    new Date().toISOString(),
    RULES_VERSION,
    BATCH_SIZE,
  );
  for (const finding of due) {
    try {
      await recordRemeasure(finding, "system:remeasure");
    } catch (error) {
      console.error(`[cron] Re-measure of ${finding.id} failed:`, error);
    }
  }
}

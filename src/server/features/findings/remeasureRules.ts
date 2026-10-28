// Pure rules for the re-measure: which windows to compare and how the numbers
// become a verdict. Change a threshold or what is compared and RULES_VERSION
// (findingsDomain.ts) must move with it.

const WINDOW_DAYS = 28;
// Search Console data is final about three days behind.
const GSC_LAG_DAYS = 3;
// Under this many impressions in either window there is no signal to read.
const MIN_IMPRESSIONS = 100;
// A clicks change only counts against a base of at least this many clicks.
const MIN_CLICKS_BASE = 10;
// Relative clicks/impressions change that counts as a move.
const CHANGE_RATIO = 0.2;
// Average position change, in places, that counts as a move.
const POSITION_STEP = 2;

const DAY_MS = 86_400_000;

const dateString = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Explicit start/end dates (UTC, inclusive) for the 28 days before and after
 * the day a finding went live. The live day itself sits in neither window, as
 * it is half before and half after. Returns null until the after window has
 * ended at least three days ago.
 */
export function remeasureWindows(liveAt: string, now: Date) {
  const liveDay = Date.parse(dateString(Date.parse(liveAt)));
  const windows = {
    before: {
      startDate: dateString(liveDay - WINDOW_DAYS * DAY_MS),
      endDate: dateString(liveDay - DAY_MS),
    },
    after: {
      startDate: dateString(liveDay + DAY_MS),
      endDate: dateString(liveDay + WINDOW_DAYS * DAY_MS),
    },
  };
  const latestUsable = dateString(now.getTime() - GSC_LAG_DAYS * DAY_MS);
  return {
    ...windows,
    complete: windows.after.endDate <= latestUsable,
    // First day the after window counts as complete.
    readyOn: dateString(
      Date.parse(windows.after.endDate) + GSC_LAG_DAYS * DAY_MS,
    ),
  };
}

export type WindowTotals = {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

/** Treats only Google's own "indexed" states as indexed; "Crawled - currently
 *  not indexed" and "Not indexed" contain the word but are not. */
export function isIndexed(indexState: string | null) {
  if (indexState === null) return null;
  const state = indexState.toLowerCase();
  return (
    state.startsWith("indexed") ||
    state.startsWith("submitted and indexed") ||
    state === "pass"
  );
}

export type Verdict = "moved" | "flat" | "worse" | "data_too_thin";

function relativeChange(before: number, after: number) {
  return (after - before) / before;
}

export function judge(input: {
  before: WindowTotals;
  after: WindowTotals;
  // null = unknown (no inspection stored); only a known "not indexed" counts.
  beforeIndexed: boolean | null;
  afterIndexed: boolean | null;
}): { verdict: Verdict; reason: string } {
  const { before, after } = input;
  if (input.afterIndexed === false || input.beforeIndexed === false) {
    return {
      verdict: "data_too_thin",
      reason: `Page was not indexed for most of the ${input.afterIndexed === false ? "after" : "before"} window.`,
    };
  }
  if (
    before.impressions < MIN_IMPRESSIONS ||
    after.impressions < MIN_IMPRESSIONS
  ) {
    return {
      verdict: "data_too_thin",
      reason: `Under ${MIN_IMPRESSIONS} impressions in a window (${before.impressions} before, ${after.impressions} after).`,
    };
  }

  const impressions = relativeChange(before.impressions, after.impressions);
  const clicks =
    before.clicks >= MIN_CLICKS_BASE
      ? relativeChange(before.clicks, after.clicks)
      : 0;
  // Lower position is better; positive = moved up.
  const places = before.position - after.position;

  const up =
    places >= POSITION_STEP ||
    clicks >= CHANGE_RATIO ||
    impressions >= CHANGE_RATIO;
  const down =
    places <= -POSITION_STEP ||
    clicks <= -CHANGE_RATIO ||
    impressions <= -CHANGE_RATIO;
  if (up && !down) return { verdict: "moved", reason: "Improved." };
  if (down && !up) return { verdict: "worse", reason: "Declined." };
  return {
    verdict: "flat",
    reason: up
      ? "Signals pointed both ways."
      : "No change past the thresholds.",
  };
}

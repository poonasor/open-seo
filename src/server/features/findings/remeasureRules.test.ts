import { describe, expect, it } from "vitest";
import {
  isIndexed,
  judge,
  remeasureWindows,
  type WindowTotals,
} from "./remeasureRules";

const totals = (overrides: Partial<WindowTotals> = {}): WindowTotals => ({
  clicks: 50,
  impressions: 1000,
  ctr: 0.05,
  position: 8,
  ...overrides,
});

const verdictOf = (
  after: Partial<WindowTotals>,
  before: Partial<WindowTotals> = {},
  indexed: { before?: boolean | null; after?: boolean | null } = {},
) =>
  judge({
    before: totals(before),
    after: totals(after),
    beforeIndexed: indexed.before ?? true,
    afterIndexed: indexed.after ?? true,
  }).verdict;

describe("remeasureWindows", () => {
  it("uses explicit 28-day windows either side of the live day", () => {
    const w = remeasureWindows(
      "2026-09-01T15:30:00.000Z",
      new Date("2026-10-31T00:00:00Z"),
    );
    expect(w.before).toEqual({
      startDate: "2026-08-04",
      endDate: "2026-08-31",
    });
    expect(w.after).toEqual({
      startDate: "2026-09-02",
      endDate: "2026-09-29",
    });
  });

  it("is complete only once the after window ended 3 or more days ago", () => {
    const liveAt = "2026-09-01T00:00:00.000Z";
    expect(
      remeasureWindows(liveAt, new Date("2026-10-01T23:59:00Z")).complete,
    ).toBe(false);
    const ready = remeasureWindows(liveAt, new Date("2026-10-02T00:00:00Z"));
    expect(ready.complete).toBe(true);
    expect(ready.readyOn).toBe("2026-10-02");
  });
});

describe("judge", () => {
  it("moved: position up 2 places", () => {
    expect(verdictOf({ position: 6 })).toBe("moved");
  });

  it("moved: clicks or impressions up 20%", () => {
    expect(verdictOf({ clicks: 60 })).toBe("moved");
    expect(verdictOf({ impressions: 1200 })).toBe("moved");
  });

  it("worse: the same thresholds, declining", () => {
    expect(verdictOf({ position: 10 })).toBe("worse");
    expect(verdictOf({ clicks: 40 })).toBe("worse");
    expect(verdictOf({ impressions: 800 })).toBe("worse");
  });

  it("flat: inside the thresholds, or signals that cancel out", () => {
    expect(verdictOf({ clicks: 55, position: 7 })).toBe("flat");
    expect(verdictOf({ position: 6, impressions: 700 })).toBe("flat");
  });

  it("ignores a clicks change on a trivial base", () => {
    expect(verdictOf({ clicks: 9 }, { clicks: 5 })).toBe("flat");
  });

  it("data too thin: under 100 impressions in either window", () => {
    expect(verdictOf({ impressions: 99 })).toBe("data_too_thin");
    expect(verdictOf({}, { impressions: 99 })).toBe("data_too_thin");
  });

  it("data too thin: not indexed in a window; an unknown state does not count", () => {
    expect(verdictOf({}, {}, { after: false })).toBe("data_too_thin");
    expect(verdictOf({}, {}, { before: false })).toBe("data_too_thin");
    expect(verdictOf({ position: 6 }, {}, { after: null })).toBe("moved");
  });
});

describe("isIndexed", () => {
  it("reads Google's states, not the word 'indexed' inside a negative", () => {
    expect(isIndexed("Submitted and indexed")).toBe(true);
    expect(isIndexed("Indexed, not submitted in sitemap")).toBe(true);
    expect(isIndexed("Crawled - currently not indexed")).toBe(false);
    expect(isIndexed("Not indexed")).toBe(false);
    expect(isIndexed(null)).toBeNull();
  });
});

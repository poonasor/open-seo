import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { expect, it, vi } from "vitest";
import { FindingDetailView } from "./FindingDetailView";
import { manualNextStages } from "./findingsFormat";

type Detail = Parameters<typeof FindingDetailView>[0]["detail"];

const detail: Detail = {
  finding: {
    id: "PM-F001",
    projectId: "p1",
    prefix: "PM",
    number: 1,
    site: "example.com",
    stage: "re_measured",
    finding: "Pricing page has no FAQ",
    targetPage: "https://example.com/pricing",
    evidence: null,
    routeStatus: null,
    vikunjaTaskId: "42",
    vikunjaTaskUrl: "https://tasks.example.com/tasks/42",
    liveAt: null,
    remeasureDueAt: null,
    verdict: "moved",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  },
  events: [
    {
      id: "e1",
      findingId: "PM-F001",
      fromStage: "live",
      toStage: "re_measured",
      actor: "system:remeasure",
      note: null,
      at: "2026-10-27T00:00:00.000Z",
    },
  ],
  measurements: [
    {
      id: "m1",
      findingId: "PM-F001",
      kind: "baseline",
      rulesVersion: "1",
      windowStart: "2026-09-01",
      windowEnd: "2026-09-28",
      verdict: null,
      metrics: {
        searchConsole: { clicks: 10, impressions: 100, ctr: 0.1, position: 8 },
      },
      deltas: null,
      sources: [],
      measuredAt: "2026-09-29T00:00:00.000Z",
    },
    {
      id: "m2",
      findingId: "PM-F001",
      kind: "remeasure",
      rulesVersion: "1",
      windowStart: "2026-09-01",
      windowEnd: "2026-10-27",
      verdict: "moved",
      metrics: {},
      deltas: {
        clicks: { before: 10, after: 25, change: 15 },
        impressions: { before: 100, after: 200, change: 100 },
        ctr: { before: 0.1, after: 0.125, change: 0.025 },
        position: { before: 8, after: 5, placesGained: 3 },
        indexState: { before: "Indexed", after: "Indexed" },
        reason: "Clicks rose 150%",
      },
      sources: [],
      measuredAt: "2026-10-27T00:00:00.000Z",
    },
  ],
};

it("shows baseline, re-measure deltas, history and the task link", () => {
  const $ = load(
    renderToStaticMarkup(
      createElement(FindingDetailView, {
        detail,
        pending: false,
        onMove: vi.fn(),
        onRemeasure: vi.fn(),
      }),
    ),
  );
  expect($("a[href='https://tasks.example.com/tasks/42']").length).toBe(1);
  expect($("tr:contains('Clicks')").text()).toContain("+15");
  expect($("tr:contains('Avg position')").text()).toContain("+3 places");
  expect($.text()).toContain("Clicks rose 150%");
  expect($("li:contains('system:remeasure')").text()).toContain(
    "Live → Re-measured",
  );
  // Nothing follows Re-measured, so there is no move control.
  expect($("button").length).toBe(0);
});

it("offers only the transitions the lifecycle allows", () => {
  expect(manualNextStages("finding")).toEqual(["brief", "spec"]);
  expect(manualNextStages("live")).toEqual([]);
  expect(manualNextStages("filed")).toEqual(["live"]);
});

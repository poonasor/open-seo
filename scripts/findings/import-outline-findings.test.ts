import { describe, expect, it } from "vitest";
import {
  parseFindingsMarkdown,
  planImport,
} from "./import-outline-findings.mjs";

const FIXTURE = `
# Findings

| ID | Site | Stage | Finding | Target page | OpenSEO evidence | Route/Status | Vikunja task |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PM-F001 | perpetualmedia.ca | Finding | Title too long | https://perpetualmedia.ca/seo | 12 impressions | Fix in CMS | https://tasks.example.com/tasks/42 |
| PM-F002 | perpetualmedia.ca | Re-measured | Needs a page | — | — | Filed | #7 |
| PM-F003 | perpetualmedia.ca | Shipped | Unknown stage | | | | |
| bogus | x | Finding | Not an id | | | | |
`;

describe("parseFindingsMarkdown", () => {
  const { rows, problems } = parseFindingsMarkdown(FIXTURE);

  it("maps stages, blanks and Vikunja cells", () => {
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      id: "PM-F002",
      stage: "re_measured",
      targetPage: null,
      vikunja: { id: "7", url: null },
    });
    expect(rows[0]?.vikunja).toEqual({
      id: "42",
      url: "https://tasks.example.com/tasks/42",
    });
  });

  it("reports rows it cannot import", () => {
    expect(problems).toHaveLength(2);
  });
});

describe("planImport", () => {
  const { rows } = parseFindingsMarkdown(FIXTURE);

  it("skips existing ids and reports differences", () => {
    const stored = new Map([["PM-F001", { ...rows[0], evidence: "changed" }]]);
    const plan = planImport(rows, stored, new Set(["PM"]));
    expect(plan.skip).toEqual(["PM-F001"]);
    expect(plan.differences).toEqual([
      {
        id: "PM-F001",
        field: "evidence",
        outline: "12 impressions",
        openseo: "changed",
      },
    ]);
    expect(plan.create.map((r) => r.id)).toEqual(["PM-F002"]);
    expect(plan.prefixes).toEqual([]);
  });

  it("plans the prefix row once and warns about live imports", () => {
    const plan = planImport(rows, new Map(), new Set());
    expect(plan.prefixes).toEqual([
      { prefix: "PM", site: "perpetualmedia.ca" },
    ]);
    expect(plan.warnings.some((w) => w.includes("PM-F002"))).toBe(true);
  });
});

import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { expect, test, type Page } from "@playwright/test";

/**
 * Findings lifecycle in the browser. Findings are created through MCP tools,
 * which this unauthenticated dev server does not expose, so the spec seeds
 * rows straight into the local D1 file instead. The numbers on screen come
 * from seeded measurements; no provider is called (the project has no Search
 * Console connection, so the move to Live stores a "data missing" baseline).
 *
 * Prerequisite: the local D1 database is migrated (pnpm db:migrate:local).
 */

const D1_DIR = fileURLToPath(
  new URL(
    "../.wrangler/state/v3/d1/miniflare-D1DatabaseObject",
    import.meta.url,
  ),
);

// Prefixes are 2-10 uppercase letters or digits; the local database outlives
// runs, so the prefix is run-unique.
const PREFIX = `E${randomBytes(3).toString("hex").toUpperCase()}`;
const WALKED = `${PREFIX}-F001`;
const MEASURED = `${PREFIX}-F002`;

async function getProjectId(page: Page) {
  await page.goto("/");
  await page.waitForURL(/\/p\/([^/]+)\/?$/, { timeout: 30_000 });
  const match = page.url().match(/\/p\/([^/]+)/);
  if (!match) throw new Error(`Could not read project id from ${page.url()}`);
  return match[1];
}

const created = (findingId: string) => ({
  sql: `INSERT INTO finding_stage_events (id, finding_id, from_stage, to_stage, actor, at)
        VALUES (?, ?, NULL, 'finding', 'e2e', '2026-07-01T00:00:00.000Z')`,
  args: [`${findingId}-created`, findingId],
});

async function seedFindings(projectId: string) {
  const file = readdirSync(D1_DIR).find(
    (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
  );
  if (!file) throw new Error(`No local D1 database in ${D1_DIR}`);
  const client = createClient({ url: `file:${path.join(D1_DIR, file)}` });
  try {
    const finding = (
      number: number,
      fields: { stage: string; text: string; verdict?: string },
    ) => ({
      sql: `INSERT INTO findings (id, project_id, prefix, number, site, stage, finding, target_page, live_at, remeasure_due_at, verdict)
            VALUES (?, ?, ?, ?, 'example.com', ?, ?, 'https://example.com/pricing', ?, ?, ?)`,
      args: [
        `${PREFIX}-F00${number}`,
        projectId,
        PREFIX,
        number,
        fields.stage,
        fields.text,
        fields.stage === "re_measured" ? "2026-08-01T00:00:00.000Z" : null,
        fields.stage === "re_measured" ? "2026-09-01T00:00:00.000Z" : null,
        fields.verdict ?? null,
      ],
    });
    const measurement = (
      kind: "baseline" | "remeasure",
      fields: { windowEnd: string; metrics: object; deltas?: object },
    ) => ({
      sql: `INSERT INTO finding_measurements (id, finding_id, kind, rules_version, window_start, window_end, metrics, deltas, verdict, sources)
            VALUES (?, ?, ?, '1', '2026-07-04', ?, ?, ?, ?, '[]')`,
      args: [
        `${PREFIX}-${kind}`,
        MEASURED,
        kind,
        fields.windowEnd,
        JSON.stringify(fields.metrics),
        fields.deltas ? JSON.stringify(fields.deltas) : null,
        kind === "remeasure" ? "moved" : null,
      ],
    });
    await client.batch(
      [
        finding(1, { stage: "finding", text: "Pricing page has no FAQ" }),
        created(WALKED),
        finding(2, {
          stage: "re_measured",
          text: "Pricing title is missing the product name",
          verdict: "moved",
        }),
        created(MEASURED),
        measurement("baseline", {
          windowEnd: "2026-07-31",
          metrics: {
            searchConsole: {
              clicks: 120,
              impressions: 4000,
              ctr: 0.03,
              position: 8.4,
            },
          },
        }),
        measurement("remeasure", {
          windowEnd: "2026-08-28",
          metrics: {},
          deltas: {
            clicks: { before: 120, after: 180, change: 60 },
            impressions: { before: 4000, after: 4500, change: 500 },
            ctr: { before: 0.03, after: 0.04, change: 0.01 },
            position: { before: 8.4, after: 6.1, placesGained: 2.3 },
            indexState: { before: "Indexed", after: "Indexed" },
          },
        }),
      ],
      "write",
    );
  } finally {
    client.close();
  }
}

test("a finding moves through every stage, and a measured one shows its baseline and verdict", async ({
  page,
}) => {
  // Without a DataForSEO key the app opens a setup dialog over any page, and
  // it can appear after the page is interactive.
  await page.addLocatorHandler(
    page.getByRole("button", { name: "Dismiss" }),
    (dismiss) => dismiss.click(),
  );
  const projectId = await getProjectId(page);
  await seedFindings(projectId);

  await test.step("the board lists both findings by stage", async () => {
    await page.goto(`/p/${projectId}/findings`);
    await expect(page.getByRole("link", { name: WALKED })).toBeVisible();
    await expect(page.getByRole("link", { name: MEASURED })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^Re-measured \(\d+\)$/ }),
    ).toBeVisible();
  });

  await test.step("move the new finding to Live, one stage at a time", async () => {
    await page.getByRole("link", { name: WALKED }).click();
    for (const stage of ["Brief", "Draft", "Spec", "Filed", "Live"]) {
      await page.getByRole("button", { name: `Move to ${stage}` }).click();
      await expect(
        page.getByText(new RegExp(`→ ${stage}\\s+by user:`)),
      ).toBeVisible();
    }
    await expect(page.getByText("Live at")).toBeVisible();
    await expect(page.getByText("Re-measure due")).toBeVisible();
    // No Search Console connection: the baseline is stored as missing.
    await expect(
      page.getByText("Search Console data was missing"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Re-measure" }),
    ).toBeVisible();
  });

  await test.step("the Live finding now sits in the Live column of the board", async () => {
    await page.goto(`/p/${projectId}/findings`);
    await expect(page.getByRole("link", { name: WALKED })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^Live \(\d+\)$/ }),
    ).toBeVisible();
  });

  await test.step("the measured finding shows its seeded baseline and verdict", async () => {
    await page.getByRole("link", { name: MEASURED }).click();
    await expect(
      page.getByText("Baseline (28 days before going live)"),
    ).toBeVisible();
    // The baseline card shows the seeded totals; the re-measure table repeats
    // them as "before", so match the card's definition list only.
    await expect(
      page.getByRole("definition").filter({ hasText: /^4000$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("definition").filter({ hasText: /^8\.4$/ }),
    ).toBeVisible();
    await expect(page.getByText("Moved").first()).toBeVisible();
    await expect(page.getByRole("cell", { name: "+60" })).toBeVisible();
    await expect(page.getByText("Lifecycle complete.")).toBeVisible();
  });
});

/**
 * Import the Findings docs from Outline (Marketing collection) into OpenSEO.
 * Dry run by default: nothing is written unless --apply is passed.
 *
 * Source (one of):
 *   --file <path.md>          an exported markdown file
 *   OUTLINE_API_URL + OUTLINE_API_TOKEN (env)
 *                             read-only: collections.list + documents.list
 *
 * Existing OpenSEO findings (read via list_findings) are skipped and any
 * differences are reported. That read and --apply need OPENSEO_MCP_URL,
 * OPENSEO_API_KEY (env) and --project <projectId>; without them the dry run
 * plans against an empty project.
 *
 * Usage:
 *   node scripts/findings/import-outline-findings.mjs --file findings.md
 *   node scripts/findings/import-outline-findings.mjs --project <id> --apply
 *
 * Table columns:
 *   ID | Site | Stage | Finding | Target page | OpenSEO evidence | Route/Status | Vikunja task
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const STAGES = [
  "finding",
  "brief",
  "draft",
  "spec",
  "filed",
  "live",
  "re_measured",
];
const ID_PATTERN = /^([A-Z][A-Z0-9]{1,9})-F(\d{3,6})$/;
const EMPTY_CELLS = new Set(["", "-", "—", "–", "n/a", "na", "none", "tbd"]);
const DIFF_FIELDS = [
  "stage",
  "finding",
  "targetPage",
  "evidence",
  "routeStatus",
];

/** @param {string} cell */
function clean(cell) {
  const text = cell
    .replace(/\\\|/g, "|")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, label, url) => label || url)
    .replace(/[*_`]/g, "")
    .trim();
  return EMPTY_CELLS.has(text.toLowerCase()) ? null : text;
}

/** @param {string} line */
function splitRow(line) {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** "Re-measured" -> "re_measured"; null when it is not a lifecycle stage. */
export function mapStage(name) {
  const stage = name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return STAGES.includes(stage) ? stage : null;
}

/** A Vikunja cell is a task URL (.../tasks/123), "#123" or a bare number. */
export function parseVikunjaTask(cell) {
  if (!cell) return null;
  const url = /https?:\/\/\S+/.exec(cell)?.[0] ?? null;
  const id = /(\d+)\s*$/.exec(url ?? cell)?.[1];
  return id ? { id, url } : null;
}

/**
 * Parses every findings table in a markdown string. Returns the rows and the
 * lines it could not use, so a bad row is reported instead of dropped.
 * @param {string} markdown
 */
export function parseFindingsMarkdown(markdown) {
  /** @type {any[]} */
  const rows = [];
  /** @type {string[]} */
  const problems = [];
  let columns = null;
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    if (!line.trim().startsWith("|")) {
      columns = null;
      continue;
    }
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    const lower = cells.map((c) => c.toLowerCase());
    if (lower[0] === "id" && lower.includes("finding")) {
      columns = Object.fromEntries(lower.map((name, i) => [name, i]));
      continue;
    }
    if (!columns) continue;
    const get = (name) => cells[columns[name]] ?? "";
    const lineNo = index + 1;
    const id = clean(get("id"));
    const match = id ? ID_PATTERN.exec(id) : null;
    if (!id || !match) {
      problems.push(`line ${lineNo}: "${id ?? ""}" is not a finding id`);
      continue;
    }
    const stage = mapStage(get("stage"));
    const finding = clean(get("finding"));
    const site = clean(get("site"));
    if (!stage || !finding || !site) {
      problems.push(
        `line ${lineNo}: ${id} needs a known stage, site and finding text`,
      );
      continue;
    }
    rows.push({
      id,
      prefix: match[1],
      site,
      stage,
      finding,
      targetPage: clean(get("target page")),
      evidence: clean(get("openseo evidence")),
      routeStatus: clean(get("route/status")),
      vikunja: parseVikunjaTask(get("vikunja task")),
    });
  }
  return { rows, problems };
}

/**
 * @param {ReturnType<typeof parseFindingsMarkdown>["rows"]} rows
 * @param {Map<string, Record<string, unknown>>} existing  id -> stored finding
 * @param {Set<string>} knownPrefixes
 */
export function planImport(rows, existing, knownPrefixes) {
  /**
   * @type {{
   *   prefixes: { prefix: string, site: string }[],
   *   create: any[],
   *   skip: string[],
   *   differences: { id: string, field: string, outline: unknown, openseo: unknown }[],
   *   warnings: string[],
   * }}
   */
  const plan = {
    prefixes: [],
    create: [],
    skip: [],
    differences: [],
    warnings: [],
  };
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) {
      plan.warnings.push(
        `${row.id} appears twice in the source; using the first`,
      );
      continue;
    }
    seen.add(row.id);
    const stored = existing.get(row.id);
    if (stored) {
      plan.skip.push(row.id);
      for (const field of DIFF_FIELDS) {
        const theirs = stored[field] ?? null;
        const ours = row[field] ?? null;
        if (theirs !== ours) {
          plan.differences.push({
            id: row.id,
            field,
            outline: ours,
            openseo: theirs,
          });
        }
      }
      continue;
    }
    if (
      !knownPrefixes.has(row.prefix) &&
      !plan.prefixes.some((p) => p.prefix === row.prefix)
    ) {
      plan.prefixes.push({ prefix: row.prefix, site: row.site });
    }
    if (row.stage === "live" || row.stage === "re_measured") {
      plan.warnings.push(
        `${row.id} is ${row.stage}: the source has no live date, so it is imported as live now`,
      );
    }
    plan.create.push(row);
  }
  return plan;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

/** Read-only Outline reads: every doc titled "Findings" in the collection. */
async function fetchOutlineMarkdown(collectionName) {
  const base = requiredEnv("OUTLINE_API_URL").replace(/\/$/, "");
  const token = requiredEnv("OUTLINE_API_TOKEN");
  const post = async (path, body) => {
    const response = await fetch(`${base}/api/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Outline ${path} failed: ${response.status}`);
    }
    return (await response.json()).data;
  };
  const collections = await post("collections.list", { limit: 100 });
  const collection = collections.find((c) => c.name === collectionName);
  if (!collection) {
    throw new Error(`Outline collection "${collectionName}" not found`);
  }
  const docs = [];
  for (let offset = 0; ; offset += 100) {
    const page = await post("documents.list", {
      collectionId: collection.id,
      limit: 100,
      offset,
    });
    docs.push(...page);
    if (page.length < 100) break;
  }
  return docs
    .filter((d) => /findings/i.test(d.title))
    .map((d) => d.text)
    .join("\n\n");
}

async function connectOpenSeo() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({
    name: "import-outline-findings",
    version: "1.0.0",
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(requiredEnv("OPENSEO_MCP_URL")), {
      requestInit: {
        headers: { Authorization: `Bearer ${requiredEnv("OPENSEO_API_KEY")}` },
      },
    }),
  );
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
    }
    return result.structuredContent;
  };
  return { call, close: () => client.close() };
}

function parseCli(argv) {
  const options = {
    apply: false,
    file: null,
    project: null,
    collection: "Marketing",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--file") options.file = argv[++i];
    else if (arg === "--project") options.project = argv[++i];
    else if (arg === "--collection") options.collection = argv[++i];
    else throw new Error(`Unknown argument ${arg}`);
  }
  return options;
}

function report(plan, problems, apply) {
  const prefixes = plan.prefixes.map((p) => `${p.prefix} (${p.site})`);
  const lines = [
    apply ? "APPLY" : "DRY RUN (nothing written; pass --apply)",
    `Prefixes to create: ${prefixes.join(", ") || "none"}`,
    `Findings to create: ${plan.create.length}`,
    `Skipped, already exist: ${plan.skip.length}`,
  ];
  for (const d of plan.differences) {
    lines.push(
      `  differs ${d.id}.${d.field}: outline=${JSON.stringify(d.outline)} openseo=${JSON.stringify(d.openseo)}`,
    );
  }
  for (const text of [...problems, ...plan.warnings]) {
    lines.push(`  warning: ${text}`);
  }
  return lines.join("\n");
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const markdown = options.file
    ? readFileSync(options.file, "utf8")
    : await fetchOutlineMarkdown(options.collection);
  const { rows, problems } = parseFindingsMarkdown(markdown);

  const hasOpenSeo = Boolean(options.project && process.env.OPENSEO_MCP_URL);
  if (options.apply && !hasOpenSeo) {
    throw new Error(
      "--apply needs --project, OPENSEO_MCP_URL and OPENSEO_API_KEY.",
    );
  }
  const openseo = hasOpenSeo ? await connectOpenSeo() : null;
  try {
    const existing = new Map();
    if (openseo) {
      const { findings } = await openseo.call("list_findings", {
        projectId: options.project,
      });
      for (const f of findings) existing.set(f.id, f);
    }
    const knownPrefixes = new Set([...existing.values()].map((f) => f.prefix));
    const plan = planImport(rows, existing, knownPrefixes);
    console.log(report(plan, problems, options.apply));
    if (!options.apply || !openseo) return;

    for (const row of plan.create) {
      await openseo.call("create_finding", {
        projectId: options.project,
        id: row.id,
        site: row.site,
        stage: row.stage,
        finding: row.finding,
        targetPage: row.targetPage,
        evidence: row.evidence,
        routeStatus: row.routeStatus,
      });
      if (row.vikunja) {
        await openseo.call("update_finding", {
          projectId: options.project,
          id: row.id,
          vikunjaTaskId: row.vikunja.id,
          vikunjaTaskUrl: row.vikunja.url,
        });
      }
      console.log(`created ${row.id}`);
    }
  } finally {
    await openseo?.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

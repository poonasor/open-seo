import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./app.schema";

// ============================================================================
// Marketing findings: a numbered, staged ledger of what was found, shipped and
// re-measured. Ids read <prefix>-F<nnn> and are never reused.
// ============================================================================

// A prefix (e.g. "PM") belongs to one project and one site. `lastNumber` is the
// high-water mark of numbers ever issued under it, so a deleted finding's
// number is never handed out again.
export const findingPrefixes = sqliteTable(
  "finding_prefixes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    prefix: text("prefix").notNull(),
    site: text("site").notNull(),
    lastNumber: integer("last_number").notNull().default(0),
    // The Vikunja project whose tasks mirror this prefix's findings (read-only
    // sync); null = not mapped.
    vikunjaProjectId: text("vikunja_project_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    uniqueIndex("finding_prefixes_project_prefix_idx").on(
      table.projectId,
      table.prefix,
    ),
  ],
);

export const findings = sqliteTable(
  "findings",
  {
    // "<prefix>-F<nnn>"
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    prefix: text("prefix").notNull(),
    number: integer("number").notNull(),
    site: text("site").notNull(),
    stage: text("stage", {
      enum: [
        "finding",
        "brief",
        "draft",
        "spec",
        "filed",
        "live",
        "re_measured",
      ],
    })
      .notNull()
      .default("finding"),
    finding: text("finding").notNull(),
    // null = the finding is about a page that does not exist yet.
    targetPage: text("target_page"),
    evidence: text("evidence"),
    routeStatus: text("route_status"),
    vikunjaTaskId: text("vikunja_task_id"),
    vikunjaTaskUrl: text("vikunja_task_url"),
    // The linked Vikunja task's done flag; null until a task is linked.
    vikunjaDone: integer("vikunja_done", { mode: "boolean" }),
    liveAt: text("live_at"),
    remeasureDueAt: text("remeasure_due_at"),
    verdict: text("verdict", {
      enum: ["moved", "flat", "worse", "data_too_thin"],
    }),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    uniqueIndex("findings_prefix_number_idx").on(table.prefix, table.number),
    index("findings_project_stage_idx").on(table.projectId, table.stage),
  ],
);

export const findingStageEvents = sqliteTable(
  "finding_stage_events",
  {
    id: text("id").primaryKey(),
    findingId: text("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    // null on the creation event.
    fromStage: text("from_stage"),
    toStage: text("to_stage").notNull(),
    actor: text("actor").notNull(),
    note: text("note"),
    at: text("at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    index("finding_stage_events_finding_idx").on(table.findingId, table.at),
  ],
);

export const findingMeasurements = sqliteTable(
  "finding_measurements",
  {
    id: text("id").primaryKey(),
    findingId: text("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["baseline", "remeasure"] }).notNull(),
    rulesVersion: text("rules_version").notNull(),
    windowStart: text("window_start").notNull(),
    windowEnd: text("window_end").notNull(),
    metrics: text("metrics").notNull(),
    deltas: text("deltas"),
    verdict: text("verdict", {
      enum: ["moved", "flat", "worse", "data_too_thin"],
    }),
    // metrics, deltas and sources are JSON text; sources lists the free reads that
    // fed the numbers: [{ tool, date }].
    sources: text("sources").notNull(),
    measuredAt: text("measured_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    uniqueIndex("finding_measurements_unique_idx").on(
      table.findingId,
      table.kind,
      table.rulesVersion,
      table.windowEnd,
    ),
  ],
);

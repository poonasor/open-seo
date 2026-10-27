import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  findingMeasurements,
  findingPrefixes,
  findings,
  findingStageEvents,
} from "@/db/schema";
import type { FindingStage } from "@/server/features/findings/findingsDomain";

// Every read and write is scoped by projectId; callers have already authorized
// the project against the caller's organization.

type FindingInsert = typeof findings.$inferInsert;
export type FindingPatch = Partial<
  Pick<
    FindingInsert,
    | "finding"
    | "targetPage"
    | "evidence"
    | "routeStatus"
    | "vikunjaTaskId"
    | "vikunjaTaskUrl"
    | "verdict"
  >
>;

async function getPrefix(projectId: string, prefix: string) {
  const [row] = await db
    .select()
    .from(findingPrefixes)
    .where(
      and(
        eq(findingPrefixes.projectId, projectId),
        eq(findingPrefixes.prefix, prefix),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Finding ids are unique across projects, so a prefix registered by another
// project is unavailable. Only the boolean leaves the repository.
async function isPrefixTakenElsewhere(projectId: string, prefix: string) {
  const rows = await db
    .select({ projectId: findingPrefixes.projectId })
    .from(findingPrefixes)
    .where(eq(findingPrefixes.prefix, prefix));
  return rows.some((row) => row.projectId !== projectId);
}

async function insertPrefix(projectId: string, prefix: string, site: string) {
  await db
    .insert(findingPrefixes)
    .values({ id: crypto.randomUUID(), projectId, prefix, site });
}

/**
 * Atomically bumps the prefix's high-water mark and returns the new number.
 * The mark only rises, so a number is never issued twice, even after its
 * finding is deleted.
 */
async function allocateNumber(projectId: string, prefix: string) {
  const [row] = await db
    .update(findingPrefixes)
    .set({ lastNumber: sql`${findingPrefixes.lastNumber} + 1` })
    .where(
      and(
        eq(findingPrefixes.projectId, projectId),
        eq(findingPrefixes.prefix, prefix),
      ),
    )
    .returning({ number: findingPrefixes.lastNumber });
  return row?.number ?? null;
}

async function findingExists(id: string) {
  const [row] = await db
    .select({ id: findings.id })
    .from(findings)
    .where(eq(findings.id, id))
    .limit(1);
  return Boolean(row);
}

async function insertFinding(
  row: FindingInsert,
  event: { actor: string; note: string | null },
) {
  const at = new Date().toISOString();
  await runBatch((tx) => [
    tx.insert(findings).values({ ...row, createdAt: at, updatedAt: at }),
    // Explicit ids (imports) may sit above the mark; keep it monotonic.
    tx
      .update(findingPrefixes)
      .set({
        lastNumber: sql`CASE WHEN ${findingPrefixes.lastNumber} < ${row.number} THEN ${row.number} ELSE ${findingPrefixes.lastNumber} END`,
      })
      .where(
        and(
          eq(findingPrefixes.projectId, row.projectId),
          eq(findingPrefixes.prefix, row.prefix),
        ),
      ),
    tx.insert(findingStageEvents).values({
      id: crypto.randomUUID(),
      findingId: row.id,
      fromStage: null,
      toStage: row.stage ?? "finding",
      actor: event.actor,
      note: event.note,
      at,
    }),
  ]);
}

async function listFindings(
  projectId: string,
  filter: { stage?: FindingStage; prefix?: string },
) {
  return db
    .select()
    .from(findings)
    .where(
      and(
        eq(findings.projectId, projectId),
        filter.stage ? eq(findings.stage, filter.stage) : undefined,
        filter.prefix ? eq(findings.prefix, filter.prefix) : undefined,
      ),
    )
    .orderBy(asc(findings.prefix), asc(findings.number));
}

async function getFinding(projectId: string, id: string) {
  const [row] = await db
    .select()
    .from(findings)
    .where(and(eq(findings.projectId, projectId), eq(findings.id, id)))
    .limit(1);
  return row ?? null;
}

async function listEvents(findingId: string) {
  return db
    .select()
    .from(findingStageEvents)
    .where(eq(findingStageEvents.findingId, findingId))
    .orderBy(asc(findingStageEvents.at));
}

async function listMeasurements(findingId: string) {
  return db
    .select()
    .from(findingMeasurements)
    .where(eq(findingMeasurements.findingId, findingId))
    .orderBy(desc(findingMeasurements.measuredAt));
}

async function updateFinding(
  projectId: string,
  id: string,
  patch: FindingPatch,
) {
  await db
    .update(findings)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(and(eq(findings.projectId, projectId), eq(findings.id, id)));
}

async function moveStage(params: {
  projectId: string;
  id: string;
  from: FindingStage;
  to: FindingStage;
  actor: string;
  note: string | null;
  live?: { liveAt: string; remeasureDueAt: string };
}) {
  const at = new Date().toISOString();
  await runBatch((tx) => [
    tx
      .update(findings)
      .set({ stage: params.to, updatedAt: at, ...params.live })
      .where(
        and(
          eq(findings.projectId, params.projectId),
          eq(findings.id, params.id),
          // A concurrent move leaves the stage changed, so this one no-ops
          // instead of overwriting it.
          eq(findings.stage, params.from),
        ),
      ),
    tx.insert(findingStageEvents).values({
      id: crypto.randomUUID(),
      findingId: params.id,
      fromStage: params.from,
      toStage: params.to,
      actor: params.actor,
      note: params.note,
      at,
    }),
  ]);
}

export const FindingsRepository = {
  getPrefix,
  isPrefixTakenElsewhere,
  insertPrefix,
  allocateNumber,
  findingExists,
  insertFinding,
  listFindings,
  getFinding,
  listEvents,
  listMeasurements,
  updateFinding,
  moveStage,
};

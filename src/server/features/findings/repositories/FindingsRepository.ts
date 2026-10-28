import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  lte,
  max,
  notExists,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  aiMatches,
  aiObservations,
  aiPrompts,
  aiTrackers,
  findingMeasurements,
  findingPrefixes,
  findings,
  findingStageEvents,
  rankCheckRuns,
  rankSnapshots,
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

/** Appends a measurement. The unique index makes a same-window re-run a no-op,
 *  so a finding imported at live twice in a day keeps its first baseline. */
async function insertMeasurement(
  row: Omit<typeof findingMeasurements.$inferInsert, "id" | "measuredAt">,
) {
  await db
    .insert(findingMeasurements)
    .values({ ...row, id: crypto.randomUUID() })
    .onConflictDoNothing();
}

/**
 * The latest stored snapshot per keyword per device, read-only: a baseline
 * never starts a rank-tracker run. Keywords are matched case-insensitively
 * because Search Console reports queries lowercased while tracked keywords
 * keep their case when `match_case` is set.
 */
async function latestRankSnapshotsForKeywords(
  projectId: string,
  keywords: string[],
) {
  if (keywords.length === 0) return [];
  const completedRunIds = db
    .select({ id: rankCheckRuns.id })
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.projectId, projectId),
        eq(rankCheckRuns.status, "completed"),
      ),
    );
  const keyword = sql`lower(${rankSnapshots.keyword})`;

  // The aggregate aliases must not collide with the outer table's column
  // names: drizzle renders them unqualified in the join, so a collision makes
  // the column ambiguous.
  const grouped = db
    .select({
      keyword: keyword.as("target_keyword"),
      device: rankSnapshots.device,
      checkedAt: max(rankSnapshots.checkedAt).as("target_checked_at"),
    })
    .from(rankSnapshots)
    .where(
      and(
        inArray(rankSnapshots.runId, completedRunIds),
        inArray(
          keyword,
          keywords.map((k) => k.toLowerCase()),
        ),
      ),
    )
    .groupBy(keyword, rankSnapshots.device)
    .as("grouped");

  return db
    .select({
      keyword: sql<string>`lower(${rankSnapshots.keyword})`,
      device: rankSnapshots.device,
      position: rankSnapshots.position,
      checkedAt: rankSnapshots.checkedAt,
    })
    .from(rankSnapshots)
    .innerJoin(
      grouped,
      and(
        eq(keyword, grouped.keyword),
        eq(rankSnapshots.device, grouped.device),
        eq(rankSnapshots.checkedAt, grouped.checkedAt),
      ),
    )
    .where(inArray(rankSnapshots.runId, completedRunIds));
}

/**
 * The latest collected AI answer per prompt per engine, with whether the
 * project's own domain was mentioned and cited in it. Read-only: a baseline
 * never starts an AI-visibility run. Returns every prompt of the project's
 * tracker (bounded by the tracker's prompt limit); the caller keeps the ones
 * relevant to its finding.
 */
async function latestAiVisibilityForTracker(projectId: string) {
  const [tracker] = await db
    .select({ id: aiTrackers.id })
    .from(aiTrackers)
    .where(eq(aiTrackers.projectId, projectId))
    .limit(1);
  if (!tracker) return [];

  const grouped = db
    .select({
      promptId: aiObservations.promptId,
      engine: aiObservations.engine,
      // Aliased past the column's own name; see latestRankSnapshotsForKeywords.
      collectedAt: max(aiObservations.collectedAt).as("target_collected_at"),
    })
    .from(aiObservations)
    .innerJoin(aiPrompts, eq(aiPrompts.id, aiObservations.promptId))
    .where(
      and(
        eq(aiPrompts.trackerId, tracker.id),
        eq(aiObservations.status, "completed"),
        isNotNull(aiObservations.collectedAt),
      ),
    )
    .groupBy(aiObservations.promptId, aiObservations.engine)
    .as("grouped");

  return (
    db
      .select({
        prompt: aiPrompts.text,
        engine: aiObservations.engine,
        collectedAt: aiObservations.collectedAt,
        mentioned: aiMatches.mentioned,
        cited: aiMatches.cited,
      })
      .from(aiObservations)
      .innerJoin(
        grouped,
        and(
          eq(aiObservations.promptId, grouped.promptId),
          eq(aiObservations.engine, grouped.engine),
          eq(aiObservations.collectedAt, grouped.collectedAt),
        ),
      )
      .innerJoin(aiPrompts, eq(aiPrompts.id, aiObservations.promptId))
      // `own` marks the project's own domain among the answer's matches.
      .leftJoin(
        aiMatches,
        and(
          eq(aiMatches.observationId, aiObservations.id),
          eq(aiMatches.own, true),
        ),
      )
  );
}

/** Live findings whose re-measure is due and that have no re-measure for this
 *  rules version yet: the cron's work queue, oldest first. Not project-scoped:
 *  the cron serves every project, and each row carries its own projectId. */
async function listDueForRemeasure(
  now: string,
  rulesVersion: string,
  limit: number,
) {
  return db
    .select()
    .from(findings)
    .where(
      and(
        eq(findings.stage, "live"),
        lte(findings.remeasureDueAt, now),
        notExists(
          db
            .select({ id: findingMeasurements.id })
            .from(findingMeasurements)
            .where(
              and(
                eq(findingMeasurements.findingId, findings.id),
                eq(findingMeasurements.kind, "remeasure"),
                eq(findingMeasurements.rulesVersion, rulesVersion),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(findings.remeasureDueAt))
    .limit(limit);
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
  // The re-measure move: the verdict lands on the finding and the measurement
  // is stored in the same atomic batch as the stage change.
  remeasure?: {
    verdict: NonNullable<FindingInsert["verdict"]>;
    measurement: Omit<
      typeof findingMeasurements.$inferInsert,
      "id" | "measuredAt"
    >;
  };
}) {
  const at = new Date().toISOString();
  const [moved] = await runBatch((tx) => [
    tx
      .update(findings)
      .set({
        stage: params.to,
        updatedAt: at,
        ...params.live,
        ...(params.remeasure && { verdict: params.remeasure.verdict }),
      })
      .where(
        and(
          eq(findings.projectId, params.projectId),
          eq(findings.id, params.id),
          // A concurrent move leaves the stage changed, so this one matches
          // no row instead of overwriting it.
          eq(findings.stage, params.from),
        ),
      )
      .returning({ id: findings.id }),
    // Only record the event when the update above took effect in this same
    // batch/transaction (its stage and timestamp are ours).
    tx.insert(findingStageEvents).select(
      tx
        .select({
          id: sql<string>`${crypto.randomUUID()}`.as("id"),
          findingId: sql<string>`${findings.id}`.as("finding_id"),
          fromStage: sql<FindingStage>`${params.from}`.as("from_stage"),
          toStage: sql<FindingStage>`${params.to}`.as("to_stage"),
          actor: sql<string>`${params.actor}`.as("actor"),
          note: sql<string | null>`${params.note}`.as("note"),
          at: sql<string>`${at}`.as("at"),
        })
        .from(findings)
        .where(
          and(
            eq(findings.id, params.id),
            eq(findings.stage, params.to),
            eq(findings.updatedAt, at),
          ),
        ),
    ),
    // Insert-or-ignore, so a re-run for the same window adds nothing. Last,
    // so the guarded update stays the first result.
    ...(params.remeasure
      ? [
          tx
            .insert(findingMeasurements)
            .values({
              ...params.remeasure.measurement,
              id: crypto.randomUUID(),
              measuredAt: at,
            })
            .onConflictDoNothing(),
        ]
      : []),
  ]);
  return Array.isArray(moved) && moved.length > 0;
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
  insertMeasurement,
  latestRankSnapshotsForKeywords,
  latestAiVisibilityForTracker,
  listDueForRemeasure,
  updateFinding,
  moveStage,
};

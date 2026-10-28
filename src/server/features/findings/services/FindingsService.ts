import { FindingsRepository } from "@/server/features/findings/repositories/FindingsRepository";
import {
  FINDING_STAGES,
  formatFindingId,
  isAllowedTransition,
  parseFindingId,
  remeasureDueAt,
  type FindingStage,
} from "@/server/features/findings/findingsDomain";
import { recordBaseline } from "@/server/features/findings/services/baselineSnapshot";
import type { FindingPatch } from "@/server/features/findings/repositories/FindingsRepository";
import { AppError } from "@/server/lib/errors";

// Marketing findings: creation and id allocation, field edits, and the staged
// lifecycle. Callers authorize the project before reaching this service.

type CreateFindingInput = {
  // Import only: a pre-existing id such as PM-F014. Omit to allocate the next.
  id?: string;
  prefix?: string;
  site?: string;
  finding: string;
  targetPage?: string | null;
  evidence?: string | null;
  routeStatus?: string | null;
  // Import only: create at a later stage than "finding".
  stage?: FindingStage;
  liveAt?: string;
  actor: string;
};

// Resolves the prefix row, registering it on first use. Prefixes are claimed
// globally because finding ids are, so one project can't squat another's.
async function ensurePrefix(
  projectId: string,
  prefix: string,
  site: string | undefined,
) {
  const existing = await FindingsRepository.getPrefix(projectId, prefix);
  if (existing) return existing;
  if (!site) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Prefix ${prefix} is new for this project; pass the site it covers.`,
    );
  }
  if (await FindingsRepository.isPrefixTakenElsewhere(projectId, prefix)) {
    throw new AppError("CONFLICT", `Prefix ${prefix} is already in use.`);
  }
  await FindingsRepository.insertPrefix(projectId, prefix, site);
  const created = await FindingsRepository.getPrefix(projectId, prefix);
  if (!created) throw new AppError("INTERNAL_ERROR");
  return created;
}

async function createFinding(projectId: string, input: CreateFindingInput) {
  const parsed = input.id ? parseFindingId(input.id) : null;
  if (input.id && !parsed) {
    throw new AppError("VALIDATION_ERROR", "Finding id looks like PM-F001.");
  }
  const prefix = parsed?.prefix ?? input.prefix;
  if (!prefix || (input.prefix && input.prefix !== prefix)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Pass a prefix, or an id whose prefix matches it.",
    );
  }
  const stage = input.stage ?? "finding";
  if (!input.id && (input.stage || input.liveAt)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "stage and liveAt are for imports; pass an explicit id.",
    );
  }

  const prefixRow = await ensurePrefix(projectId, prefix, input.site);

  let number: number;
  if (parsed) {
    const taken = await FindingsRepository.findingExists(
      formatFindingId(prefix, parsed.number),
    );
    if (taken) throw new AppError("CONFLICT", `${input.id} already exists.`);
    number = parsed.number;
  } else {
    const allocated = await FindingsRepository.allocateNumber(
      projectId,
      prefix,
    );
    if (allocated === null) throw new AppError("INTERNAL_ERROR");
    number = allocated;
  }
  const id = formatFindingId(prefix, number);

  const reachedLive = FINDING_STAGES.indexOf(stage) >= 5;
  const liveAt = reachedLive
    ? (input.liveAt ?? new Date().toISOString())
    : null;
  const targetPage = input.targetPage ?? null;
  await FindingsRepository.insertFinding(
    {
      id,
      projectId,
      prefix,
      number,
      site: prefixRow.site,
      stage,
      finding: input.finding,
      targetPage,
      evidence: input.evidence ?? null,
      routeStatus: input.routeStatus ?? null,
      liveAt,
      remeasureDueAt: liveAt ? remeasureDueAt(liveAt) : null,
    },
    { actor: input.actor, note: input.id ? "Imported" : null },
  );
  if (liveAt) await recordBaseline(projectId, { id, targetPage });
  return getFinding(projectId, id);
}

async function requireFinding(projectId: string, id: string) {
  const finding = await FindingsRepository.getFinding(projectId, id);
  if (!finding) throw new AppError("NOT_FOUND", `Finding ${id} not found.`);
  return finding;
}

function parseJson(text: string | null) {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function getFinding(projectId: string, id: string) {
  const finding = await requireFinding(projectId, id);
  const [events, measurements] = await Promise.all([
    FindingsRepository.listEvents(id),
    FindingsRepository.listMeasurements(id),
  ]);
  return {
    finding,
    events,
    measurements: measurements.map((m) => ({
      ...m,
      metrics: parseJson(m.metrics),
      deltas: parseJson(m.deltas),
      sources: parseJson(m.sources),
    })),
  };
}

async function listFindings(
  projectId: string,
  filter: { stage?: FindingStage; prefix?: string },
) {
  return FindingsRepository.listFindings(projectId, filter);
}

async function updateFinding(
  projectId: string,
  id: string,
  patch: FindingPatch,
) {
  await requireFinding(projectId, id);
  await FindingsRepository.updateFinding(projectId, id, patch);
  return getFinding(projectId, id);
}

async function moveStage(
  projectId: string,
  id: string,
  input: {
    toStage: FindingStage;
    actor: string;
    note?: string | null;
    // Lets an import jump stages in any direction.
    import?: boolean;
    liveAt?: string;
  },
) {
  const current = await requireFinding(projectId, id);
  if (current.stage === input.toStage) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${id} is already ${input.toStage}.`,
    );
  }
  if (!input.import && !isAllowedTransition(current.stage, input.toStage)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${id} cannot move from ${current.stage} to ${input.toStage}; stages go in order (Finding -> Spec is the only shortcut). Set import to override.`,
    );
  }
  if (input.liveAt && !input.import) {
    throw new AppError("VALIDATION_ERROR", "liveAt is only for imports.");
  }
  // Going live starts the re-measure clock. An import jumping straight to
  // Re-measured has no live date yet, so it gets one here.
  const startsClock =
    input.toStage === "live" ||
    (input.toStage === "re_measured" && current.liveAt === null);
  const liveAt = startsClock
    ? (input.liveAt ?? new Date().toISOString())
    : undefined;
  const moved = await FindingsRepository.moveStage({
    projectId,
    id,
    from: current.stage,
    to: input.toStage,
    actor: input.actor,
    note: input.note ?? null,
    live: liveAt
      ? { liveAt, remeasureDueAt: remeasureDueAt(liveAt) }
      : undefined,
  });
  if (!moved) {
    throw new AppError(
      "CONFLICT",
      `${id} changed stage while it was being moved; reload it and try again.`,
    );
  }
  // The baseline only exists for a move that happened, so it is collected
  // after the guarded update. Sources that are missing are recorded as
  // "data missing" inside it rather than failing the move.
  if (liveAt)
    await recordBaseline(projectId, { id, targetPage: current.targetPage });
  return getFinding(projectId, id);
}

export const FindingsService = {
  createFinding,
  getFinding,
  listFindings,
  updateFinding,
  moveStage,
};

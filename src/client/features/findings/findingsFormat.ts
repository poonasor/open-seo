import { z } from "zod";
import {
  FINDING_STAGES,
  findingStageSchema,
  isAllowedTransition,
  type FindingStage,
} from "@/server/features/findings/findingsDomain";

export const STAGE_LABELS: Record<FindingStage, string> = {
  finding: "Finding",
  brief: "Brief",
  draft: "Draft",
  spec: "Spec",
  filed: "Filed",
  live: "Live",
  re_measured: "Re-measured",
};

type FindingVerdict = "moved" | "flat" | "worse" | "data_too_thin";

/** The label for a stage name read from a stored event. */
export function stageLabel(stage: string) {
  const parsed = findingStageSchema.safeParse(stage);
  return parsed.success ? STAGE_LABELS[parsed.data] : stage;
}

export const VERDICT_LABELS: Record<FindingVerdict, string> = {
  moved: "Moved",
  flat: "Flat",
  worse: "Worse",
  data_too_thin: "Data too thin",
};

/** Whole days (or hours, under a day) since an ISO timestamp. */
export function formatAge(since: string, now = new Date()) {
  const hours = Math.max(
    0,
    Math.floor((now.getTime() - new Date(since).getTime()) / 3_600_000),
  );
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Stages a finding can be moved to by hand. Re-measured is reached only by
 *  re-measuring, because that is what produces its verdict. */
export function manualNextStages(stage: FindingStage) {
  return FINDING_STAGES.filter(
    (to) => to !== "re_measured" && isAllowedTransition(stage, to),
  );
}

// Measurement JSON is stored as text and may predate the current shape, so the
// view reads only what it shows and treats anything else as absent.
const numberChange = z.object({ before: z.number(), after: z.number() });

export const baselineMetricsSchema = z.object({
  searchConsole: z.object({
    clicks: z.number(),
    impressions: z.number(),
    ctr: z.number(),
    position: z.number(),
  }),
  urlInspection: z.object({ indexState: z.string().nullable() }).optional(),
});

export const remeasureDeltasSchema = z.object({
  clicks: numberChange.extend({ change: z.number() }),
  impressions: numberChange.extend({ change: z.number() }),
  ctr: numberChange.extend({ change: z.number() }),
  position: numberChange.extend({ placesGained: z.number() }),
  indexState: z.object({
    before: z.string().nullable(),
    after: z.string().nullable(),
  }),
  reason: z.string().optional(),
});

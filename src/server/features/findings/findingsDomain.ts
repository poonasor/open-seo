import { z } from "zod";

// The marketing-finding lifecycle, in order.
export const FINDING_STAGES = [
  "finding",
  "brief",
  "draft",
  "spec",
  "filed",
  "live",
  "re_measured",
] as const;
export const findingStageSchema = z.enum(FINDING_STAGES);
export type FindingStage = z.infer<typeof findingStageSchema>;

export const findingVerdictSchema = z.enum([
  "moved",
  "flat",
  "worse",
  "data_too_thin",
]);

// 28-day measurement window + 3-day Search Console lag.
const REMEASURE_DELAY_DAYS = 31;

/** Versions the rules that turn free reads into a measurement. A re-measure
 *  only compares against a baseline carrying the same version, so change what
 *  a measurement collects or computes and this must move. */
export const RULES_VERSION = "1";

export const prefixSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "Prefix is 2-10 uppercase letters or digits");

const ID_PATTERN = /^([A-Z][A-Z0-9]{1,9})-F(\d{3,6})$/;

export const findingIdSchema = z
  .string()
  .regex(ID_PATTERN, "Finding id looks like PM-F001");

export function formatFindingId(prefix: string, number: number) {
  return `${prefix}-F${String(number).padStart(3, "0")}`;
}

export function parseFindingId(id: string) {
  const match = ID_PATTERN.exec(id);
  if (!match?.[1] || !match[2]) return null;
  return { prefix: match[1], number: Number(match[2]) };
}

/**
 * Stages move forward one step at a time. Finding -> Spec is also allowed:
 * a technical fix needs no brief or draft. Anything else (skipping ahead,
 * moving back) needs the explicit import flag.
 */
export function isAllowedTransition(from: FindingStage, to: FindingStage) {
  const fromIndex = FINDING_STAGES.indexOf(from);
  const toIndex = FINDING_STAGES.indexOf(to);
  if (toIndex === fromIndex + 1) return true;
  return from === "finding" && to === "spec";
}

export function remeasureDueAt(liveAt: string) {
  return new Date(
    new Date(liveAt).getTime() + REMEASURE_DELAY_DAYS * 86_400_000,
  ).toISOString();
}

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  findingIdSchema,
  findingStageSchema,
} from "@/server/features/findings/findingsDomain";
import { FindingsService } from "@/server/features/findings/services/FindingsService";
import { requireProjectContext } from "@/serverFunctions/middleware";

// Measurement numbers were stored as JSON text; the framework can only send
// them to the browser once they are typed as JSON rather than unknown.
const jsonSchema = z.json();

async function toClientDetail(
  detail: ReturnType<typeof FindingsService.getFinding>,
) {
  const { finding, events, measurements } = await detail;
  return {
    finding,
    events,
    measurements: measurements.map((m) => ({
      ...m,
      metrics: jsonSchema.parse(m.metrics),
      deltas: jsonSchema.parse(m.deltas),
      sources: jsonSchema.parse(m.sources),
    })),
  };
}

const projectScopedSchema = z.object({ projectId: z.string().min(1) });
const findingScopedSchema = projectScopedSchema.extend({
  id: findingIdSchema,
});

export const listFindings = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(({ context }) =>
    FindingsService.listFindings(context.projectId, {}),
  );

export const getFinding = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(findingScopedSchema)
  .handler(({ data, context }) =>
    toClientDetail(FindingsService.getFinding(context.projectId, data.id)),
  );

// Never an import: the service enforces the normal transition rules.
// Re-measuring is its own action, because it needs a verdict.
export const moveFindingStage = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    findingScopedSchema.extend({
      toStage: findingStageSchema.exclude(["re_measured"]),
      note: z.string().trim().max(500).optional(),
    }),
  )
  .handler(({ data, context }) =>
    toClientDetail(
      FindingsService.moveStage(context.projectId, data.id, {
        toStage: data.toStage,
        note: data.note || null,
        actor: `user:${context.userId}`,
      }),
    ),
  );

export const remeasureFinding = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(findingScopedSchema)
  .handler(({ data, context }) =>
    toClientDetail(
      FindingsService.remeasureFinding(
        context.projectId,
        data.id,
        `user:${context.userId}`,
      ),
    ),
  );

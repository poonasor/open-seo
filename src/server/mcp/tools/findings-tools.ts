import { z } from "zod";
import {
  findingIdSchema,
  findingStageSchema,
  findingVerdictSchema,
  prefixSchema,
} from "@/server/features/findings/findingsDomain";
import { FindingsService } from "@/server/features/findings/services/FindingsService";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

// Findings are rows in OpenSEO's own database, so none of these tools call a
// provider or charge credits. Rows stay loose objects: clients cache the
// output schema across deployments and new columns must not break them.

const findingOutputSchema = z.looseObject({
  finding: looseObjectOutputSchema,
  events: z.array(looseObjectOutputSchema),
  measurements: z.array(looseObjectOutputSchema),
  ...optionalMetaOutputSchema,
});

const listOutputSchema = z.looseObject({
  findings: z.array(looseObjectOutputSchema),
  ...optionalMetaOutputSchema,
});

function describeFinding(f: {
  id: string;
  stage: string;
  finding: string;
  targetPage: string | null;
}) {
  return `${f.id} [${f.stage}] ${f.targetPage ?? "(missing page)"}: ${f.finding}`;
}

function detailResponse(
  projectId: string,
  result: Awaited<ReturnType<typeof FindingsService.getFinding>>,
  heading: string,
) {
  const lines = [
    `${heading}${describeFinding(result.finding)}`,
    ...result.events.map(
      (e) =>
        `  ${e.at} ${e.fromStage ?? "-"} -> ${e.toStage} by ${e.actor}${e.note ? ` (${e.note})` : ""}`,
    ),
  ];
  if (result.finding.remeasureDueAt) {
    lines.push(`Re-measure due ${result.finding.remeasureDueAt}`);
  }
  return mcpResponse({
    text: lines.join("\n"),
    meta: { projectId },
    structuredContent: result,
  });
}

const listInputSchema = {
  projectId: projectIdSchema,
  stage: findingStageSchema.optional().describe("Only findings at this stage."),
  prefix: prefixSchema.optional().describe("Only findings under this prefix."),
} as const;

export const listFindingsTool = {
  name: "list_findings",
  config: {
    title: "List findings",
    description:
      "Lists a project's marketing findings (ids like PM-F001), optionally filtered by stage and prefix. Uses no credits. Stages in order: finding, brief, draft, spec, filed, live, re_measured. Use get_finding for events and measurements.",
    inputSchema: listInputSchema,
    outputSchema: listOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof listInputSchema>>) => {
      const findings = await FindingsService.listFindings(args.projectId, {
        stage: args.stage,
        prefix: args.prefix,
      });
      return mcpResponse({
        text:
          findings.length === 0
            ? "No findings match."
            : `Findings (${findings.length}):\n${findings.map(describeFinding).join("\n")}`,
        meta: { projectId: args.projectId },
        structuredContent: { findings },
      });
    },
  ),
};

const getInputSchema = {
  projectId: projectIdSchema,
  id: findingIdSchema.describe("Finding id, e.g. PM-F001."),
} as const;

export const getFindingTool = {
  name: "get_finding",
  config: {
    title: "Get finding",
    description:
      "Reads one finding with its stage history (events) and stored baseline/re-measure measurements. Uses no credits.",
    inputSchema: getInputSchema,
    outputSchema: findingOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof getInputSchema>>) =>
      detailResponse(
        args.projectId,
        await FindingsService.getFinding(args.projectId, args.id),
        "",
      ),
  ),
};

const createInputSchema = {
  projectId: projectIdSchema,
  prefix: prefixSchema
    .optional()
    .describe(
      "Prefix to file the finding under (e.g. PM). Required unless id is given.",
    ),
  site: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Site the prefix covers. Required the first time a prefix is used.",
    ),
  finding: z.string().min(1).max(4000).describe("What was found."),
  targetPage: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe(
      "Page the finding is about; null or omitted = a page that does not exist yet.",
    ),
  evidence: z.string().max(8000).nullable().optional(),
  routeStatus: z.string().max(200).nullable().optional(),
  id: findingIdSchema
    .optional()
    .describe(
      "Import only: an existing id such as PM-F014. Omit to get the next number. Fails with CONFLICT if taken.",
    ),
  stage: findingStageSchema
    .optional()
    .describe("Import only (needs id): the stage to create the finding at."),
  liveAt: z.iso
    .datetime()
    .optional()
    .describe(
      "Import only (needs id): when it went live, for live/re_measured.",
    ),
} as const;

export const createFindingTool = {
  name: "create_finding",
  config: {
    title: "Create finding",
    description:
      "Records a marketing finding at stage `finding` under a prefix, assigning the next id (PM-F001, PM-F002, ...; numbers are never reused). Uses no credits. To import an existing finding, pass its id (and optionally stage/liveAt); a taken id returns a conflict error.",
    inputSchema: createInputSchema,
    outputSchema: findingOutputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof createInputSchema>>, context) => {
      const { projectId, ...input } = args;
      const result = await FindingsService.createFinding(projectId, {
        ...input,
        actor: `mcp:${context.auth.userId}`,
      });
      return detailResponse(projectId, result, "Created ");
    },
  ),
};

const updateInputSchema = {
  projectId: projectIdSchema,
  id: findingIdSchema,
  finding: z.string().min(1).max(4000).optional(),
  targetPage: z.string().max(2000).nullable().optional(),
  evidence: z.string().max(8000).nullable().optional(),
  routeStatus: z.string().max(200).nullable().optional(),
  vikunjaTaskId: z.string().max(200).nullable().optional(),
  vikunjaTaskUrl: z.string().max(2000).nullable().optional(),
  verdict: findingVerdictSchema.nullable().optional(),
} as const;

export const updateFindingTool = {
  name: "update_finding",
  config: {
    title: "Update finding",
    description:
      "Edits a finding's non-stage fields (finding text, target page, evidence, route status, Vikunja task, verdict). Omitted fields are unchanged; null clears one. Use move_finding_stage to change stage. Uses no credits.",
    inputSchema: updateInputSchema,
    outputSchema: findingOutputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof updateInputSchema>>) => {
      const { projectId, id, ...fields } = args;
      const patch = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      );
      const result = await FindingsService.updateFinding(projectId, id, patch);
      return detailResponse(projectId, result, "Updated ");
    },
  ),
};

const moveInputSchema = {
  projectId: projectIdSchema,
  id: findingIdSchema,
  toStage: findingStageSchema,
  note: z.string().max(2000).optional().describe("Why, recorded on the event."),
  import: z
    .boolean()
    .optional()
    .describe(
      "Import only: allow skipping stages or moving back. Without it stages go in order (finding -> brief -> draft -> spec -> filed -> live -> re_measured; finding -> spec is also allowed for technical fixes).",
    ),
  liveAt: z.iso
    .datetime()
    .optional()
    .describe("Import only: when it actually went live."),
} as const;

export const moveFindingStageTool = {
  name: "move_finding_stage",
  config: {
    title: "Move finding stage",
    description:
      "Moves a finding to its next lifecycle stage and records a stage event. Moving to live stamps live_at and sets remeasure_due_at 31 days later (28-day window + 3-day Search Console lag). Uses no credits and takes no baseline.",
    inputSchema: moveInputSchema,
    outputSchema: findingOutputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof moveInputSchema>>, context) => {
      const result = await FindingsService.moveStage(args.projectId, args.id, {
        toStage: args.toStage,
        actor: `mcp:${context.auth.userId}`,
        note: args.note,
        import: args.import,
        liveAt: args.liveAt,
      });
      return detailResponse(args.projectId, result, "Moved ");
    },
  ),
};

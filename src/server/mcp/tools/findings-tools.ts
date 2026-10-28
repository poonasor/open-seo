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

// A measurement's metrics come back as JSON text parsed to `unknown`; narrow
// just the totals the baseline line quotes.
const gscTotalsSchema = z.object({
  searchConsole: z.object({
    clicks: z.number(),
    impressions: z.number(),
    position: z.number(),
  }),
});

function baselineLine(baseline: {
  windowStart: string;
  windowEnd: string;
  rulesVersion: string;
  metrics: unknown;
}) {
  const totals = gscTotalsSchema.safeParse(baseline.metrics);
  const gsc = totals.success ? totals.data.searchConsole : null;
  return `Baseline ${baseline.windowStart}..${baseline.windowEnd} (rules v${baseline.rulesVersion})${
    gsc
      ? `: ${gsc.clicks} clicks, ${gsc.impressions} impressions, position ${gsc.position.toFixed(1)}`
      : ""
  }`;
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
  const baseline = result.measurements.find((m) => m.kind === "baseline");
  if (baseline) {
    lines.push(baselineLine(baseline));
  }
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
      "Full URL of the page the finding is about, as Search Console reports it (the baseline reads this page); null or omitted = a page that does not exist yet.",
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
      "Records a marketing finding at stage `finding` under a prefix, assigning the next id (PM-F001, PM-F002, ...; numbers are never reused). Uses no credits. To import an existing finding, pass its id (and optionally stage/liveAt); a taken id returns a conflict error. An import at live/re_measured takes a baseline measurement, like a stage move to live.",
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
      'Moves a finding to its next lifecycle stage and records a stage event. Moving to live stamps live_at, sets remeasure_due_at 31 days later (28-day window + 3-day Search Console lag), and records a baseline measurement from free reads only: Search Console performance and URL inspection for the target page, plus stored rank-tracker positions and stored AI-visibility answers for its top queries (it never starts a run; missing sources are stored as "data missing"). Uses no credits.',
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

const remeasureInputSchema = {
  projectId: projectIdSchema,
  id: findingIdSchema,
} as const;

export const remeasureFindingTool = {
  name: "remeasure_finding",
  config: {
    title: "Re-measure finding",
    description:
      "Runs the re-measure for one live finding now instead of waiting for the scheduled job: compares the 28 days before and after it went live from free reads only (Search Console, URL inspection, stored rank-tracker and AI-visibility results), stores a remeasure measurement and a verdict (moved, flat, worse, data_too_thin), and moves the finding to re_measured. Refuses until the after window has closed (28 days after live plus a 3-day Search Console lag). A finding that is already re-measured is returned unchanged. Uses no credits.",
    inputSchema: remeasureInputSchema,
    outputSchema: findingOutputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  handler: withMcpProjectAuth(
    async (
      args: z.infer<z.ZodObject<typeof remeasureInputSchema>>,
      context,
    ) => {
      const result = await FindingsService.remeasureFinding(
        args.projectId,
        args.id,
        `mcp:${context.auth.userId}`,
      );
      return detailResponse(args.projectId, result, "Re-measured ");
    },
  ),
};

const syncVikunjaInputSchema = {
  projectId: projectIdSchema,
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      "Default true: only report the planned changes. Pass false to apply them.",
    ),
  mappings: z
    .array(
      z.object({
        prefix: prefixSchema,
        vikunjaProjectId: z.string().min(1).max(50),
      }),
    )
    .max(20)
    .optional()
    .describe(
      "Prefix -> Vikunja project id. Saved when dryRun is false; reused on later syncs.",
    ),
} as const;

export const syncFindingsVikunjaTool = {
  name: "sync_findings_vikunja",
  config: {
    title: "Sync findings from Vikunja",
    description:
      "One-way, read-only sync from Vikunja: lists tasks in each prefix's mapped Vikunja project and links those whose title starts with a finding id (PM-F001 ...), recording the task id, URL and done state on the finding. A Spec finding whose task is found moves to Filed. It never writes to Vikunja and never moves a finding to Live. dryRun defaults to true and returns the planned changes; pass dryRun false to apply them. Needs VIKUNJA_API_URL and VIKUNJA_API_TOKEN on the server. Uses no credits.",
    inputSchema: syncVikunjaInputSchema,
    outputSchema: z.looseObject({
      dryRun: z.boolean(),
      changes: z.array(looseObjectOutputSchema),
      unmappedPrefixes: z.array(z.string()),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  handler: withMcpProjectAuth(
    async (
      args: z.infer<z.ZodObject<typeof syncVikunjaInputSchema>>,
      context,
    ) => {
      const result = await FindingsService.syncFindingsVikunja(args.projectId, {
        dryRun: args.dryRun,
        mappings: args.mappings,
        actor: `mcp:${context.auth.userId}`,
      });
      const lines = result.changes.map(
        (c) =>
          `${c.findingId}: task ${c.vikunjaTaskId}${c.done ? " (done)" : ""}${c.movedToFiled ? ", spec -> filed" : ""}`,
      );
      const unmapped = result.unmappedPrefixes.length
        ? `\nNo Vikunja project mapped for: ${result.unmappedPrefixes.join(", ")}`
        : "";
      return mcpResponse({
        text: `${result.dryRun ? "Planned" : "Applied"} ${result.changes.length} change(s).${lines.length ? "\n" + lines.join("\n") : ""}${unmapped}`,
        meta: { projectId: args.projectId },
        structuredContent: result,
      });
    },
  ),
};

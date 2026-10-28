import { Link } from "@tanstack/react-router";
import { EmptyState } from "@/client/components/EmptyState";
import { Badge } from "@/client/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { SectionHeader } from "@/client/components/PageHeader";
import { FINDING_STAGES } from "@/server/features/findings/findingsDomain";
import type { listFindings } from "@/serverFunctions/findings";
import { STAGE_LABELS, VERDICT_LABELS, formatAge } from "./findingsFormat";

type FindingRow = Awaited<ReturnType<typeof listFindings>>[number];

export function VerdictBadge({ verdict }: { verdict: FindingRow["verdict"] }) {
  if (!verdict) return <span className="text-muted-foreground">—</span>;
  const variant =
    verdict === "moved"
      ? "success"
      : verdict === "worse"
        ? "destructive"
        : "secondary";
  return <Badge variant={variant}>{VERDICT_LABELS[verdict]}</Badge>;
}

/** Findings grouped by stage, each stage with its count. Stages with no
 *  findings still show, so the whole pipeline is visible. */
export function FindingsBoard({
  projectId,
  findings,
  hasFilters,
}: {
  projectId: string;
  findings: FindingRow[];
  hasFilters: boolean;
}) {
  if (findings.length === 0) {
    return hasFilters ? (
      <EmptyState
        kind="filtered"
        title="No findings match"
        description="Clear the prefix or site filter to see every finding."
      />
    ) : (
      <EmptyState
        title="No findings yet"
        description="Findings are logged through the OpenSEO MCP tools and move through the stages here."
      />
    );
  }
  return (
    <div className="space-y-6">
      {FINDING_STAGES.map((stage) => {
        const rows = findings.filter((f) => f.stage === stage);
        return (
          <section key={stage} className="space-y-2">
            <SectionHeader title={`${STAGE_LABELS[stage]} (${rows.length})`} />
            {rows.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-28">ID</TableHead>
                    <TableHead>Finding</TableHead>
                    <TableHead>Target page</TableHead>
                    <TableHead className="w-24">In stage</TableHead>
                    <TableHead className="w-32">Verdict</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs">
                        <Link
                          to="/p/$projectId/findings/$findingId"
                          params={{ projectId, findingId: row.id }}
                          className="text-primary hover:underline"
                        >
                          {row.id}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-md whitespace-normal">
                        {row.finding}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-muted-foreground">
                        {row.targetPage ?? "New page"}
                      </TableCell>
                      <TableCell>{formatAge(row.stageEnteredAt)}</TableCell>
                      <TableCell>
                        <VerdictBadge verdict={row.verdict} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">None</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

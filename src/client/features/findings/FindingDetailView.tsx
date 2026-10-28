import { useState } from "react";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/client/components/ui/card";
import { Input } from "@/client/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import type { FindingStage } from "@/server/features/findings/findingsDomain";
import type { getFinding } from "@/serverFunctions/findings";
import { VerdictBadge } from "./FindingsBoard";
import {
  STAGE_LABELS,
  baselineMetricsSchema,
  manualNextStages,
  remeasureDeltasSchema,
  stageLabel,
} from "./findingsFormat";

type FindingDetail = Awaited<ReturnType<typeof getFinding>>;

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm whitespace-pre-wrap break-words">
        {value || "—"}
      </dd>
    </div>
  );
}

function StageMoveControl({
  stage,
  pending,
  onMove,
  onRemeasure,
}: {
  stage: FindingStage;
  pending: boolean;
  onMove: (toStage: FindingStage, note: string) => void;
  onRemeasure: () => void;
}) {
  const options = manualNextStages(stage);
  const [target, setTarget] = useState<FindingStage | null>(null);
  const [note, setNote] = useState("");
  const toStage = target && options.includes(target) ? target : options[0];

  if (stage === "re_measured") {
    return <p className="text-sm text-muted-foreground">Lifecycle complete.</p>;
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      {toStage ? (
        <>
          <Select
            items={options.map((o) => ({ value: o, label: STAGE_LABELS[o] }))}
            value={toStage}
            onValueChange={(next) => next && setTarget(next)}
          >
            <SelectTrigger size="sm" aria-label="Move to stage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o} value={o}>
                  {STAGE_LABELS[o]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="Note"
            placeholder="Note (optional)"
            className="w-56"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              onMove(toStage, note);
              setNote("");
            }}
          >
            Move to {STAGE_LABELS[toStage]}
          </Button>
        </>
      ) : null}
      {stage === "live" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={onRemeasure}
        >
          Re-measure
        </Button>
      ) : null}
    </div>
  );
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

function BaselineCard({ metrics }: { metrics: unknown }) {
  const parsed = baselineMetricsSchema.safeParse(metrics);
  const sc = parsed.success ? parsed.data.searchConsole : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Baseline (28 days before going live)</CardTitle>
      </CardHeader>
      <CardContent>
        {sc ? (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Clicks" value={String(sc.clicks)} />
            <Field label="Impressions" value={String(sc.impressions)} />
            <Field label="CTR" value={percent(sc.ctr)} />
            <Field label="Avg position" value={sc.position.toFixed(1)} />
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            Search Console data was missing when this baseline was taken.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function RemeasureCard({
  deltas,
  verdict,
}: {
  deltas: unknown;
  verdict: FindingDetail["finding"]["verdict"];
}) {
  const parsed = remeasureDeltasSchema.safeParse(deltas);
  const d = parsed.success ? parsed.data : null;
  const rows = d
    ? [
        ["Clicks", d.clicks.before, d.clicks.after, signed(d.clicks.change)],
        [
          "Impressions",
          d.impressions.before,
          d.impressions.after,
          signed(d.impressions.change),
        ],
        [
          "CTR",
          percent(d.ctr.before),
          percent(d.ctr.after),
          `${signed(Number((d.ctr.change * 100).toFixed(1)))} pts`,
        ],
        [
          "Avg position",
          d.position.before,
          d.position.after,
          `${signed(d.position.placesGained)} places`,
        ],
        [
          "Index state",
          d.indexState.before ?? "—",
          d.indexState.after ?? "—",
          "",
        ],
      ]
    : [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Re-measure <VerdictBadge verdict={verdict} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {d?.reason ? <p className="text-sm">{d.reason}</p> : null}
        {d ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 font-normal">Metric</th>
                <th className="py-1 font-normal">Before</th>
                <th className="py-1 font-normal">After</th>
                <th className="py-1 font-normal">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, before, after, change]) => (
                <tr key={label}>
                  <td className="py-1">{label}</td>
                  <td className="py-1">{before}</td>
                  <td className="py-1">{after}</td>
                  <td className="py-1">{change}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">
            No comparable numbers were stored for this re-measure.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function FindingDetailView({
  detail,
  pending,
  onMove,
  onRemeasure,
}: {
  detail: FindingDetail;
  pending: boolean;
  onMove: (toStage: FindingStage, note: string) => void;
  onRemeasure: () => void;
}) {
  const { finding, events, measurements } = detail;
  const baseline = measurements.find((m) => m.kind === "baseline");
  const remeasure = measurements.find((m) => m.kind === "remeasure");
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <Badge variant="soft">{STAGE_LABELS[finding.stage]}</Badge>
            {finding.verdict ? (
              <VerdictBadge verdict={finding.verdict} />
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 sm:grid-cols-2">
            <Field label="Finding" value={finding.finding} />
            <Field label="Site" value={finding.site} />
            <Field
              label="Target page"
              value={finding.targetPage ?? "New page (does not exist yet)"}
            />
            <Field label="Route status" value={finding.routeStatus} />
            <Field label="Evidence" value={finding.evidence} />
            <Field label="Live at" value={finding.liveAt} />
            <Field label="Re-measure due" value={finding.remeasureDueAt} />
            <div className="space-y-0.5">
              <dt className="text-xs text-muted-foreground">Vikunja task</dt>
              <dd className="text-sm">
                {finding.vikunjaTaskUrl ? (
                  <a
                    href={finding.vikunjaTaskUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-primary hover:underline"
                  >
                    {finding.vikunjaTaskId
                      ? `Task ${finding.vikunjaTaskId}`
                      : "Open task"}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
            </div>
          </dl>
          <StageMoveControl
            key={finding.stage}
            stage={finding.stage}
            pending={pending}
            onMove={onMove}
            onRemeasure={onRemeasure}
          />
        </CardContent>
      </Card>

      {baseline ? <BaselineCard metrics={baseline.metrics} /> : null}
      {remeasure ? (
        <RemeasureCard deltas={remeasure.deltas} verdict={remeasure.verdict} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Stage history</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm">
            {events.map((event) => (
              <li key={event.id}>
                <span className="text-muted-foreground">
                  {event.at.slice(0, 10)}
                </span>{" "}
                {event.fromStage ? `${stageLabel(event.fromStage)} → ` : ""}
                {stageLabel(event.toStage)}{" "}
                <span className="text-muted-foreground">by {event.actor}</span>
                {event.note ? ` — ${event.note}` : ""}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

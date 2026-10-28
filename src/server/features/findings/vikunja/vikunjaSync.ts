import { sort } from "remeda";
import { FindingsRepository } from "@/server/features/findings/repositories/FindingsRepository";
import { VikunjaMappingRepository } from "@/server/features/findings/repositories/VikunjaMappingRepository";
import {
  createVikunjaClient,
  type VikunjaClient,
  type VikunjaTask,
} from "@/server/features/findings/vikunja/vikunjaClient";
import { AppError } from "@/server/lib/errors";

// One-way, read-only sync: Vikunja tasks whose title starts with a finding id
// (PM-F001 ...) are linked to that finding. Nothing is ever written to
// Vikunja, and a finding never goes Live from here (Live needs a check of
// the live page); the only stage move is Spec -> Filed.

type VikunjaSyncChange = {
  findingId: string;
  vikunjaTaskId: string;
  vikunjaTaskUrl: string;
  done: boolean;
  linked: boolean;
  doneChanged: boolean;
  movedToFiled: boolean;
};

type VikunjaSyncResult = {
  dryRun: boolean;
  changes: VikunjaSyncChange[];
  // Prefixes with no Vikunja project mapped, so nothing was synced for them.
  unmappedPrefixes: string[];
};

// "PM-F001 Fix title tag" -> "PM-F1". The number must end at a non-digit so
// PM-F001 never matches PM-F0012. Keyed by prefix and numeric value so
// padding differences still match.
function titleKey(title: string) {
  const match = /^([A-Z][A-Z0-9]{1,9})-F(\d{3,6})(?!\d)/.exec(title.trim());
  return match?.[1] && match[2] ? `${match[1]}-F${Number(match[2])}` : null;
}

// The lowest task id wins if two tasks claim the same finding.
function tasksByFinding(tasks: VikunjaTask[]) {
  const byKey = new Map<string, VikunjaTask>();
  for (const task of sort(tasks, (a, b) => a.id - b.id)) {
    const key = titleKey(task.title);
    if (key && !byKey.has(key)) byKey.set(key, task);
  }
  return byKey;
}

async function syncFindingsVikunja(
  projectId: string,
  input: {
    dryRun: boolean;
    actor: string;
    // Prefix -> Vikunja project id. Saved when the sync is applied.
    mappings?: { prefix: string; vikunjaProjectId: string }[];
    client?: VikunjaClient;
  },
): Promise<VikunjaSyncResult> {
  const prefixes = await VikunjaMappingRepository.listPrefixes(projectId);
  const mapped = new Map(
    prefixes.map((p) => [p.prefix, p.vikunjaProjectId] as const),
  );
  for (const m of input.mappings ?? []) {
    if (!mapped.has(m.prefix)) {
      throw new AppError(
        "NOT_FOUND",
        `Prefix ${m.prefix} is not registered for this project.`,
      );
    }
    mapped.set(m.prefix, m.vikunjaProjectId);
  }

  const unmappedPrefixes = [...mapped]
    .filter(([, vikunjaProjectId]) => !vikunjaProjectId)
    .map(([prefix]) => prefix);
  const toSync = [...mapped].flatMap(([prefix, vikunjaProjectId]) =>
    vikunjaProjectId ? [{ prefix, vikunjaProjectId }] : [],
  );
  if (toSync.length === 0) {
    return { dryRun: input.dryRun, changes: [], unmappedPrefixes };
  }

  const client = input.client ?? (await createVikunjaClient());
  const changes: VikunjaSyncChange[] = [];
  for (const { prefix, vikunjaProjectId } of toSync) {
    const tasks = tasksByFinding(
      await client.listProjectTasks(vikunjaProjectId),
    );
    const findings = await FindingsRepository.listFindings(projectId, {
      prefix,
    });
    for (const finding of findings) {
      const task = tasks.get(`${finding.prefix}-F${finding.number}`);
      if (!task) continue;
      const taskId = String(task.id);
      const url = client.taskUrl(task.id);
      const linked = finding.vikunjaTaskId !== taskId;
      const doneChanged = finding.vikunjaDone !== task.done;
      const movedToFiled = finding.stage === "spec";
      if (!linked && !doneChanged && !movedToFiled) continue;
      if (!input.dryRun) {
        await VikunjaMappingRepository.linkTask(projectId, finding.id, {
          taskId,
          url,
          done: task.done,
        });
        if (movedToFiled) {
          await FindingsRepository.moveStage({
            projectId,
            id: finding.id,
            from: "spec",
            to: "filed",
            actor: input.actor,
            note: `Vikunja task ${taskId} found`,
          });
        }
      }
      changes.push({
        findingId: finding.id,
        vikunjaTaskId: taskId,
        vikunjaTaskUrl: url,
        done: task.done,
        linked,
        doneChanged,
        movedToFiled,
      });
    }
  }

  // Mappings are saved only once the sync reached Vikunja and applied.
  if (!input.dryRun) {
    for (const m of input.mappings ?? []) {
      await VikunjaMappingRepository.setVikunjaProjectId(
        projectId,
        m.prefix,
        m.vikunjaProjectId,
      );
    }
  }
  return { dryRun: input.dryRun, changes, unmappedPrefixes };
}

export const VikunjaSync = { syncFindingsVikunja };

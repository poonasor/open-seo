import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { findingPrefixes, findings } from "@/db/schema";

// The per-prefix Vikunja project mapping. Scoped by projectId like the rest
// of the findings repositories.

async function listPrefixes(projectId: string) {
  return db
    .select()
    .from(findingPrefixes)
    .where(eq(findingPrefixes.projectId, projectId))
    .orderBy(asc(findingPrefixes.prefix));
}

async function setVikunjaProjectId(
  projectId: string,
  prefix: string,
  vikunjaProjectId: string | null,
) {
  await db
    .update(findingPrefixes)
    .set({ vikunjaProjectId })
    .where(
      and(
        eq(findingPrefixes.projectId, projectId),
        eq(findingPrefixes.prefix, prefix),
      ),
    );
}

async function linkTask(
  projectId: string,
  id: string,
  link: { taskId: string; url: string; done: boolean },
) {
  await db
    .update(findings)
    .set({
      vikunjaTaskId: link.taskId,
      vikunjaTaskUrl: link.url,
      vikunjaDone: link.done,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(findings.projectId, projectId), eq(findings.id, id)));
}

export const VikunjaMappingRepository = {
  listPrefixes,
  setVikunjaProjectId,
  linkTask,
};

import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { AppError } from "@/server/lib/errors";

// Read-only Vikunja client: GET requests only. The base URL (ending in
// /api/v1) and token come from secret env, never from code or the database.

const PAGE_SIZE = 50;
const MAX_PAGES = 20;

const taskSchema = z.object({
  id: z.number(),
  title: z.string(),
  done: z.boolean(),
});
export type VikunjaTask = z.infer<typeof taskSchema>;

export type VikunjaClient = {
  /** Every task in a Vikunja project, done or not. */
  listProjectTasks(vikunjaProjectId: string): Promise<VikunjaTask[]>;
  /** The web URL of a task, for linking from a finding. */
  taskUrl(taskId: number): string;
};

export async function createVikunjaClient(): Promise<VikunjaClient> {
  const apiUrl = (await getOptionalEnvValue("VIKUNJA_API_URL"))?.trim();
  const token = (await getOptionalEnvValue("VIKUNJA_API_TOKEN"))?.trim();
  if (!apiUrl || !token) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Vikunja sync needs VIKUNJA_API_URL and VIKUNJA_API_TOKEN set as secrets.",
    );
  }
  const base = apiUrl.replace(/\/+$/, "");
  const webBase = base.replace(/\/api\/v1$/, "");

  return {
    async listProjectTasks(vikunjaProjectId) {
      const tasks: VikunjaTask[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = `${base}/projects/${encodeURIComponent(vikunjaProjectId)}/tasks?page=${page}&per_page=${PAGE_SIZE}`;
        const response = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          throw new AppError(
            "INTERNAL_ERROR",
            `Vikunja returned ${response.status} for project ${vikunjaProjectId}.`,
          );
        }
        const batch = z
          .array(taskSchema.loose())
          .parse(await response.json())
          .map(({ id, title, done }) => ({ id, title, done }));
        tasks.push(...batch);
        if (batch.length < PAGE_SIZE) break;
      }
      return tasks;
    },
    taskUrl: (taskId) => `${webBase}/tasks/${taskId}`,
  };
}

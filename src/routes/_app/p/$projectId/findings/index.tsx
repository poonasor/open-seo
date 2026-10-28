import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { FindingsPage } from "@/client/features/findings/FindingsPage";

const searchSchema = z.object({
  prefix: z.string().optional(),
  site: z.string().optional(),
});

export const Route = createFileRoute("/_app/p/$projectId/findings/")({
  validateSearch: searchSchema,
  component: FindingsRoute,
});

function FindingsRoute() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  return (
    <FindingsPage
      projectId={projectId}
      filters={search}
      onFiltersChange={(filters) => {
        void navigate({ search: filters, replace: true });
      }}
    />
  );
}

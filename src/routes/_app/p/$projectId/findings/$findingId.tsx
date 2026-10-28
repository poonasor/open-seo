import { createFileRoute } from "@tanstack/react-router";
import { FindingDetailPage } from "@/client/features/findings/FindingDetailPage";

export const Route = createFileRoute("/_app/p/$projectId/findings/$findingId")({
  component: FindingRoute,
});

function FindingRoute() {
  const { projectId, findingId } = Route.useParams();
  return <FindingDetailPage projectId={projectId} findingId={findingId} />;
}

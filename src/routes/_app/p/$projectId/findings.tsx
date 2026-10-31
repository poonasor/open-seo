import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { BackLink, PageHeader } from "@/client/components/PageHeader";

export const Route = createFileRoute("/_app/p/$projectId/findings")({
  component: FindingsLayout,
});

function FindingsLayout() {
  // Only the detail route has a finding id, and only it links back.
  const { projectId, findingId } = useParams({ strict: false });

  return (
    <div className="px-4 py-4 pb-24 overflow-auto md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <PageHeader
          title={findingId ?? "Findings"}
          description={
            findingId
              ? undefined
              : "What was found, shipped and re-measured, by stage"
          }
          backLink={
            projectId && findingId ? (
              <BackLink to="/p/$projectId/findings" params={{ projectId }}>
                All findings
              </BackLink>
            ) : undefined
          }
        />

        <Outlet />
      </div>
    </div>
  );
}

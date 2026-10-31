import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { QueryState } from "@/client/components/QueryState";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getFinding,
  moveFindingStage,
  remeasureFinding,
} from "@/serverFunctions/findings";
import { FindingDetailView } from "./FindingDetailView";

export function FindingDetailPage({
  projectId,
  findingId,
}: {
  projectId: string;
  findingId: string;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["finding", projectId, findingId],
    queryFn: () => getFinding({ data: { projectId, id: findingId } }),
  });
  const onSuccess = (detail: Awaited<ReturnType<typeof getFinding>>) => {
    queryClient.setQueryData(["finding", projectId, findingId], detail);
    void queryClient.invalidateQueries({ queryKey: ["findings", projectId] });
  };
  const onError = (error: unknown) => {
    toast.error(getStandardErrorMessage(error));
    // A stage conflict means the page is stale.
    void query.refetch();
  };
  const move = useMutation({
    mutationFn: (input: {
      toStage: Parameters<typeof moveFindingStage>[0]["data"]["toStage"];
      note: string;
    }) => moveFindingStage({ data: { projectId, id: findingId, ...input } }),
    onSuccess,
    onError,
  });
  const remeasure = useMutation({
    mutationFn: () => remeasureFinding({ data: { projectId, id: findingId } }),
    onSuccess,
    onError,
  });

  return (
    <QueryState query={query} errorFallback="Could not load this finding.">
      {(detail) => (
        <FindingDetailView
          detail={detail}
          pending={move.isPending || remeasure.isPending}
          onMove={(toStage, note) => {
            // Re-measured is never a manual move; the control does not offer it.
            if (toStage !== "re_measured") move.mutate({ toStage, note });
          }}
          onRemeasure={() => remeasure.mutate()}
        />
      )}
    </QueryState>
  );
}

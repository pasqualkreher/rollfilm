// One canvas, opened for work: the editor owns the whole page. The photos it
// can draw come from the canvas's membership (plus anything already placed),
// so a frame never goes blind because the filmstrip was narrowed.
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { CanvasEditor } from "../components/CanvasEditor";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { collapsePairs } from "../state/viewPrefs";
import { useNavHistory } from "../state/navHistory";

export function CanvasDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { previousPath } = useNavHistory();
  // Back to the view - the same rule as the photo editor's (see leaveEditor
  // in ImageDetail). Came here from the view: step back to it, so the stack
  // reads list → view again and Forward can reopen the editor. Came here
  // straight from the list's pencil or a freshly made canvas: the view takes
  // the editor's slot, so Back from the view is the list - not the editor.
  const leaveEditor = () => {
    if (previousPath === `/canvas/${id}/view`) navigate(-1);
    else navigate(`/canvas/${id}/view`, { replace: true });
  };

  const { data: canvas } = useQuery({
    queryKey: ["canvas", id],
    queryFn: () => api.canvases.get(id!),
    enabled: !!id,
  });

  // Membership plus every placed photo, unfiltered and with pairs intact -
  // what frames resolve against. The strip collapses pairs like every grid.
  const { data: files, isLoading } = useQuery({
    queryKey: ["canvas-images", id],
    queryFn: () => api.canvases.images(id!),
    enabled: !!id,
  });

  if (!id) return null;
  return (
    <div className="canvas-workspace">
      <div className="page-scroll page-scroll--canvas">
        <ErrorBoundary what="The canvas">
          <CanvasEditor
            canvasId={id}
            title={canvas?.name ?? "Canvas"}
            onExit={leaveEditor}
            files={files ?? []}
            stripImages={collapsePairs(files ?? [])}
            imagesLoading={isLoading || !files}
            onMembershipChanged={() =>
              queryClient.invalidateQueries({ queryKey: ["canvas-images", id] })
            }
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}

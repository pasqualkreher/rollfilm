// One canvas, opened for LOOKING: the working layout exactly as the editor's
// print view shows it - same frames, crop-in-frame, borders and captions,
// the photos climbing to full resolution the same way - page by page, with
// nothing around it. Every way into a canvas lands here first - the card on
// the Canvas page, a canvas chip on a photo - and the pencil in the bottom
// bar hands over to the editor.
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ImageOut } from "../api/types";
import { PrintView } from "../components/CanvasEditor";
import { EMPTY_SHEET_DOC } from "../components/CanvasSheet";
import { errorText } from "../utils/apiError";

export function CanvasView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: canvas, error } = useQuery({
    queryKey: ["canvas", id],
    queryFn: () => api.canvases.get(id!),
    enabled: !!id,
    // The editor writes the layout this page shows: coming back from it must
    // show the saved state, not the summary cached on the way in.
    refetchOnMount: "always",
  });

  // A canvas never saved has no layout row: a blank page says "nothing on
  // it yet" more honestly than an error.
  const preview = canvas?.preview ?? EMPTY_SHEET_DOC;

  // The print view takes the editor's document: the preview dressed as a
  // full layout (the editing aids are irrelevant here), and just enough of
  // an ImageOut per photo to build the same derivative URLs the editor
  // builds - so a render the editor already decoded shows here at once.
  const doc = useMemo(
    () => ({
      page_mode: preview.page_mode,
      page_width_mm: preview.page_width_mm,
      page_height_mm: preview.page_height_mm,
      page_count: preview.page_count,
      background: preview.background,
      show_grid: false,
      grid_mm: 10,
      snap: true,
      margin_mm: 0,
      margin_y_mm: 0,
      show_page_guide: preview.show_page_guide,
      show_in_canvases: false,
      items: preview.items,
    }),
    [preview]
  );
  const byId = useMemo(() => {
    const map = new Map<string, ImageOut>();
    for (const [imageId, version] of Object.entries(preview.thumb_versions)) {
      map.set(imageId, { id: imageId, edit_rev: Number(version) || 0 } as unknown as ImageOut);
    }
    return map;
  }, [preview]);

  if (!id) return null;
  if (error) {
    return (
      <div className="page">
        <div className="empty-state">This canvas could not be opened: {errorText(error)}</div>
      </div>
    );
  }
  if (!canvas) return <div className="empty-state">Loading...</div>;

  return (
    <PrintView
      doc={doc}
      byId={byId}
      pageCount={doc.page_mode === "pages" ? Math.max(1, doc.page_count) : 1}
      start={0}
      title={canvas.name}
      caption={canvas.name}
      onClose={() => navigate("/canvas")}
      closeTitle="Back to the canvas list (Escape)"
      onEdit={() => navigate(`/canvas/${id}`)}
    />
  );
}

// The Canvas tab's front page: create a new canvas, open an existing one.
// Canvases are documents, not collections - they stand on their own, and
// photos reach them from the library's Select mode ("Add to canvas") or from
// the filmstrip inside the canvas itself.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { CanvasPreview, CanvasSummary } from "../api/types";
import { useAppDialogs } from "../components/AppDialogs";
import { shelfSheets, ShelfSheetItems, type CanvasSheetDoc } from "../components/CanvasSheet";
import { IconPencil, IconTrash } from "../components/Icons";
import { errorText } from "../utils/apiError";

// A blank white sheet for a canvas that has never been saved: an empty paper
// says "nothing on it yet" better than a card with no picture at all.
const EMPTY_SHEET: CanvasSheetDoc = {
  page_mode: "pages",
  page_width_mm: 297,
  page_height_mm: 210,
  page_count: 1,
  background: "#ffffff",
  show_page_guide: false,
  items: [],
  thumb_versions: {},
};

// The card's preview: the working layout's first sheet, drawn exactly like a
// Canvas Shelf card - the paper itself with the photos on it.
function CardPreview({ preview }: { preview: CanvasPreview | null }) {
  const doc = preview ?? EMPTY_SHEET;
  const sheet = shelfSheets(doc)[0];
  return (
    <div
      className="canvas-shelf-paper canvas-list-paper"
      style={{ background: doc.background, aspectRatio: `${sheet.w} / ${sheet.h}` }}
    >
      <ShelfSheetItems canvas={doc} sheet={sheet} />
    </div>
  );
}

function when(canvas: CanvasSummary): string {
  const stamp = canvas.updated_at ?? canvas.created_at;
  try {
    return new Date(stamp).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

export function Canvases() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const [name, setName] = useState("");

  const { data: canvases, isLoading } = useQuery({
    queryKey: ["canvas-list"],
    queryFn: () => api.canvases.list(),
  });

  const createCanvas = useMutation({
    mutationFn: () => api.canvases.create(name.trim() || "Canvas"),
    onSuccess: (created) => {
      setName("");
      queryClient.invalidateQueries({ queryKey: ["canvas-list"] });
      // Straight into the new canvas - an empty overview card teaches nothing.
      navigate(`/canvas/${created.id}`);
    },
    // Canvas names are unique - a taken name comes back as an error the user
    // has to read (the typed name stays in the box to adjust).
    onError: (e) => void dialogs.alert({ title: "Canvas not created", message: errorText(e) }),
  });

  async function renameCanvas(canvas: CanvasSummary) {
    // window.prompt is a no-op in Electron - the app-skinned dialog is the
    // only way to ask for a line of text here.
    const next = await dialogs.prompt({
      title: "Rename this canvas",
      initial: canvas.name,
      confirmLabel: "Rename",
    });
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === canvas.name) return;
    try {
      await api.canvases.rename(canvas.id, trimmed);
    } catch (e) {
      await dialogs.alert({ title: "Rename failed", message: errorText(e) });
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["canvas-list"] });
    queryClient.invalidateQueries({ queryKey: ["canvases"] });
  }

  async function deleteCanvas(canvas: CanvasSummary) {
    if (
      !(await dialogs.confirm({
        title: `Delete canvas “${canvas.name}”?`,
        message:
          "The design and all its saved versions are deleted. The photos stay in your library - including any virtual copies.",
        confirmLabel: "Delete canvas",
        danger: true,
      }))
    )
      return;
    await api.canvases.remove(canvas.id);
    queryClient.invalidateQueries({ queryKey: ["canvas-list"] });
    queryClient.invalidateQueries({ queryKey: ["canvases"] });
  }

  return (
    <div className="page">
      <h2 className="section-title">Canvas</h2>
      <p className="page-subtitle" style={{ color: "var(--text-muted)", marginTop: -8 }}>
        Free design surfaces: place photos by hand on pages or an endless sheet, save versions,
        print or export. Add photos from the library&rsquo;s Select mode.
      </p>

      <div className="album-create-row" style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <input
          type="text"
          placeholder="New canvas name"
          value={name}
          style={{ flex: 1 }}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") createCanvas.mutate();
          }}
        />
        <button className="btn primary" onClick={() => createCanvas.mutate()} disabled={createCanvas.isPending}>
          Create canvas
        </button>
      </div>

      {isLoading ? (
        <div className="empty-state">Loading...</div>
      ) : !canvases || canvases.length === 0 ? (
        <div className="empty-state">
          No canvases yet. Create one above, then select photos in the library and choose
          &ldquo;Add to canvas&rdquo;.
        </div>
      ) : (
        <div className="canvas-list">
          {canvases.map((canvas) => (
            <div
              key={canvas.id}
              className="canvas-list-card"
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/canvas/${canvas.id}`)}
              onKeyDown={(event) => {
                if (event.key === "Enter") navigate(`/canvas/${canvas.id}`);
              }}
            >
              <CardPreview preview={canvas.preview} />
              <div className="canvas-list-name">{canvas.name}</div>
              <div className="canvas-list-meta">
                {canvas.image_count} photo{canvas.image_count === 1 ? "" : "s"} ·{" "}
                {canvas.item_count} placed · {when(canvas)}
              </div>
              <div className="canvas-list-actions" onClick={(event) => event.stopPropagation()}>
                <button
                  className="btn btn-sm"
                  title="Rename this canvas"
                  onClick={() => void renameCanvas(canvas)}
                >
                  <IconPencil size={13} />
                </button>
                <button
                  className="btn btn-sm quiet-danger"
                  title="Delete this canvas - the photos stay in the library"
                  onClick={() => void deleteCanvas(canvas)}
                >
                  <IconTrash size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

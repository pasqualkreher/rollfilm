import { useState } from "react";
import { api, editVersion, saveDownload } from "../api/client";
import type { AlbumLayout, ImageOut } from "../api/types";
import { exportImages, exportSheets, renderLayoutHtml } from "../utils/canvasExport";
import { FilterChip } from "./FilterChip";

// The canvas's Export chip: PDF for printing, or one self-contained HTML file.
// Its own module because two places offer the same export: the canvas editor's
// toolbar, and the Canvas Shelf's read-only print view - one exporter, so the
// two can never drift apart.

// A layout document as the exports take it: the server's fields minus the two
// only it owns.
export type CanvasDoc = Omit<AlbumLayout, "album_id" | "updated_at">;

export function ExportChip({
  doc,
  byId,
  title,
}: {
  doc: CanvasDoc;
  byId: Map<string, ImageOut>;
  title: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const empty = doc.items.length === 0;
  const fileStem = (title.trim() || "Album").replace(/[\\/:*?"<>|]+/g, "-");
  const sheets = exportSheets(doc);
  const images = exportImages(doc, byId);
  // Absolute, because the document may be opened from a file or a blob URL
  // where a relative API path would point nowhere.
  const exportUrl = (image: ImageOut) =>
    new URL(api.images.exportUrl(image.id, editVersion(image)), window.location.href).toString();

  // Both exports close the panel once the file is out of the door - and only
  // then: a dismissed location picker or a failure leaves it open, with the
  // error where it can be read.
  async function toPdf(close: () => void) {
    setError(null);
    const sources = new Map(images.map((image) => [image.id, exportUrl(image)]));
    const desktop = window.photoManager?.exportPdf;
    if (desktop) {
      setBusy("Rendering the pages losslessly at full resolution - RAW and edited photos can take a minute each…");
      try {
        const result = await desktop({
          html: renderLayoutHtml(doc, sheets, sources, { title }),
          suggestedName: `${fileStem}.pdf`,
          widthMm: sheets[0].w,
          heightMm: sheets[0].h,
        });
        if (result.ok) close();
        else if (!result.canceled) setError(result.error ?? "The PDF could not be written.");
      } finally {
        setBusy(null);
      }
      return;
    }
    // Without the desktop shell the browser prints: the page opens in a tab,
    // loads its photos and then offers "Save as PDF" through the print dialog.
    const html = renderLayoutHtml(doc, sheets, sources, { title, autoPrint: true });
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    close();
  }

  async function toHtml(close: () => void) {
    setError(null);
    // saveDownload resolves quietly when the picker is dismissed; only a
    // file that was actually assembled counts as done.
    let written = false;
    try {
      await saveDownload(`${fileStem}.html`, { "text/html": [".html"] }, async () => {
        // Fetched one after another (see the note in the exported page's
        // script) and folded into the file, so it needs nothing but itself.
        const sources = new Map<string, string>();
        for (const [index, image] of images.entries()) {
          setBusy(`Rendering photo ${index + 1} of ${images.length} losslessly at full resolution…`);
          sources.set(image.id, await fetchDataUrl(exportUrl(image)));
        }
        setBusy("Writing the file…");
        written = true;
        return new Blob([renderLayoutHtml(doc, sheets, sources, { title })], { type: "text/html" });
      });
      if (written) close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <FilterChip
      label="Export"
      align="right"
      title="Save the layout as a PDF for printing, or as a web page"
    >
      {(close) => (
      <div className="canvas-panel">
        <div className="canvas-panel-row">
          <button className="btn" onClick={() => toPdf(close)} disabled={empty || busy !== null}>
            PDF for printing
          </button>
          <span className="canvas-panel-note">
            {sheets.length} {sheets.length === 1 ? "page" : "pages"} at {Math.round(sheets[0].w)}×
            {Math.round(sheets[0].h)} mm, photos lossless at full resolution, text as real text.
          </span>
        </div>
        <div className="canvas-panel-row">
          <button className="btn" onClick={() => toHtml(close)} disabled={empty || busy !== null}>
            Web page (HTML)
          </button>
          <span className="canvas-panel-note">
            One file with the photos inside it, lossless at full resolution - so it can run to
            hundreds of MB. Opens in any browser and prints from there - and can be handed to a
            print shop as is.
          </span>
        </div>
        {busy && <div className="canvas-panel-note canvas-export-busy">{busy}</div>}
        {error && <div className="canvas-panel-note canvas-export-error">{error}</div>}
        {empty && <div className="canvas-panel-note">Put something on the canvas first.</div>}
      </div>
      )}
    </FilterChip>
  );
}

// A photo's export pixels as a data URL, asked for again while the app is
// still rendering it (a 409 means a newer request superseded this one, a 503
// that the render slot is busy - both clear up by waiting).
async function fetchDataUrl(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url);
    if (response.ok) {
      const blob = await response.blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }
    if ((response.status !== 409 && response.status !== 503) || attempt >= 12) {
      throw new Error(`A photo could not be rendered (${response.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

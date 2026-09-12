// One sheet of a canvas document, drawn small from percent-positioned items:
// the renderer behind the Canvas page's cards - "the paper itself with the
// photos on it", at card size. The full-screen canvas view is the editor's
// own print view (CanvasEditor's PrintView), so it shows the real thing.
import { api, DEFAULT_EDIT_VERSION } from "../api/client";
import { boundsOf, PAGE_GAP_MM, worldRect } from "../utils/canvasLayout";
import type { LayoutItem } from "../api/types";

// Just enough of a canvas document to cut it into sheets and draw one:
// CanvasGalleryOut and CanvasSummary.preview both satisfy this shape.
export interface CanvasSheetDoc {
  page_mode: "pages" | "infinite";
  page_width_mm: number;
  page_height_mm: number;
  page_count: number;
  background: string;
  show_page_guide: boolean;
  items: LayoutItem[];
  // Per-photo cache-buster for thumbnail URLs (image id -> ?v value).
  thumb_versions: Record<string, string>;
}

// A blank white sheet for a canvas that has never been saved: an empty paper
// says "nothing on it yet" better than a card with no picture at all.
export const EMPTY_SHEET_DOC: CanvasSheetDoc = {
  page_mode: "pages",
  page_width_mm: 297,
  page_height_mm: 210,
  page_count: 1,
  background: "#ffffff",
  show_page_guide: false,
  items: [],
  thumb_versions: {},
};

export interface ShelfSheet {
  // The sheet's rectangle in world millimetres, and what is drawn on it.
  x: number;
  y: number;
  w: number;
  h: number;
  items: CanvasSheetDoc["items"];
}

// What "a sheet" is, exactly as the canvas's own print view cuts it: a page of
// a paged design; a sheet of the page guide on a free canvas that has one; and
// otherwise the free canvas cut to the work on it, with a little margin.
export function shelfSheets(canvas: CanvasSheetDoc): ShelfSheet[] {
  const w = canvas.page_width_mm;
  const h = canvas.page_height_mm;
  if (canvas.page_mode === "pages") {
    return Array.from({ length: Math.max(1, canvas.page_count) }, (_, page) => ({
      x: 0,
      y: 0,
      w,
      h,
      // Item coordinates are page-relative, so each sheet reads them as is.
      items: canvas.items.filter((item) => item.page === page),
    }));
  }
  const box = boundsOf(canvas.items.map((item) => worldRect(item, canvas)));
  if (canvas.show_page_guide) {
    const bottom = box ? box.y + box.h : 0;
    const count = Math.max(1, Math.ceil(bottom / (h + PAGE_GAP_MM)));
    return Array.from({ length: count }, (_, page) => ({
      x: 0,
      y: page * (h + PAGE_GAP_MM),
      w,
      h,
      items: canvas.items,
    }));
  }
  if (!box) return [{ x: 0, y: 0, w, h, items: [] }];
  const margin = 10;
  return [
    { x: box.x - margin, y: box.y - margin, w: box.w + margin * 2, h: box.h + margin * 2, items: canvas.items },
  ];
}

// The items of one sheet, percent-positioned, at card size.
export function ShelfSheetItems({ canvas, sheet }: { canvas: CanvasSheetDoc; sheet: ShelfSheet }) {
  return (
    <>
      {[...sheet.items]
        .sort((a, b) => a.z - b.z)
        .map((item) => {
          const box: React.CSSProperties = {
            left: `${((item.x_mm - sheet.x) / sheet.w) * 100}%`,
            top: `${((item.y_mm - sheet.y) / sheet.h) * 100}%`,
            width: `${(item.width_mm / sheet.w) * 100}%`,
            height: `${(item.height_mm / sheet.h) * 100}%`,
            transform: `rotate(${item.rotation}deg)`,
          };
          if (item.kind === "text" && item.text) {
            const style = item.style ?? {};
            return (
              <span
                key={item.id}
                className="canvas-shelf-text"
                style={{
                  ...box,
                  // cqw against the paper's width: the type keeps its size
                  // ON THE PAGE however small or large the page is drawn.
                  fontSize: `${((style.size_mm ?? 8) / sheet.w) * 100}cqw`,
                  color: style.color ?? "#111111",
                  fontWeight: style.weight ?? 600,
                  fontStyle: style.italic ? "italic" : undefined,
                  textAlign: style.align ?? "left",
                  fontFamily: style.font,
                  lineHeight: style.line_height ?? 1.25,
                }}
              >
                {item.text}
              </span>
            );
          }
          if (item.kind === "photo" && item.image_id && item.available !== false) {
            const version = canvas.thumb_versions[item.image_id] ?? DEFAULT_EDIT_VERSION;
            return (
              <img
                key={item.id}
                className="canvas-shelf-photo"
                style={box}
                src={api.images.thumbnailUrl(item.image_id, version, "small")}
                alt=""
                loading="lazy"
                draggable={false}
              />
            );
          }
          // A frame whose photo is in the Trash or on an unplugged drive
          // (or an empty text box): keep its footprint, quietly.
          return <span key={item.id} className="canvas-shelf-mark" style={box} />;
        })}
    </>
  );
}

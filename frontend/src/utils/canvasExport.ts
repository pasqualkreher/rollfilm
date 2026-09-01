// Turning an album's canvas into a document: one self-contained HTML page that
// draws every sheet at its real printed size, in millimetres, with the photos
// at full resolution. It is what the PDF is printed from and what the HTML
// export saves, so both come out of the same markup and cannot drift apart
// from each other - or from the canvas, whose geometry this mirrors.
//
// Knows nothing about React or the DOM it runs in: it returns a string.

import type { AlbumLayout, ImageOut, LayoutItem, LayoutTextStyle } from "../api/types";
import { PAGE_GAP_MM, boundsOf, pageOffsetMm, worldRect, type Rect } from "./canvasLayout";

type Doc = Omit<AlbumLayout, "album_id" | "updated_at">;

// Room left around the work when a free canvas without a page guide is
// exported: the sheet is cut to the content, plus this much on every side.
const FREE_MARGIN_MM = 10;

// The sheets the export is made of, in world millimetres. A book is its pages;
// a free canvas with the page guide on is the sheets the guide draws; a free
// canvas without one is a single sheet cut around whatever is on it.
export function exportSheets(doc: Doc): Rect[] {
  const w = doc.page_width_mm;
  const h = doc.page_height_mm;
  if (doc.page_mode === "pages") {
    return Array.from({ length: Math.max(1, doc.page_count) }, (_, page) => ({
      x: 0,
      y: pageOffsetMm(page, doc),
      w,
      h,
    }));
  }
  const content = boundsOf(doc.items.map((item) => worldRect(item, doc)));
  if (doc.show_page_guide) {
    const bottom = content ? content.y + content.h : 0;
    const count = Math.max(1, Math.ceil(bottom / (h + PAGE_GAP_MM)));
    return Array.from({ length: count }, (_, page) => ({ x: 0, y: pageOffsetMm(page, doc), w, h }));
  }
  if (!content) return [{ x: 0, y: 0, w, h }];
  return [
    {
      x: content.x - FREE_MARGIN_MM,
      y: content.y - FREE_MARGIN_MM,
      w: content.w + FREE_MARGIN_MM * 2,
      h: content.h + FREE_MARGIN_MM * 2,
    },
  ];
}

// The photos that are actually on the sheets, each once, in the order they
// are first met - the order the export fetches them in.
export function exportImages(doc: Doc, byId: Map<string, ImageOut>): ImageOut[] {
  const seen = new Set<string>();
  const images: ImageOut[] = [];
  for (const item of doc.items) {
    if (item.kind !== "photo" || !item.image_id || seen.has(item.image_id)) continue;
    const image = byId.get(item.image_id);
    if (!image || item.available === false) continue;
    seen.add(item.image_id);
    images.push(image);
  }
  return images;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mm(value: number): string {
  return `${Math.round(value * 1000) / 1000}mm`;
}

function textCss(style: LayoutTextStyle | null): string {
  const s = style ?? {};
  const valign = s.valign === "middle" ? "center" : s.valign === "bottom" ? "flex-end" : "flex-start";
  return [
    `font-size:${mm(s.size_mm ?? 8)}`,
    `color:${s.color ?? "#111111"}`,
    `font-weight:${s.weight ?? 600}`,
    `font-style:${s.italic ? "italic" : "normal"}`,
    `text-align:${s.align ?? "left"}`,
    s.font ? `font-family:${s.font}` : "",
    `line-height:${s.line_height ?? 1.25}`,
    `letter-spacing:${s.letter_spacing ?? 0}em`,
    `align-items:${valign}`,
  ]
    .filter(Boolean)
    .join(";");
}

function itemHtml(item: LayoutItem, sheet: Rect, doc: Doc, src: string | null): string {
  const rect = worldRect(item, doc);
  const box =
    `left:${mm(rect.x - sheet.x)};top:${mm(rect.y - sheet.y)};` +
    `width:${mm(rect.w)};height:${mm(rect.h)};` +
    `transform:rotate(${item.rotation}deg);z-index:${10 + item.z}`;
  if (item.kind === "text") {
    if (!item.text) return "";
    return `<div class="text" style="${escapeHtml(box + ";" + textCss(item.style))}"><div>${escapeHtml(item.text)}</div></div>`;
  }
  const pct = item.style?.frame_pct ?? 0;
  // The box wears the frame's colour too, so a sub-pixel seam between the
  // clipped picture and the shadow-drawn frame shows frame, not paper.
  const border =
    pct > 0
      ? `;box-shadow:0 0 0 ${mm((Math.min(item.width_mm, item.height_mm) * pct) / 100)} ${item.style?.frame_color ?? "#ffffff"}` +
        `;background:${item.style?.frame_color ?? "#ffffff"}`
      : "";
  const content = `translate(${item.content_dx * 100}%, ${item.content_dy * 100}%) scale(${item.content_scale})`;
  const picture = src
    ? `<img data-src="${escapeHtml(src)}" alt="" style="transform:${content}">`
    : `<div class="missing"></div>`;
  return `<div class="photo" style="${escapeHtml(box + border)}">${picture}</div>`;
}

export function renderLayoutHtml(
  doc: Doc,
  sheets: Rect[],
  sources: Map<string, string>,
  options: { title: string; autoPrint?: boolean }
): string {
  const first = sheets[0];
  const pages = sheets
    .map((sheet, index) => {
      const items = [...doc.items]
        .sort((a, b) => a.z - b.z)
        .filter((item) => {
          const r = worldRect(item, doc);
          // Anything touching the sheet is drawn on it; the sheet clips the
          // rest, so a photo across a gap appears cut at each page's edge,
          // exactly as it will be when the pages are trimmed.
          return r.x < sheet.x + sheet.w && r.x + r.w > sheet.x && r.y < sheet.y + sheet.h && r.y + r.h > sheet.y;
        })
        .map((item) => itemHtml(item, sheet, doc, item.image_id ? sources.get(item.image_id) ?? null : null))
        .join("");
      const last = index === sheets.length - 1 ? " last" : "";
      return `<section class="sheet${last}" style="width:${mm(sheet.w)};height:${mm(sheet.h)}">${items}</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(options.title)}</title>
<style>
  @page { size: ${mm(first.w)} ${mm(first.h)}; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { position: relative; overflow: hidden; background: ${doc.background}; break-after: page; page-break-after: always; }
  .sheet.last { break-after: auto; page-break-after: auto; }
  .photo { position: absolute; overflow: hidden; background: rgba(0,0,0,0.06); }
  .photo img { display: block; width: 100%; height: 100%; object-fit: cover; transform-origin: center center; }
  .photo .missing { width: 100%; height: 100%; background: repeating-linear-gradient(45deg, rgba(120,120,120,0.12), rgba(120,120,120,0.12) 2mm, transparent 2mm, transparent 4mm); }
  .text { position: absolute; display: flex; white-space: pre-wrap; overflow-wrap: break-word; }
  .text > div { width: 100%; }
  @media screen {
    body { background: #55575a; padding: 12mm 0; }
    .sheet { margin: 0 auto 12mm; box-shadow: 0 2mm 8mm rgba(0,0,0,0.35); }
    .sheet.last { margin-bottom: 0; }
  }
</style>
</head>
<body>
${pages}
<script>
(async () => {
  // The photos load ONE AT A TIME. Each is rendered on demand by the app at
  // full resolution, and a request that arrives while another is still
  // rendering supersedes it - so firing them all at once would leave most of
  // the pages empty. A photo that is not ready yet is asked for again.
  const images = Array.from(document.querySelectorAll("img[data-src]"));
  for (const img of images) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const ok = await new Promise((resolve) => {
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = img.dataset.src + (attempt ? "&retry=" + attempt : "");
      });
      if (ok) break;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    img.removeAttribute("data-src");
  }
  window.__rollfilmExportReady = true;
  document.title += " · ready";
  ${options.autoPrint ? "setTimeout(() => window.print(), 250);" : ""}
})();
</script>
</body>
</html>`;
}

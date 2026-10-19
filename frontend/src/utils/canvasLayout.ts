// Geometry for an album's creative canvas. Everything here works in
// MILLIMETRES - the unit the layout is stored in - and knows nothing about
// React or the DOM, so the editor component stays about interaction.
//
// One coordinate space runs through the whole canvas: pages are stacked down
// the y axis with a fixed gap, so an item's "world" position is its position
// on its page plus that page's offset. Dragging a photo from one sheet to the
// next is then just a move, and hit-testing never has to ask which page it is
// looking at.

import type { CanvasLayout, LayoutItem } from "../api/types";

// Gap between two sheets, in mm. Wide enough to read as a break between pages
// at any zoom without wasting the screen.
export const PAGE_GAP_MM = 20;

// The page shapes on offer. "Custom" in the toolbar frees the numbers
// entirely, so this is a starting point rather than a limit.
// Every size once, in landscape (w >= h); the page setup's Landscape/Portrait
// switch turns it. Groups keep the menu readable: paper, the photo-book sizes
// the big book printers share (compact to XL and the squares), lab prints.
export type PagePresetGroup = "Paper" | "Photo books" | "Prints";

export interface PagePreset {
  key: string;
  label: string;
  w: number;
  h: number;
  group: PagePresetGroup;
}

export const PAGE_PRESETS: readonly PagePreset[] = [
  { key: "a3", label: "A3", w: 420, h: 297, group: "Paper" },
  { key: "a4", label: "A4", w: 297, h: 210, group: "Paper" },
  { key: "a5", label: "A5", w: 210, h: 148, group: "Paper" },
  { key: "letter", label: "US Letter", w: 279.4, h: 215.9, group: "Paper" },
  { key: "tabloid", label: "US Tabloid", w: 431.8, h: 279.4, group: "Paper" },
  { key: "book-19x15", label: "Compact 19×15 cm", w: 190, h: 150, group: "Photo books" },
  { key: "book-25x20", label: "Standard 25×20 cm", w: 254, h: 203, group: "Photo books" },
  { key: "book-28x21", label: "Large 28×21 cm", w: 280, h: 210, group: "Photo books" },
  { key: "book-33x28", label: "Large 33×28 cm", w: 330, h: 279, group: "Photo books" },
  { key: "book-38x29", label: "XL 38×29 cm", w: 380, h: 290, group: "Photo books" },
  { key: "square-18", label: "Square 18×18 cm", w: 178, h: 178, group: "Photo books" },
  { key: "square-21", label: "Square 21×21 cm", w: 210, h: 210, group: "Photo books" },
  { key: "square-30", label: "Square 30×30 cm", w: 300, h: 300, group: "Photo books" },
  { key: "print-9x13", label: "9×13 cm", w: 127, h: 89, group: "Prints" },
  { key: "print-10x15", label: "10×15 cm", w: 152, h: 102, group: "Prints" },
  { key: "print-13x18", label: "13×18 cm", w: 178, h: 127, group: "Prints" },
  { key: "print-20x30", label: "20×30 cm", w: 305, h: 203, group: "Prints" },
  { key: "print-30x45", label: "30×45 cm", w: 457, h: 305, group: "Prints" },
  { key: "print-8x10in", label: "8×10 in", w: 254, h: 203, group: "Prints" },
  { key: "print-11x14in", label: "11×14 in", w: 356, h: 279, group: "Prints" },
  { key: "print-16x20in", label: "16×20 in", w: 508, h: 406, group: "Prints" },
];

export const PAGE_PRESET_GROUPS: readonly PagePresetGroup[] = ["Paper", "Photo books", "Prints"];

// Which preset a page is, in either orientation, and whether it is turned.
export function matchPagePreset(w: number, h: number): { preset: PagePreset; portrait: boolean } | null {
  const same = (a: number, b: number) => Math.abs(a - b) < 0.05;
  for (const preset of PAGE_PRESETS) {
    if (same(preset.w, w) && same(preset.h, h)) return { preset, portrait: false };
    if (same(preset.h, w) && same(preset.w, h)) return { preset, portrait: true };
  }
  return null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Where a page's top-left corner sits in world coordinates.
export function pageOffsetMm(page: number, layout: PageBox): number {
  return page * (layout.page_height_mm + PAGE_GAP_MM);
}

// Which sheet a world y belongs to. Clamped to the pages that exist, so an
// item dragged into the gap below the last page lands on it rather than on a
// page that isn't there.
export function pageAtMm(worldY: number, layout: PageBox, pageCount: number): number {
  if (layout.page_mode === "infinite") return 0;
  const stride = layout.page_height_mm + PAGE_GAP_MM;
  return Math.max(0, Math.min(pageCount - 1, Math.floor(worldY / stride)));
}

// The margins are optional because read-only consumers (the shelf's gallery
// docs) don't carry them - only the editor, which snaps and flows, does.
// margin_mm is left/right, margin_y_mm top/bottom.
export type PageBox = Pick<CanvasLayout, "page_mode" | "page_width_mm" | "page_height_mm"> & {
  margin_mm?: number;
  margin_y_mm?: number;
};

// The page margins on each axis, in mm: x for left and right, y for top and
// bottom. Older documents carry a single margin, which then serves both.
export interface Margins {
  x: number;
  y: number;
}

// An item's frame in world coordinates (page offset folded in).
export function worldRect(item: LayoutItem, layout: PageBox): Rect {
  return {
    x: item.x_mm,
    y: item.y_mm + pageOffsetMm(item.page, layout),
    w: item.width_mm,
    h: item.height_mm,
  };
}

// The topmost photo frame under a world point, if any - for dropping one photo
// onto another. The point is turned back by the frame's rotation around its
// centre, so a tilted frame is hit where it is drawn. `skip` leaves out the
// frames being dragged, which are the ones under the pointer by definition.
export function photoItemAt(
  x: number,
  y: number,
  items: LayoutItem[],
  layout: PageBox,
  skip: Set<string>
): { item: LayoutItem; inner: boolean } | null {
  const candidates = items
    .filter((item) => item.kind === "photo" && !skip.has(item.id))
    .sort((a, b) => b.z - a.z);
  for (const item of candidates) {
    const rect = worldRect(item, layout);
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const a = (-item.rotation * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(lx) <= rect.w / 2 && Math.abs(ly) <= rect.h / 2) {
      // The inner half of the frame, each way: the swap zone.
      return { item, inner: Math.abs(lx) <= rect.w / 4 && Math.abs(ly) <= rect.h / 4 };
    }
  }
  return null;
}

// --- Dropping a photo onto a page ------------------------------------------
//
// A photo dropped from the filmstrip takes the free space where it lands: the
// largest empty rectangle around the pointer inside the page's margins and
// clear of the other frames by `gapMm`, and the photo fitted into it. That is
// the frame the user would have dragged out by hand on an empty or half-empty
// page. With the grid on, the frame sits on the grid (edges in, so it never
// crosses a neighbour). Null when the pointer is over a frame or the hole is
// too small to be worth it - the caller then drops the usual default frame.

// Below this on either side the fitted frame would be a sliver.
const MIN_FIT_MM = 25;

export interface DropFit {
  gapMm: number;
  gridMm: number | null;
}

export function fitDropFrame(
  point: { x: number; y: number },
  aspect: number,
  box: Rect,
  obstacles: Rect[],
  { gapMm, gridMm }: DropFit
): Rect | null {
  const blocks = obstacles.map((r) => ({
    x: r.x - gapMm,
    y: r.y - gapMm,
    w: r.w + 2 * gapMm,
    h: r.h + 2 * gapMm,
  }));
  const inside = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  if (!inside(box, point)) return null;
  if (blocks.some((b) => inside(b, point))) return null;

  // Candidate x-edges: the box and every block's sides. For each span of
  // them around the point, the blocks that reach into the span bound the
  // height: the lowest bottom above the point, the highest top below it (a
  // block that covers the point's own row rules the span out). That is the
  // tallest empty rectangle of that width around the point, so the biggest
  // over all spans is the biggest there is - in O(edges² · blocks), which
  // runs under every pointer move without being felt.
  const xs = [...new Set([box.x, box.x + box.w, ...blocks.flatMap((b) => [b.x, b.x + b.w])])]
    .filter((v) => v >= box.x && v <= box.x + box.w)
    .sort((a, b) => a - b);
  let best: Rect | null = null;
  for (const x1 of xs) {
    if (x1 > point.x) break;
    for (const x2 of xs) {
      if (x2 < point.x || x2 <= x1) continue;
      let top = box.y;
      let bottom = box.y + box.h;
      let blocked = false;
      for (const b of blocks) {
        if (b.x >= x2 - 1e-6 || b.x + b.w <= x1 + 1e-6) continue; // beside the span
        if (b.y + b.h <= point.y) top = Math.max(top, b.y + b.h);
        else if (b.y >= point.y) bottom = Math.min(bottom, b.y);
        else {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      const r = { x: x1, y: top, w: x2 - x1, h: bottom - top };
      if (!best || r.w * r.h > best.w * best.h) best = r;
    }
  }
  if (!best || best.w < MIN_FIT_MM || best.h < MIN_FIT_MM) return null;

  // On the grid: pull the hole's edges inward to grid lines first.
  let hole = best;
  if (gridMm && gridMm > 0) {
    const x1 = Math.ceil(hole.x / gridMm - 1e-6) * gridMm;
    const y1 = Math.ceil(hole.y / gridMm - 1e-6) * gridMm;
    const x2 = Math.floor((hole.x + hole.w) / gridMm + 1e-6) * gridMm;
    const y2 = Math.floor((hole.y + hole.h) / gridMm + 1e-6) * gridMm;
    if (x2 - x1 < MIN_FIT_MM || y2 - y1 < MIN_FIT_MM) return null;
    hole = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  // Fit the photo's shape into the hole.
  let w = hole.w;
  let h = w / aspect;
  if (h > hole.h) {
    h = hole.h;
    w = h * aspect;
  }
  if (gridMm && gridMm > 0) {
    // Frame sides on the grid, as close to the photo's shape as the grid
    // allows (the photo covers the frame, so a little crop is fine).
    w = Math.max(gridMm, Math.round(w / gridMm) * gridMm);
    h = Math.max(gridMm, Math.round(h / gridMm) * gridMm);
    if (w > hole.w) w = Math.floor(hole.w / gridMm) * gridMm;
    if (h > hole.h) h = Math.floor(hole.h / gridMm) * gridMm;
    // Rounding cannot turn a photo, but it can square a nearly square one.
    // A photo that is not square keeps a long side: that side grows a step
    // if the hole allows, otherwise the short side gives one.
    if (Math.abs(aspect - 1) > 1e-6 && w === h) {
      const wide = aspect > 1;
      if (wide && w + gridMm <= hole.w + 1e-6) w += gridMm;
      else if (!wide && h + gridMm <= hole.h + 1e-6) h += gridMm;
      else if (wide && h - gridMm >= gridMm) h -= gridMm;
      else if (!wide && w - gridMm >= gridMm) w -= gridMm;
    }
  }

  // Where in the hole: centred across the axis it fills; along the axis with
  // room, as close to the pointer as the hole allows, so the frame lands where
  // the photo was let go.
  const place = (lo: number, size: number, span: number, at: number) => {
    const slack = span - size;
    if (slack <= 1e-6) return lo;
    let v = at - size / 2;
    v = Math.max(lo, Math.min(lo + slack, v));
    if (gridMm && gridMm > 0) v = Math.max(lo, Math.min(lo + slack, Math.round(v / gridMm) * gridMm));
    return v;
  };
  return { x: place(hole.x, w, hole.w, point.x), y: place(hole.y, h, hole.h, point.y), w, h };
}

// The biggest frame a photo can get anywhere on a page: fitDropFrame tried
// from a lattice of points over the box, the largest result kept. For a photo
// sent to a page without a pointer position (dropped on the page's card).
export function fitAnywhere(aspect: number, box: Rect, obstacles: Rect[], fit: DropFit): Rect | null {
  let best: Rect | null = null;
  const steps = 7;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const point = { x: box.x + (box.w * i) / steps, y: box.y + (box.h * j) / steps };
      const r = fitDropFrame(point, aspect, box, obstacles, fit);
      if (r && (!best || r.w * r.h > best.w * best.h)) best = r;
    }
  }
  return best;
}

// Scale a rect down about its centre until it meets no obstacle and, when a
// box is given, lies inside it. Factor 1 when nothing is in the way. For a
// frame that just took another shape (a swap) and must not land on a
// neighbour or over the margin.
export function shrinkToFit(rect: Rect, obstacles: Rect[], box: Rect | null): Rect {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const at = (f: number): Rect => ({ x: cx - (rect.w * f) / 2, y: cy - (rect.h * f) / 2, w: rect.w * f, h: rect.h * f });
  const clear = (r: Rect) =>
    (!box || (r.x >= box.x - 1e-6 && r.y >= box.y - 1e-6 && r.x + r.w <= box.x + box.w + 1e-6 && r.y + r.h <= box.y + box.h + 1e-6)) &&
    !obstacles.some((o) => o.x < r.x + r.w - 1e-6 && o.x + o.w > r.x + 1e-6 && o.y < r.y + r.h - 1e-6 && o.y + o.h > r.y + 1e-6);
  if (clear(rect)) return rect;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (clear(at(mid))) lo = mid;
    else hi = mid;
  }
  return at(lo);
}

export function boundsOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// --- Snapping ---------------------------------------------------------------
//
// A canvas without snapping is a canvas where nothing ever quite lines up: by
// hand you can get two photos within half a millimetre of each other and the
// print will still show the step. Edges and centres snap to the page and to
// the other items on the same page, and every snap that fires draws the line
// it snapped to, so the user can see WHY it moved.

export interface Guide {
  // A guide is a full-length line across the page in one axis.
  axis: "x" | "y";
  at: number;
  // The span the line is drawn over (world mm), so it reaches from the moving
  // item to whatever it lined up with instead of crossing the whole canvas.
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

interface SnapTarget {
  at: number;
  from: number;
  to: number;
}

function candidates(rect: Rect, axis: "x" | "y"): number[] {
  return axis === "x"
    ? [rect.x, rect.x + rect.w / 2, rect.x + rect.w]
    : [rect.y, rect.y + rect.h / 2, rect.y + rect.h];
}

// Snap one axis: try each of the given lines of the moving box against every
// target line, keep the closest hit inside the threshold. `values` are the
// box's own lines that may move - all three for a move, only the dragged edge
// for a resize.
function snapAxis(
  values: number[],
  moving: Rect,
  targets: SnapTarget[],
  axis: "x" | "y",
  threshold: number
): { delta: number; guide: Guide | null } {
  let best: { delta: number; guide: Guide | null } = { delta: 0, guide: null };
  let bestDistance = threshold;
  for (const value of values) {
    for (const target of targets) {
      const distance = Math.abs(target.at - value);
      if (distance > bestDistance) continue;
      bestDistance = distance;
      const span =
        axis === "x"
          ? { from: Math.min(target.from, moving.y), to: Math.max(target.to, moving.y + moving.h) }
          : { from: Math.min(target.from, moving.x), to: Math.max(target.to, moving.x + moving.w) };
      best = {
        delta: target.at - value,
        guide: { axis, at: target.at, from: span.from, to: span.to },
      };
    }
  }
  return best;
}

// Lines worth snapping to: the page box and its centres, plus the edges and
// centres of every other item on the pages the moving box touches.
export function snapTargets(
  others: Rect[],
  layout: PageBox,
  pageCount: number,
  moving: Rect,
  // Also offer each neighbour's edges one layout gap out, so a frame can be
  // set beside another at the same distance the auto layouts use, not only
  // flush against it.
  gapMm = 0
): { x: SnapTarget[]; y: SnapTarget[] } {
  const x: SnapTarget[] = [];
  const y: SnapTarget[] = [];
  if (layout.page_mode === "pages") {
    const first = pageAtMm(moving.y, layout, pageCount);
    const last = pageAtMm(moving.y + moving.h, layout, pageCount);
    // The page margins are lines you lay things out AGAINST, so they snap
    // like the page edges do. Only a real margin: at 0 the lines would double
    // the edges.
    const marginX = Math.max(0, layout.margin_mm ?? 0);
    const marginY = Math.max(0, layout.margin_y_mm ?? layout.margin_mm ?? 0);
    for (let page = first; page <= last; page++) {
      const top = pageOffsetMm(page, layout);
      const bottom = top + layout.page_height_mm;
      x.push(
        { at: 0, from: top, to: bottom },
        { at: layout.page_width_mm / 2, from: top, to: bottom },
        { at: layout.page_width_mm, from: top, to: bottom }
      );
      y.push(
        { at: top, from: 0, to: layout.page_width_mm },
        { at: (top + bottom) / 2, from: 0, to: layout.page_width_mm },
        { at: bottom, from: 0, to: layout.page_width_mm }
      );
      if (marginX > 0 && marginX < layout.page_width_mm / 2) {
        x.push(
          { at: marginX, from: top, to: bottom },
          { at: layout.page_width_mm - marginX, from: top, to: bottom }
        );
      }
      if (marginY > 0 && marginY < layout.page_height_mm / 2) {
        y.push(
          { at: top + marginY, from: 0, to: layout.page_width_mm },
          { at: bottom - marginY, from: 0, to: layout.page_width_mm }
        );
      }
    }
  }
  for (const rect of others) {
    for (const at of candidates(rect, "x")) x.push({ at, from: rect.y, to: rect.y + rect.h });
    for (const at of candidates(rect, "y")) y.push({ at, from: rect.x, to: rect.x + rect.w });
    if (gapMm > 0) {
      x.push({ at: rect.x - gapMm, from: rect.y, to: rect.y + rect.h }, { at: rect.x + rect.w + gapMm, from: rect.y, to: rect.y + rect.h });
      y.push({ at: rect.y - gapMm, from: rect.x, to: rect.x + rect.w }, { at: rect.y + rect.h + gapMm, from: rect.x, to: rect.x + rect.w });
    }
  }
  return { x, y };
}

// Adjust a proposed move so the box lands on a guide, on the grid, or neither.
export function snapMove(
  moving: Rect,
  others: Rect[],
  layout: PageBox,
  pageCount: number,
  options: { threshold: number; grid: number | null; gapMm?: number }
): SnapResult {
  const targets = snapTargets(others, layout, pageCount, moving, options.gapMm ?? 0);
  const x = snapAxis(candidates(moving, "x"), moving, targets.x, "x", options.threshold);
  const y = snapAxis(candidates(moving, "y"), moving, targets.y, "y", options.threshold);
  const guides = [x.guide, y.guide].filter((g): g is Guide => g !== null);
  let { delta: dx } = x;
  let { delta: dy } = y;
  // The grid only gets a say where nothing better lined up, so a photo that
  // could sit flush with its neighbour isn't pulled off it by a grid line.
  if (options.grid) {
    if (!x.guide) dx = Math.round(moving.x / options.grid) * options.grid - moving.x;
    if (!y.guide) dy = Math.round(moving.y / options.grid) * options.grid - moving.y;
  }
  return { dx, dy, guides };
}

// Which edges a resize handle drags: the west or east edge in x, the north or
// south edge in y, or neither on that axis for a side handle.
export interface ResizeEdges {
  x: "w" | "e" | null;
  y: "n" | "s" | null;
}

// Adjust a resize so the edge being dragged lands on a guide or the grid.
// Unlike a move, ONLY that edge is a candidate: the opposite edge and the
// centre are pinned by the handle, and snapping them would have shifted the
// dragged edge by the wrong amount and drawn the line where nothing was
// moving. dx/dy are what to add to the dragged edge's position.
export function snapResize(
  moving: Rect,
  edges: ResizeEdges,
  others: Rect[],
  layout: PageBox,
  pageCount: number,
  options: { threshold: number; grid: number | null; gapMm?: number }
): SnapResult {
  const targets = snapTargets(others, layout, pageCount, moving, options.gapMm ?? 0);
  const none = { delta: 0, guide: null };
  const xAt = edges.x === "w" ? moving.x : edges.x === "e" ? moving.x + moving.w : null;
  const yAt = edges.y === "n" ? moving.y : edges.y === "s" ? moving.y + moving.h : null;
  const x = xAt === null ? none : snapAxis([xAt], moving, targets.x, "x", options.threshold);
  const y = yAt === null ? none : snapAxis([yAt], moving, targets.y, "y", options.threshold);
  const guides = [x.guide, y.guide].filter((g): g is Guide => g !== null);
  let { delta: dx } = x;
  let { delta: dy } = y;
  if (options.grid) {
    if (xAt !== null && !x.guide) dx = Math.round(xAt / options.grid) * options.grid - xAt;
    if (yAt !== null && !y.guide) dy = Math.round(yAt / options.grid) * options.grid - yAt;
  }
  return { dx, dy, guides };
}

// --- Frames and their photos ------------------------------------------------

// How far the photo inside a frame may be shifted before a gap would show at
// the edge, as a fraction of the frame's own width/height. The photo is scaled
// to COVER the frame first, so at scale 1 an aspect mismatch already leaves
// room to slide along the longer axis - which is exactly the crop handle the
// user reaches for.
export function contentTravel(
  frameAspect: number,
  imageAspect: number | null,
  scale: number
): { x: number; y: number } {
  if (!imageAspect || !isFinite(imageAspect) || imageAspect <= 0) {
    // Unknown photo shape: allow the plain zoom overflow and no more.
    const room = Math.max(0, (scale - 1) / 2);
    return { x: room, y: room };
  }
  const wider = imageAspect > frameAspect;
  const x = wider ? (scale * (imageAspect / frameAspect) - 1) / 2 : (scale - 1) / 2;
  const y = wider ? (scale - 1) / 2 : (scale * (frameAspect / imageAspect) - 1) / 2;
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

export function clampContent(item: LayoutItem, imageAspect: number | null): LayoutItem {
  const travel = contentTravel(item.width_mm / item.height_mm, imageAspect, item.content_scale);
  const dx = Math.max(-travel.x, Math.min(travel.x, item.content_dx));
  const dy = Math.max(-travel.y, Math.min(travel.y, item.content_dy));
  if (dx === item.content_dx && dy === item.content_dy) return item;
  return { ...item, content_dx: dx, content_dy: dy };
}

// --- Auto layout ------------------------------------------------------------

export interface FlowPhoto {
  id: string;
  aspect: number;
}

// Fill pages with a plain grid of frames - the starting point nobody wants to
// place by hand. Each frame takes the photo's own shape where it fits the
// cell, so the first look at a canvas is already the album, not a wall of
// identical squares.
export function autoFlow(
  photos: FlowPhoto[],
  layout: PageBox,
  options: { columns: number; margin: Margins; gapMm: number; startZ: number }
): { items: Omit<LayoutItem, "id">[]; pages: number } {
  const { columns, margin, gapMm, startZ } = options;
  const usableWidth = layout.page_width_mm - margin.x * 2;
  const cellWidth = (usableWidth - gapMm * (columns - 1)) / columns;
  // Square cells keep the maths honest across mixed orientations; a portrait
  // photo simply doesn't fill its cell's width.
  const cellHeight = cellWidth;
  const rowsPerPage =
    layout.page_mode === "infinite"
      ? Math.max(1, columns)
      : Math.max(1, Math.floor((layout.page_height_mm - margin.y * 2 + gapMm) / (cellHeight + gapMm)));
  const perPage = columns * rowsPerPage;

  const items: Omit<LayoutItem, "id">[] = [];
  photos.forEach((photo, index) => {
    const page = layout.page_mode === "infinite" ? 0 : Math.floor(index / perPage);
    const slot = layout.page_mode === "infinite" ? index : index % perPage;
    const column = slot % columns;
    const row = Math.floor(slot / columns);
    // Fit the photo's own shape inside the cell.
    const aspect = photo.aspect > 0 ? photo.aspect : 1.5;
    const width = aspect >= 1 ? cellWidth : cellHeight * aspect;
    const height = aspect >= 1 ? cellWidth / aspect : cellHeight;
    const cellX = margin.x + column * (cellWidth + gapMm);
    const cellY = margin.y + row * (cellHeight + gapMm);
    items.push({
      kind: "photo",
      image_id: photo.id,
      page,
      x_mm: cellX + (cellWidth - width) / 2,
      y_mm: cellY + (cellHeight - height) / 2,
      width_mm: width,
      height_mm: height,
      rotation: 0,
      z: startZ + index,
      content_scale: 1,
      content_dx: 0,
      content_dy: 0,
      text: null,
      style: null,
    });
  });
  const pages = items.length === 0 ? 1 : Math.max(...items.map((i) => i.page)) + 1;
  return { items, pages };
}

// A free spot for one new frame: walk the page's occupied rows and drop it
// below them, so clicking a photo into the canvas never buries it under the
// last one.
export function nextFreeSpot(
  existing: Rect[],
  layout: PageBox,
  size: { w: number; h: number },
  margin: Margins
): { x: number; y: number } {
  const bottom = existing.length ? Math.max(...existing.map((r) => r.y + r.h)) : margin.y;
  const y = existing.length ? bottom + 5 : margin.y;
  const maxY =
    layout.page_mode === "pages" ? layout.page_height_mm - size.h - margin.y : Number.POSITIVE_INFINITY;
  return {
    x: Math.max(margin.x, (layout.page_width_mm - size.w) / 2),
    y: Math.max(margin.y, Math.min(y, maxY)),
  };
}

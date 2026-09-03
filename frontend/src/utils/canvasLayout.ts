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

// The page shapes on offer. Free sizes are typed in as numbers, so this is a
// starting point rather than a limit.
export const PAGE_PRESETS = [
  { key: "a4-landscape", label: "A4 landscape", w: 297, h: 210 },
  { key: "a4-portrait", label: "A4 portrait", w: 210, h: 297 },
  { key: "a3-landscape", label: "A3 landscape", w: 420, h: 297 },
  { key: "square-300", label: "Square 30cm", w: 300, h: 300 },
  { key: "square-210", label: "Square 21cm", w: 210, h: 210 },
  { key: "photo-book", label: "Photo book 28×21", w: 280, h: 210 },
] as const;

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

export type PageBox = Pick<CanvasLayout, "page_mode" | "page_width_mm" | "page_height_mm">;

// An item's frame in world coordinates (page offset folded in).
export function worldRect(item: LayoutItem, layout: PageBox): Rect {
  return {
    x: item.x_mm,
    y: item.y_mm + pageOffsetMm(item.page, layout),
    w: item.width_mm,
    h: item.height_mm,
  };
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
  moving: Rect
): { x: SnapTarget[]; y: SnapTarget[] } {
  const x: SnapTarget[] = [];
  const y: SnapTarget[] = [];
  if (layout.page_mode === "pages") {
    const first = pageAtMm(moving.y, layout, pageCount);
    const last = pageAtMm(moving.y + moving.h, layout, pageCount);
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
    }
  }
  for (const rect of others) {
    for (const at of candidates(rect, "x")) x.push({ at, from: rect.y, to: rect.y + rect.h });
    for (const at of candidates(rect, "y")) y.push({ at, from: rect.x, to: rect.x + rect.w });
  }
  return { x, y };
}

// Adjust a proposed move so the box lands on a guide, on the grid, or neither.
export function snapMove(
  moving: Rect,
  others: Rect[],
  layout: PageBox,
  pageCount: number,
  options: { threshold: number; grid: number | null }
): SnapResult {
  const targets = snapTargets(others, layout, pageCount, moving);
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
  options: { threshold: number; grid: number | null }
): SnapResult {
  const targets = snapTargets(others, layout, pageCount, moving);
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
  options: { columns: number; marginMm: number; gapMm: number; startZ: number }
): { items: Omit<LayoutItem, "id">[]; pages: number } {
  const { columns, marginMm, gapMm, startZ } = options;
  const usableWidth = layout.page_width_mm - marginMm * 2;
  const cellWidth = (usableWidth - gapMm * (columns - 1)) / columns;
  // Square cells keep the maths honest across mixed orientations; a portrait
  // photo simply doesn't fill its cell's width.
  const cellHeight = cellWidth;
  const rowsPerPage =
    layout.page_mode === "infinite"
      ? Math.max(1, columns)
      : Math.max(1, Math.floor((layout.page_height_mm - marginMm * 2 + gapMm) / (cellHeight + gapMm)));
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
    const cellX = marginMm + column * (cellWidth + gapMm);
    const cellY = marginMm + row * (cellHeight + gapMm);
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
  marginMm: number
): { x: number; y: number } {
  const bottom = existing.length ? Math.max(...existing.map((r) => r.y + r.h)) : marginMm;
  const y = existing.length ? bottom + 5 : marginMm;
  const maxY =
    layout.page_mode === "pages" ? layout.page_height_mm - size.h - marginMm : Number.POSITIVE_INFINITY;
  return {
    x: Math.max(marginMm, (layout.page_width_mm - size.w) / 2),
    y: Math.max(marginMm, Math.min(y, maxY)),
  };
}

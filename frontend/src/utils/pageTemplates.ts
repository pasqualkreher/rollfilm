// One page, laid out from a handful of photos that belong together: the
// canvas's Auto-arrange. No fixed templates - the page is set in justified
// rows or columns (every photo keeps its own shape, the row fills the width),
// and of the few ways to split the photos into rows the one that covers the
// most paper wins. "One big, two small" simply falls out of that where the
// shapes allow it.
import type { LayoutItem } from "../api/types";
import type { FlowPhoto, Margins, PageBox } from "./canvasLayout";

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Every way to split n photos into up to three bands of up to three.
function splits(n: number): number[][] {
  const out: number[][] = [];
  const walk = (left: number, acc: number[]) => {
    if (left === 0) {
      out.push(acc);
      return;
    }
    if (acc.length === 3) return;
    for (let part = 1; part <= Math.min(3, left); part++) walk(left - part, [...acc, part]);
  };
  walk(n, []);
  return out;
}

// Rows across the page: each row as high as it must be to fill the width,
// the stack scaled down and centred if it would run past the bottom.
function rowsLayout(aspects: number[], bands: number[], W: number, H: number, gap: number): Frame[] {
  const rows: number[][] = [];
  let at = 0;
  for (const count of bands) {
    rows.push(aspects.slice(at, at + count));
    at += count;
  }
  const heights = rows.map((row) => (W - gap * (row.length - 1)) / row.reduce((s, a) => s + a, 0));
  const total = heights.reduce((s, h) => s + h, 0) + gap * (rows.length - 1);
  const scale = total > H ? (H - gap * (rows.length - 1)) / (total - gap * (rows.length - 1)) : 1;
  const frames: Frame[] = [];
  const stackHeight = heights.reduce((s, h) => s + h * scale, 0) + gap * (rows.length - 1);
  let y = (H - stackHeight) / 2;
  rows.forEach((row, r) => {
    const h = heights[r] * scale;
    const rowWidth = row.reduce((s, a) => s + a * h, 0) + gap * (row.length - 1);
    let x = (W - rowWidth) / 2;
    for (const a of row) {
      frames.push({ x, y, w: a * h, h });
      x += a * h + gap;
    }
    y += h + gap;
  });
  return frames;
}

// Columns down the page: the same idea turned on its side.
function columnsLayout(aspects: number[], bands: number[], W: number, H: number, gap: number): Frame[] {
  const cols: number[][] = [];
  let at = 0;
  for (const count of bands) {
    cols.push(aspects.slice(at, at + count));
    at += count;
  }
  const widths = cols.map((col) => (H - gap * (col.length - 1)) / col.reduce((s, a) => s + 1 / a, 0));
  const total = widths.reduce((s, w) => s + w, 0) + gap * (cols.length - 1);
  const scale = total > W ? (W - gap * (cols.length - 1)) / (total - gap * (cols.length - 1)) : 1;
  const frames: Frame[] = [];
  const runWidth = widths.reduce((s, w) => s + w * scale, 0) + gap * (cols.length - 1);
  let x = (W - runWidth) / 2;
  cols.forEach((col, c) => {
    const w = widths[c] * scale;
    const colHeight = col.reduce((s, a) => s + w / a, 0) + gap * (col.length - 1);
    let y = (H - colHeight) / 2;
    for (const a of col) {
      frames.push({ x, y, w, h: w / a });
      y += w / a + gap;
    }
    x += w + gap;
  });
  return frames;
}

// The paper covered, with a nudge towards even sizes: a page where one photo
// is a stamp next to a poster reads as a mistake, not a design.
function score(frames: Frame[]): number {
  const areas = frames.map((f) => f.w * f.h);
  const total = areas.reduce((s, a) => s + a, 0);
  const balance = Math.min(...areas) / Math.max(...areas);
  return total * Math.pow(balance, 0.25);
}

export function arrangePage(
  photos: FlowPhoto[],
  layout: PageBox,
  options: { margin: Margins; gapMm: number; startZ: number; page: number; offsetYmm?: number }
): Omit<LayoutItem, "id">[] {
  if (photos.length === 0) return [];
  const { margin, gapMm, startZ, page, offsetYmm = 0 } = options;
  const W = layout.page_width_mm - margin.x * 2;
  const H = layout.page_height_mm - margin.y * 2;
  const aspects = photos.map((p) => (p.aspect > 0 ? p.aspect : 1.5));

  let best: Frame[] | null = null;
  let bestScore = -1;
  // More than nine photos can't be split into three bands of three: fall
  // back to rows of three, which rowsLayout scales to fit.
  const candidates = photos.length <= 9 ? splits(photos.length) : [Array(Math.ceil(photos.length / 3)).fill(3)];
  for (const bands of candidates) {
    for (const frames of [rowsLayout(aspects, bands, W, H, gapMm), columnsLayout(aspects, bands, W, H, gapMm)]) {
      const s = score(frames);
      if (s > bestScore) {
        bestScore = s;
        best = frames;
      }
    }
  }

  return (best ?? []).map((f, i) => ({
    kind: "photo" as const,
    image_id: photos[i].id,
    page,
    x_mm: margin.x + f.x,
    y_mm: margin.y + f.y + offsetYmm,
    width_mm: f.w,
    height_mm: f.h,
    rotation: 0,
    z: startZ + i,
    content_scale: 1,
    content_dx: 0,
    content_dy: 0,
    text: null,
    style: null,
  }));
}

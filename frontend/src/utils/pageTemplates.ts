// One page, laid out from a handful of photos that belong together: the
// canvas's Auto-arrange. No fixed templates - the page is set in justified
// rows or columns (every photo keeps its own shape, the row fills the width),
// and of the few ways to split the photos into rows the one that covers the
// most paper wins. "One big, two small" simply falls out of that where the
// shapes allow it.
//
// The style decides how far the page may go to cover its paper: "balanced"
// keeps shape and order, "fitted" lets photos change places, "edge" fills the
// page to the margin and trims each photo a little for it (the frame may
// depart from the photo's shape by up to MAX_CROP; the renderer always covers
// the frame, so content_scale 1 is a centred crop).
import type { LayoutItem } from "../api/types";
import type { FlowPhoto, Margins, PageBox } from "./canvasLayout";

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  // How far the frame departs from the photo's shape: 0 = exact.
  crop: number;
}

export type PageLayout = "best" | "rows" | "columns";
export type PageSizes = "fill" | "even";
export type PageStyle = "balanced" | "fitted" | "edge";

const MAX_CROP = 0.15;

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

function group(aspects: number[], bands: number[]): number[][] {
  const out: number[][] = [];
  let at = 0;
  for (const count of bands) {
    out.push(aspects.slice(at, at + count));
    at += count;
  }
  return out;
}

// Rows across the page: each row as high as it must be to fill the width,
// the stack scaled down and centred if it would run past the bottom.
// With a crop allowance the stack is scaled to exactly the page height
// instead (up or down), and each row is squeezed or stretched to still
// fill the width - within the allowance; past it the row stays short.
function rowsLayout(aspects: number[], bands: number[], W: number, H: number, gap: number, maxCrop: number): Frame[] {
  const rows = group(aspects, bands);
  const vGaps = gap * (rows.length - 1);
  const heights = rows.map((row) => (W - gap * (row.length - 1)) / row.reduce((s, a) => s + a, 0));
  const natural = heights.reduce((s, h) => s + h, 0);
  let scale: number;
  if (maxCrop > 0) scale = (H - vGaps) / natural;
  else scale = natural + vGaps > H ? (H - vGaps) / natural : 1;
  // Per row: the stretch that fills the width again, held within the
  // allowance; where that isn't enough the row shrinks to the width instead.
  const fitted = rows.map((row, r) => {
    const sum = row.reduce((s, a) => s + a, 0);
    const avail = W - gap * (row.length - 1);
    let h = heights[r] * scale;
    const need = avail / (h * sum);
    const stretch = maxCrop > 0 ? Math.min(1 + maxCrop, Math.max(1 / (1 + maxCrop), need)) : 1;
    if (stretch * h * sum > avail) h = avail / (stretch * sum);
    return { h, stretch };
  });
  const frames: Frame[] = [];
  const stackHeight = fitted.reduce((s, f) => s + f.h, 0) + vGaps;
  let y = (H - stackHeight) / 2;
  rows.forEach((row, r) => {
    const { h, stretch } = fitted[r];
    const crop = Math.abs(stretch - 1);
    const rowWidth = row.reduce((s, a) => s + a * stretch * h, 0) + gap * (row.length - 1);
    let x = (W - rowWidth) / 2;
    for (const a of row) {
      frames.push({ x, y, w: a * stretch * h, h, crop });
      x += a * stretch * h + gap;
    }
    y += h + gap;
  });
  return frames;
}

// Columns down the page: the same idea turned on its side.
function columnsLayout(aspects: number[], bands: number[], W: number, H: number, gap: number, maxCrop: number): Frame[] {
  const cols = group(aspects, bands);
  const hGaps = gap * (cols.length - 1);
  const widths = cols.map((col) => (H - gap * (col.length - 1)) / col.reduce((s, a) => s + 1 / a, 0));
  const natural = widths.reduce((s, w) => s + w, 0);
  let scale: number;
  if (maxCrop > 0) scale = (W - hGaps) / natural;
  else scale = natural + hGaps > W ? (W - hGaps) / natural : 1;
  const fitted = cols.map((col, c) => {
    const sum = col.reduce((s, a) => s + 1 / a, 0);
    const avail = H - gap * (col.length - 1);
    let w = widths[c] * scale;
    const need = avail / (w * sum);
    const stretch = maxCrop > 0 ? Math.min(1 + maxCrop, Math.max(1 / (1 + maxCrop), need)) : 1;
    if (stretch * w * sum > avail) w = avail / (stretch * sum);
    return { w, stretch };
  });
  const frames: Frame[] = [];
  const runWidth = fitted.reduce((s, f) => s + f.w, 0) + hGaps;
  let x = (W - runWidth) / 2;
  cols.forEach((col, c) => {
    const { w, stretch } = fitted[c];
    const crop = Math.abs(stretch - 1);
    const colHeight = col.reduce((s, a) => s + (w / a) * stretch, 0) + gap * (col.length - 1);
    let y = (H - colHeight) / 2;
    for (const a of col) {
      frames.push({ x, y, w, h: (w / a) * stretch, crop });
      y += (w / a) * stretch + gap;
    }
    x += w + gap;
  });
  return frames;
}

// The paper covered, with a nudge towards even sizes: a page where one photo
// is a stamp next to a poster reads as a mistake, not a design. "Even" turns
// the nudge into the rule: the sizes count as much as the paper. Trimming
// costs a little, so at equal cover the lighter crop wins.
function score(frames: Frame[], evenness: number): number {
  const areas = frames.map((f) => f.w * f.h);
  const total = areas.reduce((s, a) => s + a, 0);
  const balance = Math.min(...areas) / Math.max(...areas);
  const crop = frames.reduce((s, f) => s + f.crop, 0) / frames.length / MAX_CROP;
  return total * Math.pow(balance, evenness) * (1 - 0.5 * Math.min(1, crop));
}

// The orders in which the photos may be placed. Up to six, every order; past
// that the given one and three sorted by shape, which is where the gain is.
function orders(aspects: number[], reorder: boolean): number[][] {
  const identity = aspects.map((_, i) => i);
  if (!reorder || aspects.length < 2) return [identity];
  if (aspects.length <= 6) {
    const out: number[][] = [];
    const walk = (rest: number[], acc: number[]) => {
      if (rest.length === 0) {
        out.push(acc);
        return;
      }
      rest.forEach((i, k) => walk([...rest.slice(0, k), ...rest.slice(k + 1)], [...acc, i]));
    };
    walk(identity, []);
    return out;
  }
  const wide = [...identity].sort((a, b) => aspects[b] - aspects[a]);
  const tall = [...wide].reverse();
  const mixed: number[] = [];
  for (let k = 0; k < wide.length; k++) mixed.push(k % 2 === 0 ? wide[k >> 1] : tall[k >> 1]);
  const seen = new Set<string>();
  return [identity, wide, tall, mixed].filter((o) => {
    const key = o.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function arrangePage(
  photos: FlowPhoto[],
  layout: PageBox,
  options: {
    margin: Margins;
    gapMm: number;
    startZ: number;
    page: number;
    offsetYmm?: number;
    // Rows, columns, or whichever covers more; sizes alike or the paper filled.
    pageLayout?: PageLayout;
    sizes?: PageSizes;
    style?: PageStyle;
  }
): Omit<LayoutItem, "id">[] {
  if (photos.length === 0) return [];
  const { margin, gapMm, startZ, page, offsetYmm = 0, pageLayout = "best", sizes = "fill", style = "balanced" } = options;
  const reorder = style !== "balanced";
  // The nudge towards even sizes: the rule for "even"; for "fill" a touch,
  // lighter still when photos may change places, or the swap that covers
  // more paper would lose to a flatter one.
  const evenness = sizes === "even" ? 1 : reorder ? 0.1 : 0.25;
  const maxCrop = style === "edge" ? MAX_CROP : 0;
  const W = layout.page_width_mm - margin.x * 2;
  const H = layout.page_height_mm - margin.y * 2;
  const aspects = photos.map((p) => (p.aspect > 0 ? p.aspect : 1.5));

  let best: Frame[] | null = null;
  let bestOrder: number[] = [];
  let bestScore = -1;
  // More than nine photos can't be split into three bands of three: fall
  // back to rows of three, which rowsLayout scales to fit.
  const candidates = photos.length <= 9 ? splits(photos.length) : [Array(Math.ceil(photos.length / 3)).fill(3)];
  const tries = orders(aspects, reorder);
  for (let o = 0; o < tries.length; o++) {
    const order = tries[o];
    const ordered = order.map((i) => aspects[i]);
    // The given order wins a dead heat: fewer surprises.
    const tie = o === 0 ? 1.0005 : 1;
    for (const bands of candidates) {
      const ways: Frame[][] = [];
      if (pageLayout !== "columns") ways.push(rowsLayout(ordered, bands, W, H, gapMm, maxCrop));
      if (pageLayout !== "rows") ways.push(columnsLayout(ordered, bands, W, H, gapMm, maxCrop));
      for (const frames of ways) {
        const s = score(frames, evenness) * tie;
        if (s > bestScore) {
          bestScore = s;
          best = frames;
          bestOrder = order;
        }
      }
    }
  }

  return (best ?? []).map((f, i) => ({
    kind: "photo" as const,
    image_id: photos[bestOrder[i]].id,
    page,
    x_mm: margin.x + f.x,
    y_mm: margin.y + f.y + offsetYmm,
    width_mm: f.w,
    height_mm: f.h,
    rotation: 0,
    // Stacking keeps the filmstrip's order whatever the places.
    z: startZ + bestOrder[i],
    content_scale: 1,
    content_dx: 0,
    content_dy: 0,
    text: null,
    style: null,
  }));
}

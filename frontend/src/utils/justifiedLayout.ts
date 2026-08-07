// The justified-rows layout and the scroll-window tracking behind both big
// photo grids: the library timeline and the import review.
//
// Both need the same thing - positions for EVERY photo computed up front, so
// the scroll range is exact from the first frame and a scrubber jump lands
// pixel-perfect, while only the tiles near the viewport are actually mounted.
// That is what keeps a library (or an import) of thousands responsive; the
// review grid used to render every card into the DOM and became unusable
// somewhere in the low thousands.
//
// Kept generic over the item type because the two grids show different things
// on their tiles (a library photo navigates; a staged file has a checkbox,
// stars and a duplicate badge) but position them identically.

import { useEffect, useRef, useState, type RefObject } from "react";

import { loadMarginFor } from "./preload";

// Layout constants mirroring the CSS grid (.thumbnail-grid gap, header pill +
// margin, section spacing). They only need to be internally consistent: the
// virtual grid positions everything itself, so these ARE the layout.
export const GAP = 12;
export const HEADER_H = 34;
export const HEADER_MB = 12;
export const SECTION_MB = 8;

// How far beyond the viewport tiles are mounted. Two rows wider than the band
// in which a thumbnail may load (utils/preload.ts), and derived from it rather
// than tuned alongside it: a virtualized grid can only load a tile it has
// mounted, so a mounted band narrower than the load margin would silently cap
// the look-ahead - the tiles would be allowed to load and simply not exist.
// The two extra rows are the slack that keeps a tile mounted a moment before
// it is allowed to start, and a moment after it is told to stop.
//
// Both scale with the tile size, because the cost is per MOUNTED TILE, not per
// pixel: a fixed band holds four times as many cards at XS (130px rows) as at
// M (260px) and twelve times as many as at XL - which is why the small grid
// sizes were the ones that got sluggish. Tying it to the row height keeps the
// number of live cards roughly level across the sizes.
export function overscanFor(rowHeight: number): number {
  return Math.round(loadMarginFor(rowHeight) + rowHeight * 2);
}

// Scroll positions are quantized before landing in React state, so a smooth
// scroll re-renders every ~2 tile rows instead of every frame.
export const SCROLL_QUANTUM = 400;

export interface LayoutTile<T> {
  item: T;
  index: number; // position in the flat ordered list (drives range-select)
  left: number;
  width: number;
}

export interface LayoutRow<T> {
  top: number; // within the section
  height: number;
  tiles: LayoutTile<T>[];
}

export interface LayoutSection<T> {
  label: string;
  // Identity, for React keys and for the maps that find a section's element.
  // The LABEL cannot serve as that: sections are runs of equal labels, so a
  // single photo sitting out of date order (a mispaired RAW+JPEG shown at its
  // partner's position, a hand-edited capture time) splits a month into two
  // sections that are both called "June 2024". Keyed by label, the second one
  // overwrites the first in those maps and every tick between them vanishes
  // from the scrubber - months with thousands of photos behind them simply not
  // on the rail. Equal to the label for the first section of that name, so the
  // normal case keeps its stable, position-independent key.
  key: string;
  top: number; // within the whole timeline
  height: number;
  rows: LayoutRow<T>[];
  count: number;
}

export interface JustifiedLayout<T> {
  sections: LayoutSection<T>[];
  totalHeight: number;
}

interface LayoutOptions<T> {
  width: number;
  rowHeight: number;
  // Section heading a given item belongs under; a run of equal labels forms one
  // section. The library groups by month, the import review by day.
  labelOf: (item: T) => string;
  aspectOf: (item: T) => number;
  // Extra height every row needs below its tiles, for grids whose card is more
  // than the image - the import review puts rating stars and colour swatches
  // under each thumbnail. Rows advance by it; `row.height` stays the IMAGE
  // height, so tiles keep their aspect ratio and the caller adds this back for
  // the card's total height.
  rowExtra?: number;
}

// Justified-rows layout, the JS twin of the CSS flexbox grid (flex-grow: ar,
// flex-basis: ar*rowH): fill a row while the tiles' natural widths fit, then
// scale the row so it exactly spans the container. The last row of a section
// keeps its natural height (the CSS grid-filler equivalent).
export function buildJustifiedLayout<T>(
  items: T[],
  { width, rowHeight, labelOf, aspectOf, rowExtra = 0 }: LayoutOptions<T>
): JustifiedLayout<T> {
  const sections: LayoutSection<T>[] = [];
  // How many sections of each label have been emitted, so a repeated label
  // still yields a unique key (see LayoutSection.key). Counting occurrences
  // rather than using the section's index keeps the key stable when photos are
  // added above: a plain index would change for every section below the
  // insertion and remount the whole timeline.
  const labelSeen = new Map<string, number>();
  let y = 0;

  const flushSection = (label: string, group: { item: T; index: number }[]) => {
    const rows: LayoutRow<T>[] = [];
    let innerY = HEADER_H + HEADER_MB;
    let pending: { item: T; index: number; ar: number }[] = [];
    let sumAr = 0;

    const flushRow = (last: boolean) => {
      if (pending.length === 0) return;
      const avail = width - GAP * (pending.length - 1);
      const natural = sumAr * rowHeight;
      // Underfull last row: keep the target height, left-aligned. Every other
      // row is justified to span the container exactly.
      const height = last && natural <= avail ? rowHeight : avail / sumAr;
      let x = 0;
      const tiles: LayoutTile<T>[] = pending.map((p) => {
        const w = p.ar * height;
        const tile = { item: p.item, index: p.index, left: x, width: w };
        x += w + GAP;
        return tile;
      });
      rows.push({ top: innerY, height, tiles });
      innerY += height + rowExtra + GAP;
      pending = [];
      sumAr = 0;
    };

    for (const entry of group) {
      const ar = aspectOf(entry.item);
      if (pending.length > 0 && (sumAr + ar) * rowHeight + GAP * pending.length > width) {
        flushRow(false);
      }
      pending.push({ ...entry, ar });
      sumAr += ar;
    }
    flushRow(true);

    const height = innerY - GAP + SECTION_MB;
    const seen = (labelSeen.get(label) ?? 0) + 1;
    labelSeen.set(label, seen);
    sections.push({
      label,
      key: seen === 1 ? label : `${label}#${seen}`,
      top: y,
      height,
      rows,
      count: group.length,
    });
    y += height;
  };

  let currentLabel: string | null = null;
  let group: { item: T; index: number }[] = [];
  items.forEach((item, index) => {
    const label = labelOf(item);
    if (label !== currentLabel && group.length > 0) {
      flushSection(currentLabel!, group);
      group = [];
    }
    currentLabel = label;
    group.push({ item, index });
  });
  if (group.length > 0) flushSection(currentLabel!, group);

  return { sections, totalHeight: y };
}

export interface VirtualWindow {
  // Container width the layout is computed for; 0 until first measured.
  width: number;
  // Visible band in layout coordinates, quantized (see SCROLL_QUANTUM).
  window: { top: number; bottom: number };
  // The scrolling ancestor, for callers that need to move it.
  scrollerRef: RefObject<HTMLElement | null>;
  // Unquantized scroll offset of the root within the scroller - too coarse in
  // `window` for callers that re-anchor across layout changes.
  lastScrollRef: { current: number };
}

// Track the container's width and the scroller's visible band. `enabled` is
// there because a grid that renders an empty state doesn't mount the root at
// all: the effect has to re-run once the first photos arrive, or width stays 0
// and no layout is ever built.
export function useVirtualWindow(
  rootRef: RefObject<HTMLDivElement | null>,
  enabled: boolean
): VirtualWindow {
  const scrollerRef = useRef<HTMLElement | null>(null);
  const lastScrollRef = useRef(0);
  const [width, setWidth] = useState(0);
  const [window_, setWindow] = useState({ top: 0, bottom: 0 });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const scroller = (root.closest(".page-scroll") ?? root.parentElement) as HTMLElement;
    scrollerRef.current = scroller;

    const measure = () => {
      setWidth(root.clientWidth);
      const rootTop =
        root.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      const top = scroller.scrollTop - rootTop;
      lastScrollRef.current = top;
      const raw = { top, bottom: top + scroller.clientHeight };
      setWindow((prev) => {
        const q = (v: number) => Math.round(v / SCROLL_QUANTUM) * SCROLL_QUANTUM;
        return q(prev.top) === q(raw.top) && q(prev.bottom) === q(raw.bottom) ? prev : raw;
      });
    };

    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    ro.observe(scroller);
    return () => {
      cancelAnimationFrame(raf);
      scroller.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { width, window: window_, scrollerRef, lastScrollRef };
}

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

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { loadMarginFor } from "./preload";

// Layout constants mirroring the CSS grid (.thumbnail-grid gap, header pill +
// margin, section spacing). They only need to be internally consistent: the
// virtual grid positions everything itself, so these ARE the layout.
export const GAP = 12;
export const HEADER_H = 34;
export const HEADER_MB = 12;
export const SECTION_MB = 8;

// How far a row may be stretched past the target height to justify it. A row is
// filled until the NEXT tile would overflow, so a full row is at most one tile
// short of the container and the stretch is slight - but a row holding a single
// wide photo (a panorama, or any photo at all once the window is narrower than
// two tiles) has nothing to share the slack with and would be blown up to the
// full width, several times the size the Size control asked for. Past this it
// keeps the target height and left-aligns, like an underfull last row.
const MAX_ROW_STRETCH = 1.5;

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
      const justified = avail / sumAr;
      // Underfull last row, or a row too empty to justify without blowing its
      // tiles up: keep the target height, left-aligned. Every other row is
      // justified to span the container exactly.
      const height =
        (last && natural <= avail) || justified > rowHeight * MAX_ROW_STRETCH
          ? rowHeight
          : justified;
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

// Whether two layouts place everything identically. Section tops and heights
// are enough: rows are laid out from them, so equal sections mean equal rows.
function sameGeometry<T>(a: JustifiedLayout<T>, b: JustifiedLayout<T>): boolean {
  if (a.totalHeight !== b.totalHeight || a.sections.length !== b.sections.length) return false;
  return a.sections.every((section, i) => {
    const other = b.sections[i];
    return (
      section.top === other.top && section.height === other.height && section.key === other.key
    );
  });
}

// Re-anchor the scroll position across layout changes.
//
// Both grids rebuild their layout under the user: the library when the tile
// size, the window width or the filtered set changes, the import review every
// time a poll brings new photos or an analyzed file finally learns its capture
// date and moves out of the dateless tail into its day. Raw scrollTop then
// points at whatever happens to sit at that pixel now - which is what reads as
// the grid "jumping" while a card is still being read in. So: find the row at
// the top of the viewport in the OLD layout and scroll so that same photo sits
// at the same relative spot in the new one.
export function useLayoutScrollAnchor<T extends { id: string }>({
  layout,
  rootRef,
  scrollerRef,
  lastScrollRef,
  partnerIdOf,
  resetKey,
}: {
  layout: JustifiedLayout<T> | null;
  rootRef: RefObject<HTMLElement | null>;
  scrollerRef: RefObject<HTMLElement | null>;
  lastScrollRef: { current: number };
  // The item's RAW/JPEG partner, if it has one - see the anchor set below.
  partnerIdOf?: (item: T) => string | null | undefined;
  // When this changes the list is a NEW set (a filter was applied): jump to its
  // top instead of chasing the previously-visible photo into it.
  resetKey?: string;
}): void {
  const pendingResetRef = useRef(false);
  const prevResetKeyRef = useRef(resetKey);
  useEffect(() => {
    if (prevResetKeyRef.current === resetKey) return;
    prevResetKeyRef.current = resetKey;
    pendingResetRef.current = true;
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [resetKey, scrollerRef]);

  const prevLayoutRef = useRef<JustifiedLayout<T> | null>(null);
  useLayoutEffect(() => {
    const prev = prevLayoutRef.current;
    prevLayoutRef.current = layout;
    const scroller = scrollerRef.current;
    const root = rootRef.current;
    if (!prev || !layout || prev === layout || !scroller || !root) return;

    if (pendingResetRef.current) {
      pendingResetRef.current = false;
      scroller.scrollTop = 0;
      return;
    }

    // Nothing moved: a rebuilt layout with identical geometry (the import polls
    // every second, and most polls only flip a flag on a card that is already
    // where it belongs) needs no correction - and applying one anyway would
    // write back a scroll offset that is up to a frame old, which is felt as
    // the grid fighting the wheel.
    if (sameGeometry(prev, layout)) return;

    const top = lastScrollRef.current;
    let anchors: Set<string> | null = null;
    let frac = 0; // how far into the anchor row the viewport top sat
    outer: for (const s of prev.sections) {
      if (s.top + s.height <= top) continue;
      for (const r of s.rows) {
        const rowTop = s.top + r.top;
        if (rowTop + r.height > top) {
          // Every photo in the anchor row AND each one's RAW/JPEG partner.
          // Anchoring on a single id broke exactly when the id was the half
          // that just disappeared - toggling "Merge RAW+JPG" drops every RAW
          // from the list, so the anchor was nowhere in the new layout, no
          // scroll correction ran, and the old offset pointed into a grid
          // that had shrunk underneath it. That was the jump. The partner
          // card shows the same shot, so it re-anchors seamlessly; the same
          // holds for the RAW/JPEG view-mode switch.
          anchors = new Set<string>();
          for (const t of r.tiles) {
            anchors.add(t.item.id);
            const partner = partnerIdOf?.(t.item);
            if (partner) anchors.add(partner);
          }
          frac = Math.max(-0.5, Math.min(1, (top - rowTop) / r.height));
          break outer;
        }
      }
    }
    if (!anchors || anchors.size === 0) return;

    // First row holding any of them: the anchor row's photos stay contiguous
    // in the new list, so that row is where the viewport top belongs.
    for (const s of layout.sections) {
      for (const r of s.rows) {
        if (r.tiles.some((t) => anchors!.has(t.item.id))) {
          const rootTop =
            root.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            scroller.scrollTop;
          scroller.scrollTop = rootTop + s.top + r.top + frac * r.height;
          return;
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);
}

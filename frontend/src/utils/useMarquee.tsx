import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isSelectClick } from "./selection";

// Rubber-band selection for the photo grids, the way the Finder and Photos
// do it: a press on the grid - on empty ground between the tiles or on a tile
// itself - and a drag draws a rectangle, every tile it touches is selected as
// it is swept (the tile the drag started on among them), Shift or Cmd/Ctrl
// held adds to what was selected before, and the grid scrolls on its own when
// the pointer reaches its edge. A press without a drag on empty ground clears
// the selection; a press without a drag on a tile is the tile's own click and
// still opens the photo (or ticks it, where the page says so).
//
// The grids differ in how they know where their tiles are (the virtual
// timeline from its layout model, the plain grid from the DOM), so they hand
// in a `hitTest`; everything else - the gesture, the rectangle, the scrolling,
// the click that must not follow a drag - lives here once.

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Options {
  // The grid's root: the rectangle is drawn inside it (position: relative)
  // and the coordinates handed to hitTest are measured from its top-left.
  rootRef: RefObject<HTMLElement | null>;
  // The element that scrolls the grid (the page's .page-scroll).
  getScroller: () => HTMLElement | null;
  // Ids of the tiles that intersect a rectangle given in root coordinates.
  hitTest: (rect: MarqueeRect) => string[];
  // Called once when a drag turns real (past the threshold): a grid that
  // measures the DOM caches its tile rectangles here.
  onDragStart?: () => void;
  selectedIds: Set<string> | undefined;
  // Replace the selection with these ids. Absent = the gesture is off.
  onSetSelection?: (ids: string[]) => void;
}

// A press that moves less than this is a click, not a drag.
const DRAG_THRESHOLD = 4;
// How close to the scroller's top / bottom edge the pointer has to be for the
// grid to scroll on its own, and the most it moves per frame.
const EDGE_BAND = 28;
const MAX_SCROLL_PER_FRAME = 28;
// The strip along the scroller's right edge where its scrollbar lives.
const SCROLLBAR_BAND = 20;

// What counts as empty ground: the grid itself and its sections, or the
// scroller's own padding around it. A press here without a drag clears the
// selection.
const GROUND = ".timeline, .timeline-section, .thumbnail-grid, .grid-filler";
// A tile is the other place a rubber band starts - but not its controls (the
// checkbox, the info and remove buttons), which keep their own clicks. Anything
// else (a header, the scrubber, a bar, a dialog) is not where one starts.
const TILE = ".thumb-card";
const TILE_CONTROL = "button, input, a, [role='button']";

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function useMarquee({ rootRef, getScroller, hitTest, onDragStart, selectedIds, onSetSelection }: Options) {
  const [rect, setRect] = useState<MarqueeRect | null>(null);
  // The page's closures change every render; the one document listener reads
  // them through this ref instead of being re-attached each time.
  const latest = useRef({ hitTest, onDragStart, selectedIds, onSetSelection, getScroller });
  latest.current = { hitTest, onDragStart, selectedIds, onSetSelection, getScroller };

  const active = Boolean(onSetSelection);

  useEffect(() => {
    if (!active) return;
    let drag: {
      // The press, in root coordinates: fixed for the whole gesture, since the
      // root moves with the scroll and the rectangle is anchored to it.
      originX: number;
      originY: number;
      // Where the pointer is now, in viewport coordinates.
      clientX: number;
      clientY: number;
      additive: boolean;
      // Started on a tile rather than on empty ground: a press that never
      // becomes a drag is then the tile's click, not a clearing of the selection.
      onTile: boolean;
      base: string[];
      real: boolean;
      lastHits: string[];
      scroller: HTMLElement;
    } | null = null;
    let frame = 0;

    const rootRect = () => rootRef.current?.getBoundingClientRect() ?? null;

    const apply = () => {
      frame = 0;
      if (!drag || !drag.real) return;
      const r = rootRect();
      if (!r) return;
      const x = drag.clientX - r.left;
      const y = drag.clientY - r.top;
      const box: MarqueeRect = {
        left: Math.min(drag.originX, x),
        top: Math.min(drag.originY, y),
        width: Math.abs(x - drag.originX),
        height: Math.abs(y - drag.originY),
      };
      setRect(box);
      const hits = latest.current.hitTest(box);
      if (!sameIds(hits, drag.lastHits)) {
        drag.lastHits = hits;
        const ids = drag.additive ? Array.from(new Set([...drag.base, ...hits])) : hits;
        latest.current.onSetSelection?.(ids);
      }
      // Near (or past) the scroller's edge the grid scrolls on its own, faster
      // the further out the pointer is; the next frame draws the stretched box.
      const s = drag.scroller.getBoundingClientRect();
      const above = drag.clientY - (s.top + EDGE_BAND);
      const below = drag.clientY - (s.bottom - EDGE_BAND);
      let step = 0;
      if (above < 0) step = Math.max(-MAX_SCROLL_PER_FRAME, above);
      else if (below > 0) step = Math.min(MAX_SCROLL_PER_FRAME, below);
      if (step !== 0) {
        const before = drag.scroller.scrollTop;
        drag.scroller.scrollTop = before + step;
        if (drag.scroller.scrollTop !== before) schedule();
      }
    };

    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(apply);
    };

    const end = () => {
      if (!drag) return;
      const wasReal = drag.real;
      const { additive, onTile } = drag;
      drag = null;
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setRect(null);
      if (wasReal) {
        // The click that follows a drag must not land on whatever is under the
        // pointer when the button comes up.
        const swallow = (e: MouseEvent) => {
          e.stopPropagation();
          e.preventDefault();
          document.removeEventListener("click", swallow, true);
        };
        document.addEventListener("click", swallow, true);
        window.setTimeout(() => document.removeEventListener("click", swallow, true), 0);
      } else if (!onTile && !additive && (latest.current.selectedIds?.size ?? 0) > 0) {
        // A plain click on empty ground: nothing selected any more.
        latest.current.onSetSelection?.([]);
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      drag.clientX = e.clientX;
      drag.clientY = e.clientY;
      if (!drag.real) {
        const r = rootRect();
        if (!r) return;
        const dx = e.clientX - r.left - drag.originX;
        const dy = e.clientY - r.top - drag.originY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        drag.real = true;
        latest.current.onDragStart?.();
        // The sweep replaces the selection unless a modifier keeps the old one.
        if (!drag.additive && drag.base.length > 0) latest.current.onSetSelection?.([]);
      }
      schedule();
    };

    const onUp = () => end();

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType === "touch" || drag) return;
      // A press that closes an open menu is spent on that; it neither clears
      // the selection nor starts a band.
      if (document.querySelector(".ctx-menu, .dropdown-menu")) return;
      const target = e.target as Element | null;
      const root = rootRef.current;
      const scroller = latest.current.getScroller();
      if (!target || !root || !scroller || !scroller.contains(target)) return;
      const onGround = target === scroller || target.matches(GROUND);
      const onTile = !onGround && root.contains(target) && Boolean(target.closest(TILE)) && !target.closest(TILE_CONTROL);
      if (!onGround && !onTile) return;
      // A press on the scroller's own scrollbar reports the scroller as its
      // target too; that drag scrolls, it does not select.
      if (target === scroller && e.clientX > scroller.getBoundingClientRect().right - SCROLLBAR_BAND) return;
      const r = root.getBoundingClientRect();
      drag = {
        originX: e.clientX - r.left,
        originY: e.clientY - r.top,
        clientX: e.clientX,
        clientY: e.clientY,
        additive: isSelectClick(e),
        onTile,
        base: Array.from(latest.current.selectedIds ?? []),
        real: false,
        lastHits: [],
        scroller,
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };

    // On the document, not the grid: the ground around the grid belongs to the
    // scroller, and the grid's root may not exist yet when this mounts.
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      end();
    };
  }, [active, rootRef]);

  const marquee = useCallback(
    (r: MarqueeRect | null) =>
      r ? (
        <div className="marquee" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} aria-hidden />
      ) : null,
    []
  );

  return { rect, marquee: marquee(rect) };
}

import { useEffect, useRef } from "react";
import { isModalOpen } from "./modalKeys";
import { takesTyping } from "./selection";

// Culling from the keyboard: with ONE photo selected, the arrow keys walk that
// selection through the grid - left / right along the order, up / down to the
// photo above or below - and the page's own keys (stars, colours, delete) act
// on wherever it has got to. With nothing or several selected the arrows are
// left alone and scroll the page as before.
export type GridMove = "left" | "right" | "up" | "down";

const KEY_MOVES: Record<string, GridMove> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

export function useGridArrowKeys(opts: {
  // The one selected photo; null with no selection or more than one.
  current: string | null;
  // The photo lying in that direction, or null at the edge of the grid. Each
  // grid answers this from its own geometry.
  neighbour: (id: string, move: GridMove) => string | null;
  // Make that photo the selection and bring it into view.
  onMove: (id: string) => void;
}) {
  // Fresh closures every render; read through a ref so the one window
  // listener is not torn down each time.
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const move = KEY_MOVES[e.key];
      // Not when a focused control has already used the key (a dropdown
      // opens on the arrows).
      if (!move || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const { current, neighbour, onMove } = latest.current;
      if (!current) return;
      const target = e.target as HTMLElement | null;
      if (target && takesTyping(target)) return;
      // A dialog or an open menu has the arrows for itself.
      if (isModalOpen() || document.querySelector(".dropdown-menu, .ctx-menu")) return;
      // Also at the edge: the page must not start scrolling under a selection
      // that has nowhere further to go.
      e.preventDefault();
      const next = neighbour(current, move);
      if (next) onMove(next);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

// Room kept clear when a tile is scrolled into view: the sticky section
// heading above, the bulk action bar pinned to the window's bottom edge below.
const REVEAL_TOP = 56;
const REVEAL_BOTTOM = 124;

// Scroll just far enough that the tile (given in the scroller's own content
// coordinates) is fully in view; a tile already in view moves nothing.
export function revealInScroller(scroller: HTMLElement, top: number, height: number) {
  if (top < scroller.scrollTop + REVEAL_TOP) {
    scroller.scrollTop = top - REVEAL_TOP;
  } else if (top + height > scroller.scrollTop + scroller.clientHeight - REVEAL_BOTTOM) {
    scroller.scrollTop = top + height - (scroller.clientHeight - REVEAL_BOTTOM);
  }
}

// The single selected id, or null.
export function onlySelected(selectedIds: Set<string> | undefined): string | null {
  if (!selectedIds || selectedIds.size !== 1) return null;
  const [only] = selectedIds;
  return only;
}

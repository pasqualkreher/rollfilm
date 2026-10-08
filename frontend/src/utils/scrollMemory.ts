import { useLayoutEffect, type RefObject } from "react";

// Where each area was scrolled to, for the length of the session. A page is
// unmounted on every change of area (Library -> Albums -> Library), and a
// fresh mount starts at the top - so coming back to a view meant finding the
// place again. Positions are kept per key in memory, like useSessionState's
// values: gone on quit, which is right for a scroll offset.
//
// Coming back from the photo view is the one case that is NOT this: the grid
// jumps to the photo that was open (utils/lastViewed.ts), and that wins over
// the remembered offset - the grids check the marker first.
const positions = new Map<string, number>();

export function saveScroll(key: string, top: number): void {
  positions.set(key, top);
}

export function readScroll(key: string): number | undefined {
  return positions.get(key);
}

// Remember the scroll offset of the element in `ref` under `key`, and put it
// back on mount.
//
// `ready`: a page that renders skeletons or a spinner before its content is
// there has nothing to scroll yet - a restore then is clamped to 0 and lost.
// Pass "the content is on screen" and the restore waits for it. It must not
// fall back to false on a background refetch (`!!data` stays true, `isPending`
// would not).
//
// `restore: false` only records the offset; the grids restore themselves,
// after their layout exists and after the photo-return check.
//
// Layout effect on purpose: React runs layout-effect cleanups before the host
// node leaves the document, so the last offset can still be read there. By
// the time a passive effect's cleanup runs the node is detached and reads 0.
export function useScrollMemory(
  ref: RefObject<HTMLElement | null>,
  key: string,
  { ready = true, restore = true }: { ready?: boolean; restore?: boolean } = {}
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (restore && ready) {
      const top = readScroll(key);
      // Nobody else has positioned it yet (the photo-return jump would have).
      if (top !== undefined && el.scrollTop === 0 && top > 0) el.scrollTop = top;
    }
    const onScroll = () => saveScroll(key, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      saveScroll(key, el.scrollTop);
    };
  }, [ref, key, ready, restore]);
}

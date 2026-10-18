import { useEffect, useRef } from "react";

// The bottom action bar's height as a CSS variable on the root, so the grid's
// foot room follows the bar when it wraps onto two or three rows in a narrow
// window (see .page:has(.action-bar--bottom) .page-scroll in index.css). Set
// while the bar is mounted, cleared when it goes.
const VAR = "--action-bar-h";

export function useBarHeight<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const apply = () => root.style.setProperty(VAR, `${Math.round(el.getBoundingClientRect().height)}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty(VAR);
    };
  });
  return ref;
}

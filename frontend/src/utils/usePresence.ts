import { useEffect, useState } from "react";

// Mount/unmount with an exit animation. React drops a conditionally rendered
// element the moment its flag goes false, which is why closing surfaces used
// to just vanish while opening ones eased in. usePresence keeps the element
// on screen for `ms` longer and hands back a `closing` flag for that stretch,
// so a modifier class can run the reverse animation:
//
//   const menu = usePresence(open, 120);
//   {menu.present && <div className={`menu${menu.closing ? " pm-closing" : ""}`} />}
//
// Reopening while the exit runs cancels it (the element never remounts, so
// its scroll position and focus survive). `ms` should match the CSS exit
// duration; under prefers-reduced-motion the element goes at once.
export function usePresence(open: boolean, ms = 160): { present: boolean; closing: boolean } {
  const [present, setPresent] = useState(open);

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    if (ms <= 0 || prefersReducedMotion()) {
      setPresent(false);
      return;
    }
    const t = window.setTimeout(() => setPresent(false), ms);
    return () => window.clearTimeout(t);
  }, [open, present, ms]);

  return { present: present || open, closing: present && !open };
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

// Exit durations, matched to the CSS in index.css ("Motion" section).
export const MOTION = {
  pop: 120, // menus and popovers
  modal: 170, // dialogs and their backdrop
  bar: 200, // the bottom action bar
  overlay: 200, // full-window overlays (slideshow, import lightbox)
} as const;

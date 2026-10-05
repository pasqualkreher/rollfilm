import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// One tooltip for the whole app, in place of Chromium's native `title` bubble
// (wrong delay, wrong face, ignores the theme). Mounted once in App; it
// listens on the document, so no component has to change: the first time an
// element with a `title` is hovered or focused, the text moves to `data-tip`
// (which the browser doesn't render) and this layer shows it instead.
//
// Accessibility: `title` was the accessible name of icon-only controls, so an
// element without an aria-label or visible text gets one from the same string.
// While shown, the anchor gets aria-describedby pointing at the bubble.
//
// Placement: centred under the anchor, which suits a button. On a large anchor
// (a photo card) that lands far from the hand, so anything inside an element
// marked `data-tip-at="pointer"` gets its tip at the mouse instead, the way a
// native one behaves: it waits for the mouse to rest, shows there, and stays
// put until the mouse leaves the anchor. Keyboard focus has no pointer and
// keeps the anchor placement.

const SHOW_DELAY_MS = 450;
const TIP_ID = "pm-tooltip";
const MARGIN = 8;
// Offsets from the hot spot that clear the cursor arrow below and to the right.
const POINTER_DX = 12;
const POINTER_DY = 20;

type Tip = { text: string; x: number; y: number; above: boolean; atPointer: boolean };

// The bubble's height before it is laid out: wrapped lines at its max width.
function estimateHeight(text: string): number {
  const lines = text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 48)), 0);
  return 28 + 16 * (lines - 1);
}

function pointerTip(text: string, p: { x: number; y: number }): Tip {
  const above = p.y + POINTER_DY + estimateHeight(text) > window.innerHeight - MARGIN;
  return { text, x: p.x + POINTER_DX, y: above ? p.y - 8 : p.y + POINTER_DY, above, atPointer: true };
}

function readTip(el: HTMLElement): string | null {
  const title = el.getAttribute("title");
  if (title !== null) {
    el.removeAttribute("title");
    if (title.trim()) {
      el.dataset.tip = title;
      if (!el.hasAttribute("aria-label") && !el.textContent?.trim() && !el.hasAttribute("aria-labelledby")) {
        el.setAttribute("aria-label", title);
      }
    }
  }
  const tip = el.dataset.tip;
  return tip && tip.trim() ? tip : null;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef(0);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const pointerRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    // The show of a pointer tip that is still waiting for the mouse to rest.
    let pendingAtPointer: (() => void) | null = null;

    const clear = () => {
      window.clearTimeout(timerRef.current);
      timerRef.current = 0;
      pendingAtPointer = null;
      const a = anchorRef.current;
      if (a && a.getAttribute("aria-describedby") === TIP_ID) a.removeAttribute("aria-describedby");
      anchorRef.current = null;
      setTip(null);
    };

    const place = (el: HTMLElement, text: string, atPointer: boolean) => {
      anchorRef.current = el;
      el.setAttribute("aria-describedby", TIP_ID);
      if (atPointer) {
        setTip(pointerTip(text, pointerRef.current));
        return;
      }
      const r = el.getBoundingClientRect();
      // Prefer below; flip above when there is no room. Measured against the
      // bubble's estimated height so the first frame doesn't jump.
      const above = r.bottom + 6 + estimateHeight(text) > window.innerHeight - MARGIN;
      const x = Math.min(window.innerWidth - MARGIN, Math.max(MARGIN, r.left + r.width / 2));
      const y = above ? r.top - 6 : r.bottom + 6;
      setTip({ text, x, y, above, atPointer: false });
    };

    const arm = (target: EventTarget | null, immediate: boolean) => {
      if (!(target instanceof Element)) return;
      const el = target.closest<HTMLElement>("[title], [data-tip]");
      if (!el) return;
      const text = readTip(el);
      if (!text || draggingRef.current) return;
      if (anchorRef.current === el) return;
      clear();
      if (immediate) place(el, text, false);
      else {
        const atPointer = el.closest('[data-tip-at="pointer"]') !== null;
        const show = () => {
          pendingAtPointer = null;
          place(el, text, atPointer);
        };
        pendingAtPointer = atPointer ? show : null;
        timerRef.current = window.setTimeout(show, SHOW_DELAY_MS);
      }
    };

    const onOver = (e: MouseEvent) => arm(e.target, false);
    const onMove = (e: MouseEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
      // A pointer tip shows where the mouse comes to rest: moving restarts the
      // wait. Once shown it stays where it is.
      if (pendingAtPointer) {
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(pendingAtPointer, SHOW_DELAY_MS);
      }
    };
    const onOut = (e: MouseEvent) => {
      const a = anchorRef.current;
      const to = e.relatedTarget;
      if (!a) {
        // A pending (not yet shown) tip is dropped when the pointer leaves it.
        if (timerRef.current && !(to instanceof Node && (e.target as Element)?.contains(to))) clear();
        return;
      }
      if (to instanceof Node && a.contains(to)) return;
      if (e.target instanceof Node && a.contains(e.target)) clear();
    };
    const onFocusIn = (e: FocusEvent) => {
      // Only keyboard focus: a mouse click focuses too, and the hover already
      // handles that.
      if (e.target instanceof HTMLElement && e.target.matches(":focus-visible")) arm(e.target, true);
    };
    const onFocusOut = () => clear();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    const onDown = () => {
      draggingRef.current = true;
      clear();
    };
    const onUp = () => {
      draggingRef.current = false;
    };
    const onScroll = () => clear();

    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mouseout", onOut, true);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("mouseout", onOut, true);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", clear);
      clear();
    };
  }, []);

  // Keep the bubble inside the viewport horizontally once it has a width.
  // Before paint, so the first frame doesn't jump.
  useLayoutEffect(() => {
    const b = bubbleRef.current;
    if (!b || !tip) return;
    const w = b.offsetWidth;
    const want = tip.atPointer ? tip.x : tip.x - w / 2;
    const left = Math.min(window.innerWidth - MARGIN - w, Math.max(MARGIN, want));
    b.style.left = `${left}px`;
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={bubbleRef}
      id={TIP_ID}
      role="tooltip"
      className={`tooltip${tip.above ? " tooltip--above" : ""}`}
      style={{ left: tip.x, top: tip.y }}
    >
      {tip.text}
    </div>,
    document.body
  );
}

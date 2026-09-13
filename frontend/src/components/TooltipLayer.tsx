import { useEffect, useRef, useState } from "react";
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

const SHOW_DELAY_MS = 450;
const TIP_ID = "pm-tooltip";
const MARGIN = 8;

type Tip = { text: string; x: number; y: number; above: boolean };

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

  useEffect(() => {
    const clear = () => {
      window.clearTimeout(timerRef.current);
      timerRef.current = 0;
      const a = anchorRef.current;
      if (a && a.getAttribute("aria-describedby") === TIP_ID) a.removeAttribute("aria-describedby");
      anchorRef.current = null;
      setTip(null);
    };

    const place = (el: HTMLElement, text: string) => {
      const r = el.getBoundingClientRect();
      // Prefer below; flip above when there is no room. Measured against the
      // bubble's max height so the first frame doesn't jump.
      const estH = 28 + 16 * (text.split("\n").length - 1);
      const above = r.bottom + 6 + estH > window.innerHeight - MARGIN;
      const x = Math.min(window.innerWidth - MARGIN, Math.max(MARGIN, r.left + r.width / 2));
      const y = above ? r.top - 6 : r.bottom + 6;
      anchorRef.current = el;
      el.setAttribute("aria-describedby", TIP_ID);
      setTip({ text, x, y, above });
    };

    const arm = (target: EventTarget | null, immediate: boolean) => {
      if (!(target instanceof Element)) return;
      const el = target.closest<HTMLElement>("[title], [data-tip]");
      if (!el) return;
      const text = readTip(el);
      if (!text || draggingRef.current) return;
      if (anchorRef.current === el) return;
      clear();
      if (immediate) place(el, text);
      else timerRef.current = window.setTimeout(() => place(el, text), SHOW_DELAY_MS);
    };

    const onOver = (e: MouseEvent) => arm(e.target, false);
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
  useEffect(() => {
    const b = bubbleRef.current;
    if (!b || !tip) return;
    const w = b.offsetWidth;
    const left = Math.min(window.innerWidth - MARGIN - w, Math.max(MARGIN, tip.x - w / 2));
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

// Corner style (rounded vs. square), persisted in localStorage like the
// colour skin. Every radius in index.css is expressed as `<px> *
// var(--corner-scale)`, so flipping the data-corners attribute (which sets the
// scale to 0) squares off the whole UI at once; true circles (spinners, dots,
// the colour wheel) use 50% and are deliberately left round.
import { useSyncExternalStore } from "react";

export type CornerStyle = "rounded" | "square";

const KEY = "pm.corners";

export function getStoredCorners(): CornerStyle {
  return localStorage.getItem(KEY) === "square" ? "square" : "rounded";
}

export function applyCorners(style: CornerStyle): void {
  const root = document.documentElement;
  if (style === "square") root.setAttribute("data-corners", "square");
  else root.removeAttribute("data-corners");
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setCorners(style: CornerStyle): void {
  localStorage.setItem(KEY, style);
  applyCorners(style);
  listeners.forEach((l) => l());
}

// Applied once at startup (before React renders) so there's no flash of the
// wrong corner style.
export function initCorners(): void {
  applyCorners(getStoredCorners());
}

export function useCorners(): [CornerStyle, (s: CornerStyle) => void] {
  const style = useSyncExternalStore(subscribe, getStoredCorners);
  return [style, setCorners];
}

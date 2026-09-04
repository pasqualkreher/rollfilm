// UI typeface, persisted in localStorage like the colour skin and the corner
// style. Every family here is a stack of fonts that ship with macOS, Windows
// or a typical Linux desktop - nothing is downloaded, so the choice works
// offline and in the packaged app. The stack is written to --font-ui on
// <html>, which body's font-family reads (the CSS default there mirrors
// DEFAULT_FONT for the instant before this runs); code/mono spots keep their
// own monospace stack regardless.
import { useSyncExternalStore } from "react";

export type UiFont = "rollfilm" | "helvetica" | "avenir" | "arial" | "verdana" | "trebuchet";

export const DEFAULT_FONT: UiFont = "rollfilm";

export interface FontInfo {
  value: UiFont;
  label: string;
  // One line on the character of the face, under the tile's name.
  hint: string;
  stack: string;
}

// Rollfilm is the stack the app has always used: the OS's own UI face (SF Pro
// on a Mac, Segoe on Windows, Roboto elsewhere). The five after it are close
// relatives - plain, even sans-serifs that ship with every desktop - so the
// choice is a matter of temperature and width, never of style.
export const FONTS: FontInfo[] = [
  {
    value: "rollfilm",
    label: "Rollfilm",
    hint: "The default: your system's own UI face",
    stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  {
    value: "helvetica",
    label: "Helvetica",
    hint: "The classic neutral grotesk",
    stack: '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif',
  },
  {
    value: "avenir",
    label: "Avenir",
    hint: "Softer, a little more geometric",
    stack: '"Avenir Next", Avenir, "Segoe UI", Ubuntu, Cantarell, "Noto Sans", sans-serif',
  },
  {
    value: "arial",
    label: "Arial",
    hint: "Slightly narrower, everywhere",
    stack: 'Arial, "Liberation Sans", Helvetica, sans-serif',
  },
  {
    value: "verdana",
    label: "Verdana",
    hint: "Wide and airy, built for screens",
    stack: 'Verdana, "DejaVu Sans", Geneva, sans-serif',
  },
  {
    value: "trebuchet",
    label: "Trebuchet",
    hint: "Humanist, a touch more character",
    stack: '"Trebuchet MS", "Fira Sans", "Segoe UI", sans-serif',
  },
];

export function fontInfo(font: UiFont): FontInfo {
  return FONTS.find((f) => f.value === font) ?? FONTS[0];
}

const KEY = "pm.font";

export function getStoredFont(): UiFont {
  const v = localStorage.getItem(KEY);
  return FONTS.some((f) => f.value === v) ? (v as UiFont) : DEFAULT_FONT;
}

export function applyFont(font: UiFont): void {
  const root = document.documentElement;
  root.setAttribute("data-font", font);
  root.style.setProperty("--font-ui", fontInfo(font).stack);
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setFont(font: UiFont): void {
  localStorage.setItem(KEY, font);
  applyFont(font);
  listeners.forEach((l) => l());
}

// Applied once at startup (before React renders) so there's no flash of the
// wrong typeface.
export function initFont(): void {
  applyFont(getStoredFont());
}

export function useFont(): [UiFont, (f: UiFont) => void] {
  const font = useSyncExternalStore(subscribe, getStoredFont);
  return [font, setFont];
}

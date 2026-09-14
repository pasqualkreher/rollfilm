// Appearance, persisted in localStorage. Three values, not one: the light skin,
// the dark skin, and the mode that says which of the two is showing (Light,
// Dark, or Auto = whatever the OS is set to). That split is what lets Auto work
// at all - "follow the system" has to know which palette to follow it *with*.
//
// Each skin is a full palette under `:root[data-theme="<skin>"]` in index.css
// (Stone light being :root itself). This module resolves mode + OS into one
// of those names, sets the attribute, remembers the preference, and carries the
// swatch colours the picker previews.
import { useSyncExternalStore } from "react";

export type Mode = "light" | "dark" | "auto";
export type LightSkin = "stone" | "pebble" | "paper";
export type DarkSkin = "stone-dark" | "pebble-dark" | "paper-dark";
export type Skin = LightSkin | DarkSkin;

// Metadata the Settings picker renders. `bg`/`elevated`/`text`/`accent` mirror
// the four most telling variables of each skin (see index.css) so the little
// preview shows the skin's real colours regardless of the active theme.
export interface SkinInfo {
  value: Skin;
  label: string;
  // One line on what the skin is for, under the tile's name.
  hint: string;
  bg: string;
  elevated: string;
  text: string;
  accent: string;
}

// Three pairs, all colourless, because a photo is the only thing on screen
// that should carry colour: Stone, Stone a step lighter, and Stone moved
// towards warm paper. Same order in both lists so a pair sits in the same
// column.
export const LIGHT_SKINS: SkinInfo[] = [
  { value: "stone", label: "Stone", hint: "Muted grey, the default", bg: "#eaebec", elevated: "#f6f7f7", text: "#26282a", accent: "#5a6067" },
  { value: "pebble", label: "Pebble", hint: "Stone, a step lighter", bg: "#f1f2f3", elevated: "#fbfbfc", text: "#26282a", accent: "#5a6067" },
  { value: "paper", label: "Paper", hint: "Warm off-white, like print paper", bg: "#f3f0e9", elevated: "#fbf9f4", text: "#2b2824", accent: "#5e5850" },
];

export const DARK_SKINS: SkinInfo[] = [
  { value: "stone-dark", label: "Stone Dark", hint: "Soft muted grey", bg: "#26292d", elevated: "#2e3237", text: "#e5e7ea", accent: "#aab1b8" },
  { value: "pebble-dark", label: "Pebble Dark", hint: "Lighter charcoal, not too dark", bg: "#313438", elevated: "#3a3d42", text: "#eceef0", accent: "#b8bec5" },
  { value: "paper-dark", label: "Paper Dark", hint: "Soft warm charcoal", bg: "#302e2a", elevated: "#393632", text: "#eeeae2", accent: "#c8c1b5" },
];

export const SKINS: SkinInfo[] = [...LIGHT_SKINS, ...DARK_SKINS];

export function skinInfo(skin: Skin): SkinInfo {
  return SKINS.find((s) => s.value === skin) ?? LIGHT_SKINS[0];
}

const MODE_KEY = "pm.themeMode";
const LIGHT_KEY = "pm.skinLight";
const DARK_KEY = "pm.skinDark";
// Pre-0.1.39 key: a single skin name (or "system") covering both modes.
const LEGACY_KEY = "pm.theme";

const DEFAULT_MODE: Mode = "auto";
const DEFAULT_LIGHT: LightSkin = "stone";
const DEFAULT_DARK: DarkSkin = "stone-dark";

export interface Appearance {
  mode: Mode;
  light: LightSkin;
  dark: DarkSkin;
  // The skin actually painted right now - mode and, under Auto, the OS setting
  // resolved down to one palette. Recomputed on every change, so components can
  // compare against it to show what's in use.
  resolved: Skin;
}

const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)");

function systemPrefersDark(): boolean {
  return darkQuery?.matches ?? false;
}

function resolve(mode: Mode, light: LightSkin, dark: DarkSkin): Skin {
  const showDark = mode === "dark" || (mode === "auto" && systemPrefersDark());
  return showDark ? dark : light;
}

// The removed skins (there were 36) all mapped onto light or dark; a stored one
// keeps the user on that side of the fence with the nearest survivor, rather
// than silently flipping their app to Auto. Runs once, then the old key goes.
const LEGACY_DARK = new Set([
  "dim", "dark", "graphite-dark", "taupe", "slate", "vintage", "darkroom", "nord",
  "forest", "dracula", "solarized-dark", "midnight", "plum", "ocean", "monokai",
  "rose-pine", "gruvbox-dark", "ember",
]);
const LEGACY_LIGHT_MAP: Record<string, LightSkin> = {
  fog: "pebble",
  sky: "pebble",
  light: "paper",
  "ember-light": "paper",
};
const LEGACY_DARK_MAP: Record<string, DarkSkin> = {
  slate: "pebble-dark",
  nord: "pebble-dark",
  ember: "paper-dark",
};

function migrateLegacy(): void {
  const old = localStorage.getItem(LEGACY_KEY);
  if (old === null) return;
  localStorage.removeItem(LEGACY_KEY);
  if (localStorage.getItem(MODE_KEY) !== null) return;
  if (old === "system") {
    localStorage.setItem(MODE_KEY, "auto");
    return;
  }
  if (LEGACY_DARK.has(old)) {
    localStorage.setItem(MODE_KEY, "dark");
    localStorage.setItem(DARK_KEY, LEGACY_DARK_MAP[old] ?? DEFAULT_DARK);
  } else {
    localStorage.setItem(MODE_KEY, "light");
    localStorage.setItem(LIGHT_KEY, LEGACY_LIGHT_MAP[old] ?? DEFAULT_LIGHT);
  }
}

// The 0.1.72 skins cut down to three pairs: the warm ones and Ink's paper white
// land on Paper, the rest on Stone. Keyed by the light name; the dark name is
// the same with "-dark".
const REMOVED_SKIN_MAP: Record<string, LightSkin> = {
  ink: "paper",
  orange: "paper",
  sand: "paper",
  slate: "stone",
  sage: "stone",
  blue: "stone",
};

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  let v = localStorage.getItem(key) ?? "";
  const dark = v.endsWith("-dark");
  const mapped = REMOVED_SKIN_MAP[dark ? v.slice(0, -5) : v];
  if (mapped) {
    v = dark ? `${mapped}-dark` : mapped;
    localStorage.setItem(key, v);
  }
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function load(): Appearance {
  const mode = read<Mode>(MODE_KEY, ["light", "dark", "auto"], DEFAULT_MODE);
  const light = read<LightSkin>(LIGHT_KEY, LIGHT_SKINS.map((s) => s.value) as LightSkin[], DEFAULT_LIGHT);
  const dark = read<DarkSkin>(DARK_KEY, DARK_SKINS.map((s) => s.value) as DarkSkin[], DEFAULT_DARK);
  return { mode, light, dark, resolved: resolve(mode, light, dark) };
}

// One cached snapshot object, replaced on every change: useSyncExternalStore
// compares snapshots by identity, so this must not be rebuilt on every read.
let current: Appearance = { mode: DEFAULT_MODE, light: DEFAULT_LIGHT, dark: DEFAULT_DARK, resolved: DEFAULT_LIGHT };

// Apply the resolved skin to the document. The attribute is always set (even
// for the default), so the OS-dark rule in index.css only ever covers the
// instant before this module runs.
function apply(): void {
  document.documentElement.setAttribute("data-theme", current.resolved);
}

// All useAppearance() instances subscribe here so every consumer (picker tiles,
// the Settings summary, …) re-renders together when anything changes.
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function commit(next: Partial<Pick<Appearance, "mode" | "light" | "dark">>): void {
  const mode = next.mode ?? current.mode;
  const light = next.light ?? current.light;
  const dark = next.dark ?? current.dark;
  current = { mode, light, dark, resolved: resolve(mode, light, dark) };
  apply();
  listeners.forEach((l) => l());
}

export function setMode(mode: Mode): void {
  localStorage.setItem(MODE_KEY, mode);
  commit({ mode });
}

export function setLightSkin(light: LightSkin): void {
  localStorage.setItem(LIGHT_KEY, light);
  commit({ light });
}

export function setDarkSkin(dark: DarkSkin): void {
  localStorage.setItem(DARK_KEY, dark);
  commit({ dark });
}

// Applied once at startup (before React renders) so there's no flash of the
// wrong theme. The media listener keeps Auto honest while the app is open: the
// OS flipping at sunset repaints the app without a restart.
export function initTheme(): void {
  migrateLegacy();
  current = load();
  apply();
  darkQuery?.addEventListener("change", () => {
    if (current.mode === "auto") commit({});
  });
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => current);
}

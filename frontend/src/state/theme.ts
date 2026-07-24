// Colour skins, persisted in localStorage. Each skin is a full palette that
// lives in index.css under `:root[data-theme="<skin>"]`; `:root` itself is the
// Light palette and an OS-dark media query supplies Dark automatically when no
// skin is chosen ("system"). This module just flips that attribute, remembers
// the preference, and carries the little swatch colours the picker previews.
import { useSyncExternalStore } from "react";

export type Theme =
  | "system"
  // Light family
  | "light"
  | "soft-grey"
  | "sepia"
  | "rose"
  | "solarized-light"
  | "lavender"
  | "mint"
  | "sky"
  | "peach"
  | "gruvbox-light"
  // Dark family
  | "dim"
  | "dark"
  | "vintage"
  | "nord"
  | "forest"
  | "dracula"
  | "solarized-dark"
  | "midnight"
  | "plum"
  | "ocean"
  | "monokai"
  | "rose-pine"
  | "gruvbox-dark";

// Metadata the Settings picker renders. `bg`/`elevated`/`text`/`accent` mirror
// the four most telling variables of each skin (see index.css) so the little
// preview shows the skin's real colours regardless of the active theme.
export interface SkinInfo {
  value: Theme;
  label: string;
  group: "light" | "dark";
  bg: string;
  elevated: string;
  text: string;
  accent: string;
}

export const SKINS: SkinInfo[] = [
  // — Light —
  { value: "light", label: "Light", group: "light", bg: "#ffffff", elevated: "#f6f6f7", text: "#1a1a1a", accent: "#3a6df0" },
  { value: "soft-grey", label: "Soft Grey", group: "light", bg: "#e8e8ea", elevated: "#f2f2f4", text: "#26262a", accent: "#3a6df0" },
  { value: "sepia", label: "Sepia", group: "light", bg: "#f4ecdd", elevated: "#ece2cf", text: "#3d3226", accent: "#b5651d" },
  { value: "rose", label: "Rosé", group: "light", bg: "#f7edea", elevated: "#fbf3f1", text: "#43322f", accent: "#c25d6e" },
  { value: "solarized-light", label: "Solarized Light", group: "light", bg: "#fdf6e3", elevated: "#eee8d5", text: "#586e75", accent: "#268bd2" },
  { value: "lavender", label: "Lavender", group: "light", bg: "#f1eef8", elevated: "#f8f6fc", text: "#322b47", accent: "#7c5cd6" },
  { value: "mint", label: "Mint", group: "light", bg: "#ecf5ef", elevated: "#f4faf6", text: "#223a2e", accent: "#10967e" },
  { value: "sky", label: "Sky", group: "light", bg: "#eaf2fa", elevated: "#f4f9fd", text: "#1d3247", accent: "#2b7fd4" },
  { value: "peach", label: "Peach", group: "light", bg: "#fdf1e7", elevated: "#fef7f0", text: "#463122", accent: "#e0763a" },
  { value: "gruvbox-light", label: "Gruvbox Light", group: "light", bg: "#fbf1c7", elevated: "#f2e5bc", text: "#3c3836", accent: "#d65d0e" },
  // — Dark —
  { value: "dim", label: "Dim", group: "dark", bg: "#2c2f36", elevated: "#363a43", text: "#e6e8ec", accent: "#7aa2f7" },
  { value: "dark", label: "Dark", group: "dark", bg: "#17181a", elevated: "#212226", text: "#f1f1f2", accent: "#6d93ff" },
  { value: "vintage", label: "Vintage", group: "dark", bg: "#24211d", elevated: "#2e2a24", text: "#ece4d6", accent: "#e08a3c" },
  { value: "nord", label: "Nord", group: "dark", bg: "#2e3440", elevated: "#3b4252", text: "#eceff4", accent: "#88c0d0" },
  { value: "forest", label: "Forest", group: "dark", bg: "#1a2620", elevated: "#223029", text: "#e4ede6", accent: "#6fbf8b" },
  { value: "dracula", label: "Dracula", group: "dark", bg: "#282a36", elevated: "#343746", text: "#f8f8f2", accent: "#bd93f9" },
  { value: "solarized-dark", label: "Solarized Dark", group: "dark", bg: "#002b36", elevated: "#073642", text: "#eee8d5", accent: "#268bd2" },
  { value: "midnight", label: "Midnight", group: "dark", bg: "#10141f", elevated: "#192030", text: "#e5eaf5", accent: "#4d8dff" },
  { value: "plum", label: "Plum", group: "dark", bg: "#241b2b", elevated: "#2f2338", text: "#efe6f2", accent: "#d16ba5" },
  { value: "ocean", label: "Ocean", group: "dark", bg: "#0f1e26", elevated: "#172b34", text: "#e2edf1", accent: "#33b3c8" },
  { value: "monokai", label: "Monokai", group: "dark", bg: "#272822", elevated: "#32332b", text: "#f8f8f2", accent: "#f92672" },
  { value: "rose-pine", label: "Rosé Pine", group: "dark", bg: "#191724", elevated: "#1f1d2e", text: "#e0def4", accent: "#ea9a97" },
  { value: "gruvbox-dark", label: "Gruvbox Dark", group: "dark", bg: "#282828", elevated: "#32302f", text: "#ebdbb2", accent: "#fabd2f" },
];

const KEY = "pm.theme";

const VALID: Theme[] = ["system", ...SKINS.map((s) => s.value)];

export function getStoredTheme(): Theme {
  const v = localStorage.getItem(KEY);
  return (VALID as string[]).includes(v ?? "") ? (v as Theme) : "system";
}

// Apply a theme to the document. "system" removes the override so the OS
// preference (via the media query) takes back over; any other value sets the
// data-theme attribute the matching palette in index.css keys off.
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

// All useTheme() instances subscribe here so every consumer (picker tiles,
// the Settings summary, …) re-renders together when the skin changes.
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
  listeners.forEach((l) => l());
}

// Applied once at startup (before React renders) so there's no flash of the
// wrong theme.
export function initTheme(): void {
  applyTheme(getStoredTheme());
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, getStoredTheme);
  return [theme, setTheme];
}

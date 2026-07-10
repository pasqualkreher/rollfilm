// Light / dark / system theme, persisted in localStorage. The actual palette
// lives in index.css: `:root` is light, an OS-dark media query supplies dark
// automatically, and `:root[data-theme="..."]` overrides let the user force a
// choice. This module just flips that attribute and remembers the preference.
import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

const KEY = "pm.theme";

export function getStoredTheme(): Theme {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

// Apply a theme to the document. "system" removes the override so the OS
// preference (via the media query) takes back over.
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

// Applied once at startup (before React renders) so there's no flash of the
// wrong theme.
export function initTheme(): void {
  applyTheme(getStoredTheme());
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(getStoredTheme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  function update(t: Theme) {
    setTheme(t);
    set(t);
  }
  return [theme, update];
}

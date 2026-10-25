// What the user picked last - presets, albums, canvases, tags - so the long
// lists in the bars' menus and the right-click submenus can show the few
// they use all the time and put the rest behind "More…" (components/
// PickerDialog). Kept per kind in localStorage, newest first, twenty deep;
// a library of 50 albums and 20 presets stays a five-row menu.

export type RecentKind = "preset" | "album" | "canvas" | "tag";

// Up to this many entries a list shows whole; above it, SHOW_RECENT of them
// plus "More…". Six, not five: a sixth row costs less than a "More…" that
// hides one.
export const SHOW_ALL_UP_TO = 6;
export const SHOW_RECENT = 5;
const KEEP = 20;

function storageKey(kind: RecentKind): string {
  return `pm.recent.${kind}`;
}

export function recentKeys(kind: RecentKind): string[] {
  try {
    const raw = localStorage.getItem(storageKey(kind));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export function noteRecent(kind: RecentKind, key: string): void {
  if (!key) return;
  try {
    const next = [key, ...recentKeys(kind).filter((k) => k !== key)].slice(0, KEEP);
    localStorage.setItem(storageKey(kind), JSON.stringify(next));
  } catch {
    // Storage blocked: the menus just show the fallback order.
  }
}

// The short form of a list: all of it up to SHOW_ALL_UP_TO entries; above
// that the SHOW_RECENT most recently used (in that order), filled up from
// `items` own order - which the caller has already put newest-first - and
// the rest as `hidden`.
export function shortList<T>(kind: RecentKind, items: T[], keyOf: (item: T) => string): { shown: T[]; hidden: T[] } {
  if (items.length <= SHOW_ALL_UP_TO) return { shown: items, hidden: [] };
  const byKey = new Map(items.map((item) => [keyOf(item), item] as const));
  const shown: T[] = [];
  for (const key of recentKeys(kind)) {
    const item = byKey.get(key);
    if (item && !shown.includes(item)) shown.push(item);
    if (shown.length >= SHOW_RECENT) break;
  }
  for (const item of items) {
    if (shown.length >= SHOW_RECENT) break;
    if (!shown.includes(item)) shown.push(item);
  }
  return { shown, hidden: items.filter((item) => !shown.includes(item)) };
}

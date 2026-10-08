// How a browsed grid is ordered. The server sends photos newest first; the
// other orders are made here from the same list, which carries the name and
// the stars of every photo anyway. Shared by the Library and the album pages,
// so both offer the same orders under the same names.
export type SortKey = "newest" | "oldest" | "name" | "rating";

// The short form is what the closed sort field shows (the menu says the
// whole thing), so the field fits the pinned filter row.
export const SORT_OPTIONS: { value: SortKey; label: string; short: string }[] = [
  { value: "newest", label: "Newest first", short: "Newest" },
  { value: "oldest", label: "Oldest first", short: "Oldest" },
  { value: "name", label: "File name", short: "File name" },
  { value: "rating", label: "Rating", short: "Rating" },
];

const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function isSortKey(v: string | null | undefined): v is SortKey {
  return SORT_OPTIONS.some((o) => o.value === v);
}

// Array.sort is stable: within one rating the photos stay newest first. The
// list is returned as is for "newest", so callers can keep its identity.
export function sortImages<T extends { original_filename: string; rating: number }>(list: T[], sort: SortKey): T[] {
  if (sort === "newest") return list;
  if (sort === "oldest") return [...list].reverse();
  if (sort === "name") return [...list].sort((a, b) => NAME_ORDER.compare(a.original_filename, b.original_filename));
  return [...list].sort((a, b) => b.rating - a.rating);
}

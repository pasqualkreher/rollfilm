// How a browsed grid is ordered. The server sends photos newest first; the
// other orders are made here from the same list, which carries the name and
// the stars of every photo anyway. Shared by the Library and the album pages,
// so both offer the same orders under the same names.
export type SortKey = "newest" | "oldest" | "name" | "rating" | "roll";

// The short form is what the closed sort field shows (the menu says the
// whole thing), so the field fits the pinned filter row.
export const SORT_OPTIONS: { value: SortKey; label: string; short: string }[] = [
  { value: "newest", label: "Newest first", short: "Newest" },
  { value: "oldest", label: "Oldest first", short: "Oldest" },
  { value: "name", label: "File name", short: "File name" },
  { value: "rating", label: "Rating", short: "Rating" },
  { value: "roll", label: "By roll", short: "Roll" },
];

const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function isSortKey(v: string | null | undefined): v is SortKey {
  return SORT_OPTIONS.some((o) => o.value === v);
}

// Array.sort is stable: within one rating the photos stay newest first. The
// list is returned as is for "newest", so callers can keep its identity.
// The roll a row belongs to: the slim index row says `roll`, a full row
// `import_session_id`.
export function rollOf(image: { roll?: string | null; import_session_id?: string | null }): string | null {
  return image.roll ?? image.import_session_id ?? null;
}

export function sortImages<
  T extends { original_filename: string; rating: number; roll?: string | null; import_session_id?: string | null },
>(list: T[], sort: SortKey): T[] {
  if (sort === "newest") return list;
  if (sort === "oldest") return [...list].reverse();
  if (sort === "name") return [...list].sort((a, b) => NAME_ORDER.compare(a.original_filename, b.original_filename));
  if (sort === "roll") {
    // Rolls in the order of their newest photo (the list is newest first),
    // photos without a roll last; within a roll newest first.
    const rank = new Map<string, number>();
    for (const im of list) {
      const r = rollOf(im);
      if (r && !rank.has(r)) rank.set(r, rank.size);
    }
    const last = rank.size;
    return [...list].sort((a, b) => (rank.get(rollOf(a) ?? "") ?? last) - (rank.get(rollOf(b) ?? "") ?? last));
  }
  return [...list].sort((a, b) => b.rating - a.rating);
}

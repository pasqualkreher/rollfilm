// What the library holds at all: RAW + JPEG pairs, RAW files, other files. The
// bar's controls that only mean something for those (the RAW+JPG merge, the
// File type filter) are left out of a library that has none.
//
// Learnt from the unfiltered index and remembered, never read off the filtered
// grid: narrowing the view must not take a control out of the bar (nothing
// moves on a state change), and the next launch knows the answer on its first
// paint. A filtered result can only add a kind, never take one away.
import { useEffect, useSyncExternalStore } from "react";

export interface LibraryKinds {
  pairs: boolean;
  raw: boolean;
  other: boolean;
}

const KEY = "pm.libraryKinds";
// Until a first look at the library: the controls stay, as they always were.
const UNKNOWN: LibraryKinds = { pairs: true, raw: true, other: true };

function read(): LibraryKinds {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return stored ? { ...UNKNOWN, ...stored } : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

let current = read();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function store(next: LibraryKinds): void {
  if (next.pairs === current.pairs && next.raw === current.raw && next.other === current.other) return;
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private window or full storage: known for this run only.
  }
  listeners.forEach((l) => l());
}

export function useLibraryKinds(): LibraryKinds {
  return useSyncExternalStore(subscribe, () => current);
}

// The Library page feeds it. `whole`: these rows are the unfiltered library.
export function useLearnLibraryKinds(
  rows: readonly { file_type: string; paired_image_id?: string | null }[] | undefined,
  whole: boolean
): void {
  useEffect(() => {
    if (!rows) return;
    const seen: LibraryKinds = {
      pairs: rows.some((r) => Boolean(r.paired_image_id)),
      raw: rows.some((r) => r.file_type === "raw"),
      other: rows.some((r) => r.file_type !== "raw"),
    };
    store(
      whole
        ? seen
        : { pairs: current.pairs || seen.pairs, raw: current.raw || seen.raw, other: current.other || seen.other }
    );
  }, [rows, whole]);
}

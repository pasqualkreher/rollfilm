import type { BatchItem } from "../state/wait";

// Group ids for withBatches so both halves of a RAW+JPEG pair travel in the
// same slice: a cancel between two slices must never leave one half trashed
// (or in the album) and the other not. `partnerOf` is the pair link; an id
// whose partner is not in the list stays a unit of its own.
export function pairUnits(
  ids: string[],
  partnerOf: (id: string) => string | null | undefined
): BatchItem[] {
  const all = new Set(ids);
  const taken = new Set<string>();
  const units: BatchItem[] = [];
  for (const id of ids) {
    if (taken.has(id)) continue;
    taken.add(id);
    const partner = partnerOf(id);
    if (partner && all.has(partner) && !taken.has(partner)) {
      taken.add(partner);
      units.push([id, partner]);
    } else {
      units.push(id);
    }
  }
  return units;
}

// What a bulk action's note adds when it was cancelled part-way.
export const CANCELLED_NOTE = " Cancelled - the rest is unchanged.";

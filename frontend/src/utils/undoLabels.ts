import type { ColorLabel, Flag } from "../api/types";

// What the title bar's Undo chip says a bulk change did, in a few words.
export function bulkChangeLabel(
  patch: { rating?: number; color_label?: ColorLabel | string; flag?: Flag | "" },
  count: number
): string {
  const who = count === 1 ? "1 photo" : `${count} photos`;
  if (patch.rating !== undefined) return patch.rating > 0 ? `${who}: ${patch.rating}★` : `${who}: rating cleared`;
  if (patch.color_label !== undefined)
    return patch.color_label && patch.color_label !== "none" ? `${who}: label ${patch.color_label}` : `${who}: label cleared`;
  if (patch.flag !== undefined)
    return patch.flag === "pick" ? `${who} picked` : patch.flag === "reject" ? `${who} rejected` : `${who} unflagged`;
  return `${who} changed`;
}

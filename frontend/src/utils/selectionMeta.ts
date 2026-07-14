import type { ColorLabel, ImageOut } from "../api/types";

// The bulk bar's stars/swatches mirror the current selection: when every
// selected photo agrees on a value the bar shows it (so clicking the filled
// star toggles the rating back to 0, and the active swatch is ringed);
// a mixed selection falls back to empty stars / the "none" swatch.
export function selectionSharedMeta(
  images: ImageOut[],
  selected: Set<string>
): { rating: number; colorLabel: ColorLabel } {
  const sel = images.filter((im) => selected.has(im.id));
  const first = sel[0];
  if (!first) return { rating: 0, colorLabel: "none" };
  return {
    rating: sel.every((im) => im.rating === first.rating) ? first.rating : 0,
    colorLabel: sel.every((im) => im.color_label === first.color_label)
      ? first.color_label
      : "none",
  };
}

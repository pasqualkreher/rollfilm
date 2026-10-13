import { FILM_SIMS, SECTIONS, type ImageEdits } from "./adjustments";

// What one step of the editor's history did, in a few words - the label of
// a row in the history list ("Exposure +0.40", "Mask added", "Crop").
// Compares two whole edits; with several things changed at once (a preset,
// Reset all) the first one names the step and "…" says there was more.
const LABEL: Record<string, string> = Object.fromEntries(
  SECTIONS.flatMap((s) => s.fields.map((f) => [f.key, f.label]))
);

function fmt(v: number): string {
  const r = Math.round(v * 100) / 100;
  return `${r > 0 ? "+" : ""}${r}`;
}

export function describeEditStep(prev: ImageEdits | undefined, next: ImageEdits): string {
  if (!prev) return "Opened";
  const parts: string[] = [];
  const a = prev.adjustments;
  const b = next.adjustments;
  if (JSON.stringify(prev.crop) !== JSON.stringify(next.crop)) parts.push(next.crop ? "Crop" : "Crop cleared");
  if (prev.rotation !== next.rotation) parts.push("Rotate");
  if (prev.flipH !== next.flipH || prev.flipV !== next.flipV) parts.push("Flip");
  if (prev.straighten !== next.straighten) parts.push(`Straighten ${fmt(next.straighten)}°`);
  if (prev.perspH !== next.perspH || prev.perspV !== next.perspV || prev.distortion !== next.distortion)
    parts.push("Perspective");
  if (a.film_sim !== b.film_sim) {
    const name = FILM_SIMS.find((f) => f.value === b.film_sim)?.label ?? b.film_sim;
    parts.push(b.film_sim === "none" ? "Film look off" : `Film look: ${name}`);
  }
  if (a.masks.length !== b.masks.length) parts.push(b.masks.length > a.masks.length ? "Mask added" : "Mask removed");
  else if (JSON.stringify(a.masks) !== JSON.stringify(b.masks)) parts.push("Mask changed");
  if (a.spots.length !== b.spots.length) parts.push(b.spots.length > a.spots.length ? "Spot added" : "Spot removed");
  else if (JSON.stringify(a.spots) !== JSON.stringify(b.spots)) parts.push("Spot moved");
  if (JSON.stringify(a.point_curves) !== JSON.stringify(b.point_curves) || JSON.stringify(a.parametric_curve) !== JSON.stringify(b.parametric_curve))
    parts.push("Curve");
  if (JSON.stringify(a.hsl) !== JSON.stringify(b.hsl) || JSON.stringify(a.hsl_range) !== JSON.stringify(b.hsl_range))
    parts.push("Color mixer");
  if (JSON.stringify(a.color_grading) !== JSON.stringify(b.color_grading)) parts.push("Color grading");
  if (JSON.stringify(a.color_calibration) !== JSON.stringify(b.color_calibration)) parts.push("Calibration");
  for (const key of Object.keys(LABEL)) {
    const va = (a as unknown as Record<string, number>)[key];
    const vb = (b as unknown as Record<string, number>)[key];
    if (va !== vb) parts.push(`${LABEL[key]} ${fmt(vb)}`);
  }
  if (a.tone_mapper !== b.tone_mapper) parts.push(`Tone mapper: ${b.tone_mapper}`);
  if (parts.length === 0) return "Change";
  return parts.length === 1 ? parts[0] : `${parts[0]} …`;
}

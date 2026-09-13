import type { CSSProperties } from "react";

// Inline custom properties for the drawn range track (index.css, the
// `.editor-slider input[type="range"]` block): the accent fill runs from zero
// to the value on a slider that swings both ways, and from the left edge on
// one that doesn't; --pm-zero is where the centre detent tick sits.
export function rangeFillStyle(value: number, min: number, max: number): CSSProperties {
  const span = max - min || 1;
  const pct = (v: number) => `${Math.min(100, Math.max(0, ((v - min) / span) * 100))}%`;
  const bipolar = min < 0 && max > 0;
  const zero = bipolar ? 0 : min;
  const [a, b] = value < zero ? [value, zero] : [zero, value];
  return {
    "--pm-fill-a": pct(a),
    "--pm-fill-b": pct(b),
    "--pm-zero": bipolar ? String((0 - min) / span) : "0",
  } as CSSProperties;
}

export function isBipolar(min: number, max: number): boolean {
  return min < 0 && max > 0;
}

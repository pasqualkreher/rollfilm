// Shutter speeds for display. The backend hands the slider its stops as
// seconds (LibraryFacets.shutters); a photographer reads them as fractions
// below a second ("1/250") and as seconds from one up ("2 s", "1.3 s").
export function formatShutter(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return String(seconds);
  if (seconds >= 1) {
    const rounded = Math.round(seconds * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} s`;
  }
  return `1/${Math.round(1 / seconds)}`;
}

// Human-readable "time remaining" (e.g. "45s", "2m 10s", "1h 57m" - never
// "116m 46s"). Shared by the card import and the library import, so the two
// estimates read the same way.
export function formatEta(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM ? `${h}h ${remM}m` : `${h}h`;
}

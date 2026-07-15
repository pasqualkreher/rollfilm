// Hand-off between the image detail view and the grid it was opened from:
// the detail view records which photo is on screen, and the next grid that
// mounts scrolls that photo back into view - so going back (Escape, back
// arrow, browser back) returns to where the user was, not the top of the
// library. One-shot by design: the marker is cleared on first use so later,
// unrelated visits to a grid never jump unexpectedly.

const KEY = "pm:last-viewed-image";

export function rememberLastViewedImage(id: string): void {
  try {
    sessionStorage.setItem(KEY, id);
  } catch {
    /* storage full/blocked - jumping back to the top is an acceptable loss */
  }
}

export function peekLastViewedImage(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearLastViewedImage(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to clean up if storage is unavailable */
  }
}

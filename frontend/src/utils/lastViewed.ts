// Hand-off between the image detail view and the grid it was opened from:
// the detail view records which photo is on screen, and the next grid that
// mounts scrolls that photo back into view - so going back (Escape, back
// arrow, browser back) returns to where the user was, not the top of the
// library. One-shot by design: the marker is cleared on first use so later,
// unrelated visits to a grid never jump unexpectedly.

const KEY = "pm:last-viewed-image";

export interface LastViewedTarget {
  id: string;
  // How far below the scroller's top edge the tile sat at the moment it was
  // clicked. With it the grid restores the EXACT spot instead of re-centring
  // the photo, which shifted the whole view even when nothing else changed.
  // Only ever set for the photo that was actually clicked - stepping to
  // another photo inside the detail view drops it (see
  // rememberLastViewedImage) and the grid falls back to centring, which is
  // the right answer for a photo the user never saw a tile of.
  offset?: number;
}

function read(): LastViewedTarget | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    // Markers written before offsets existed are a bare id string.
    if (!raw.startsWith("{")) return { id: raw };
    const parsed = JSON.parse(raw) as LastViewedTarget;
    return parsed && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function write(target: LastViewedTarget): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(target));
  } catch {
    /* storage full/blocked - jumping back to the top is an acceptable loss */
  }
}

// Opening a photo from a grid: remember the tile's place in the viewport too.
export function rememberLastViewedImageAt(id: string, offset: number): void {
  write({ id, offset });
}

export function rememberLastViewedImage(id: string): void {
  // Keep the click offset only while it still describes THIS photo: arrowing
  // to the next photo in the detail view makes it meaningless, so it's
  // dropped and the grid centres the new photo instead.
  const prev = read();
  write(prev?.id === id ? prev : { id });
}

export function peekLastViewedTarget(): LastViewedTarget | null {
  return read();
}

export function peekLastViewedImage(): string | null {
  return read()?.id ?? null;
}

export function clearLastViewedImage(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to clean up if storage is unavailable */
  }
}

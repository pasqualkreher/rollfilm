// Warm the browser's image cache ahead of user interaction, so pixels are
// already in memory when they're needed: grid thumbnails start loading well
// before they scroll into view, and the detail view / import lightbox load
// each photo's neighbors while the current one is on screen - flipping with
// the arrow keys then swaps instantly instead of waiting on a request.

// The one place the preload footprint scales with the machine: every pinned
// preview holds ~11MB of decoded pixels, and windows tuned for an 8GB laptop
// (12 grid pins + 8 lightbox neighbors ≈ 220MB) fed system-wide swapping on
// 4GB devices. navigator.deviceMemory is Chrome/Electron-only and clamps at
// 8, which is exactly the resolution needed - "is this a small machine?" -
// and 8 is the right default where the API is missing (desktop Electron
// always has it).
const deviceMemoryGb =
  (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
const LOW_MEMORY_DEVICE = deviceMemoryGb <= 4;

// How many big previews the review grid keeps pinned for its visible cards
// (~11MB decoded each): enough that the next photo the user opens is warm,
// without ballooning the renderer - ~130MB on normal machines, ~65MB on 4GB
// devices.
export const GRID_PIN_LIMIT = LOW_MEMORY_DEVICE ? 6 : 12;

// How many neighbors each side of the current photo the lightboxes keep
// pinned for arrow-key zapping. Two still swaps instantly at human zapping
// speed; four gives fast flippers headroom where the RAM exists.
export const LIGHTBOX_NEIGHBOR_DEPTH = LOW_MEMORY_DEVICE ? 2 : 4;

// URLs requested RECENTLY - a repeat new Image() for one of these would be
// pure overhead, the browser's cache still holds the bytes. Deliberately a
// bounded LRU, not a grows-forever set: over a long session the browser
// evicts images from its caches, and a permanent "already preloaded" marker
// made every preload one-shot - revisited areas then paged cold and never
// re-warmed, which read as the app getting slower the longer it ran.
const preloadedUrls = new Map<string, true>();
const PRELOADED_URLS_MAX = 500;

export function preloadImage(url: string | null | undefined): void {
  if (!url) return;
  if (preloadedUrls.has(url)) {
    // Refresh recency, so the URLs of the area being browsed right now are
    // the last to age out of the marker.
    preloadedUrls.delete(url);
    preloadedUrls.set(url, true);
    return;
  }
  preloadedUrls.set(url, true);
  if (preloadedUrls.size > PRELOADED_URLS_MAX) {
    preloadedUrls.delete(preloadedUrls.keys().next().value!);
  }
  const img = new Image();
  img.decoding = "async";
  // Cache-warming must never compete with what's on screen: over HTTP/1.1 the
  // browser holds only ~6 connections per origin, and a burst of prefetches at
  // default priority delays the photo the user is actually waiting on.
  (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = "low";
  img.src = url;
}

// A pinned sliding window of decoded previews for lightbox zapping: holds a
// strong reference to the images around the current position, so the browser
// can't evict their pixels while they're near - and releases each one the
// moment it falls out of the window. preloadImage alone only warms the cache;
// its Image object is garbage-collected immediately and nothing stops the
// browser from evicting the bytes again under memory pressure.
export class PinnedImageWindow {
  private pins = new Map<string, { url: string; img: HTMLImageElement }>();

  // Keep exactly `keys` pinned - everything else is evicted - and start a
  // low-priority fetch for keys not pinned yet. `urlFor` resolves a key to
  // its CURRENT url (may return null while unknown, e.g. metadata still in
  // flight - the key is picked up on a later call); a changed url
  // (edit-version bump) re-pins the fresh render.
  update(keys: string[], urlFor: (key: string) => string | null): void {
    const keep = new Set(keys);
    for (const key of this.pins.keys()) {
      if (!keep.has(key)) this.pins.delete(key);
    }
    for (const key of keys) {
      const url = urlFor(key);
      if (!url) continue;
      const existing = this.pins.get(key);
      if (existing && existing.url === url) continue;
      const img = new Image();
      img.decoding = "async";
      (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = "low";
      img.src = url;
      this.pins.set(key, { url, img });
    }
  }

  clear(): void {
    this.pins.clear();
  }
}

// How far outside the viewport a thumbnail may START (and keep) loading.
// Deliberately about one screenful, not more: the same boundary is the abort
// line, and over HTTP/1.1 an in-flight request occupies one of the ~6
// per-origin connections until it finishes - so trailing tiles a scroll left
// behind must abort PROMPTLY to free the pipe for the region the user
// actually stopped at. Deeper look-ahead is the prewarm pass's job
// (preloadImage above: low priority, debounced, uncancellable but polite).
const START_MARGIN = "900px 0px";

// "Actually at/entering the screen": tiles inside this tight band fetch at
// high priority, everything else at low - the visible region always wins the
// connection queue over speculative preloads.
const VIEW_MARGIN = "150px 0px";

interface NearViewportCallbacks {
  enter: () => void;
  leave: () => void;
}

// One shared IntersectionObserver per margin (not one per tile).
function makeWatcher(rootMargin: string) {
  let observer: IntersectionObserver | null = null;
  const callbacks = new Map<Element, NearViewportCallbacks>();
  return function watch(el: Element, cbs: NearViewportCallbacks): () => void {
    if (!observer) {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const c = callbacks.get(entry.target);
            if (!c) continue;
            if (entry.isIntersecting) c.enter();
            else c.leave();
          }
        },
        { rootMargin }
      );
    }
    callbacks.set(el, cbs);
    observer.observe(el);
    return () => {
      callbacks.delete(el);
      observer?.unobserve(el);
    };
  };
}

// Track whether `el` is within the load margin of the viewport: `enter` fires
// when it comes near, `leave` when it moves far away again. During a fast
// scroll a tile can enter and leave within one frame batch - callers use the
// leave signal to cancel work (a debounce timer, an in-flight request) that
// only made sense while the tile was still approaching. Returns the
// unsubscribe for effect cleanup. Note the observer also fires once right
// after subscribing, reporting the initial state - a leave() for an
// off-screen tile - so leave handlers must be no-ops when nothing started.
export const watchNearViewport = makeWatcher(START_MARGIN);

// Same contract, tight margin: is the tile at (or a beat away from) the
// actual viewport? Drives fetch priority, not loading itself.
export const watchInViewport = makeWatcher(VIEW_MARGIN);

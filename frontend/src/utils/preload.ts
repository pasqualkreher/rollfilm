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
// speed; six gives fast flippers real headroom - a held arrow key outruns a
// window of four, and now that staged RAW previews are pre-rendered rather
// than demosaiced per request, filling a wider window is a handful of file
// reads instead of seconds of decoding. Still bounded by the renderer's RAM
// (~11MB decoded each), which is what keeps this from simply growing.
export const LIGHTBOX_NEIGHBOR_DEPTH = LOW_MEMORY_DEVICE ? 2 : 6;

// URLs requested RECENTLY - a repeat new Image() for one of these would be
// pure overhead, the browser's cache still holds the bytes. Deliberately a
// bounded LRU, not a grows-forever set: over a long session the browser
// evicts images from its caches, and a permanent "already preloaded" marker
// made every preload one-shot - revisited areas then paged cold and never
// re-warmed, which read as the app getting slower the longer it ran.
//
// The cap must comfortably exceed one browsing session's working set, or the
// marker evicts its own entries faster than the user comes back to them and
// stops deduplicating anything.
class RecentUrls {
  private urls = new Map<string, true>();

  constructor(private readonly max: number) {}

  has(url: string): boolean {
    if (!this.urls.has(url)) return false;
    // Refresh recency, so the URLs of the area being browsed right now are the
    // last to age out.
    this.urls.delete(url);
    this.urls.set(url, true);
    return true;
  }

  add(url: string): void {
    this.urls.delete(url);
    this.urls.set(url, true);
    if (this.urls.size > this.max) this.urls.delete(this.urls.keys().next().value!);
  }

  delete(url: string): void {
    this.urls.delete(url);
  }
}

const preloadedUrls = new RecentUrls(2000);

// Thumbnails that have finished loading at least once. Their bytes are then in
// the browser's HTTP cache - derivatives are served immutable and versioned by
// edit (see images._serve_derivative) - so asking for one again costs no
// network at all. That is what lets a tile the user has already seen come back
// instantly: it goes straight to its src on the first render, skipping the
// stabilize delay, the fast-scroll gate and the shimmer, none of which buy
// anything when there is nothing to wait for. Without it, scrolling back over
// ground you just covered made every photo fade in again from grey.
//
// Deliberately URL strings only, no Image objects: pinning decoded pixels
// instead would hold ~1MB per XS tile across hundreds of tiles, which is the
// very thing releaseMarginFor exists to prevent. The browser's cache is the
// pixel store; this is only the memo of what is in it. Sized well past a long
// browsing session (a few hundred KB of strings at worst) so the memo doesn't
// age out faster than the cache it describes.
const loadedThumbUrls = new RecentUrls(20000);

export function markThumbLoaded(url: string): void {
  loadedThumbUrls.add(url);
}

export function isThumbLoaded(url: string): boolean {
  return loadedThumbUrls.has(url);
}

// The browser evicted it after all (or the render was invalidated): drop the
// memo, so the tile goes back through the normal patient path instead of
// insisting on an instant paint that can't happen.
export function forgetThumbLoaded(url: string): void {
  loadedThumbUrls.delete(url);
}

export function preloadImage(url: string | null | undefined): void {
  if (!url) return;
  if (preloadedUrls.has(url)) return;
  preloadedUrls.add(url);
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

// How far outside the viewport a thumbnail may START (and keep) loading:
// several rows in each direction, so a row has long finished loading by the
// time it reaches the screen and scrolling meets photos rather than shimmer.
//
// Counted in ROWS, not pixels, because the cost is per TILE: the same pixel
// band holds four times as many tiles at XS (130px rows) as at M (260px) and
// twelve times as many as at XL, so one fixed number is either too little
// look-ahead for the big sizes or hundreds of speculative requests for the
// small ones.
//
// This is also the number overscanFor (utils/justifiedLayout.ts) derives the
// MOUNTED band from - a virtualized grid can only load a tile it has mounted,
// so growing the look-ahead without growing the mounted band does nothing.
//
// Ten rows is deliberately generous: the point is that the user never catches
// the grid loading. At a readable scroll speed that is several seconds of
// lead, so a row has long since finished by the time it reaches the screen,
// and the rows they scroll back over are already in the browser cache.
//
// The floor keeps a useful lead at XS, where ten rows are barely any pixels.
// The ceiling only guards against absurdity - it must stay clear of ten rows
// at every real tile size, because clamping it in pixels is exactly the
// mistake this is counted in rows to avoid: XL rows are 4x the height of XS
// rows but hold a QUARTER of the tiles, so a pixel cap bites hardest where the
// look-ahead is cheapest.
const PRELOAD_ROWS = 10;

export function loadMarginFor(rowHeight: number): number {
  return Math.round(Math.min(6000, Math.max(700, rowHeight * PRELOAD_ROWS)));
}

// "On screen, or the next rows about to be": tiles inside this band fetch at
// high priority, everything else at low - what the user is looking at, and
// what they are about to be looking at, always win the connection queue over
// the rest of the look-ahead.
//
// Two rows rather than a fixed 150px, which was less than one row at every
// size above XS: the row about to scroll in is the single most urgent request
// on the page, and it was queueing behind ten rows of speculative loads.
function viewMarginFor(rowHeight: number): number {
  return Math.round(Math.max(300, rowHeight * 2));
}

// Past this, a loaded tile lets its pixels go again.
//
// A grid thumbnail is up to 1600px on the long edge - around 7MB once decoded.
// Keeping every tile ever scrolled past meant a 800-photo import held gigabytes
// in the renderer, at which point the browser starts discarding decoded images
// on its own; the ones it discards can come back broken, which is what put
// broken-image glyphs on cards in the review grid. Releasing deliberately keeps
// the retained set bounded instead of letting it grow with how far the user has
// scrolled.
//
// Six rows beyond the load margin, so a tile can't load and release in a loop
// while the user rocks back and forth; coming back inside it is a browser-cache
// hit rather than a fresh render on the server. Derived from the load margin
// rather than clamped in pixels, which would be a real bug and not just a
// mistuning: a pixel cap below the load margin at the big tile sizes would put
// the release line INSIDE the band where tiles are told to load, and every tile
// in the overlap would load, release, and load again.
//
// The six rows also put it beyond the mounted band (overscanFor, two rows), so
// this only ever fires for the unvirtualized grid - elsewhere unmounting frees
// the tile first, which is stricter still.
function releaseMarginFor(rowHeight: number): number {
  return Math.round(loadMarginFor(rowHeight) + rowHeight * 6);
}

// Grid size to assume when a caller doesn't say (M - see THUMB_SIZES).
const DEFAULT_ROW_HEIGHT = 260;

// --- scroll activity -------------------------------------------------------
//
// A backstop for one case only: the view moving so fast that the grid is not
// being looked at at all, but dragged through - a scrubber drag maps a few
// hundred pixels of rail onto the whole library, so one drag sweeps hundreds
// of thousands of pixels of grid and would fire (and abort) a request for
// every tile on the way.
//
// It used to hold back ordinary flings too, and that was the wrong call: the
// look-ahead only works if it is filling WHILE the user scrolls. Holding
// everything back until the scroll stopped meant the band was empty exactly
// when it was needed, and then several hundred tiles set their src in the same
// tick when it released - one long frame, which is what read as stutter.

// Above this the view is being dragged, not scrolled. Far above any real
// gesture: a hard trackpad fling peaks around 5-8 px/ms and must keep loading
// as it goes, while a scrubber drag runs to hundreds of px/ms.
const FAST_SCROLL_PX_PER_MS = 20;

// Scroll events stop arriving when the scroll stops, so a window with no event
// in it is the only "the gesture ended" signal there is. Also the re-check
// interval while a fast scroll is still going.
const SCROLL_CALM_MS = 90;

let lastScrollTarget: EventTarget | null = null;
let lastScrollPos = 0;
let lastScrollAt = 0;
let scrollingFast = false;
let calmTimer: number | null = null;

function scrollPosOf(target: EventTarget | null): number {
  if (!target || target === document || target === window) return window.scrollY;
  return (target as HTMLElement).scrollTop ?? 0;
}

function armCalmTimer(): void {
  if (calmTimer !== null) return;
  calmTimer = window.setTimeout(() => {
    calmTimer = null;
    // A whole window with no scroll event: the gesture is over.
    if (performance.now() - lastScrollAt >= SCROLL_CALM_MS) scrollingFast = false;
    if (scrollingFast) armCalmTimer();
  }, SCROLL_CALM_MS);
}

// Is the view being dragged rather than scrolled right now? For the one caller
// that starts a load outside afterScrollSettles - the on-screen backstop in
// Thumb - which would otherwise be the hole in this gate.
export function isScrollingFast(): boolean {
  return scrollingFast;
}

// Scroll events don't bubble, but they DO run through the capture phase - so
// one document-level listener sees every scroller in the app (the page, the
// timeline, the import review) without each of them having to report in.
document.addEventListener(
  "scroll",
  (e) => {
    const now = performance.now();
    const pos = scrollPosOf(e.target);
    const dt = now - lastScrollAt;
    // A different scroller, or the first event after a pause: no two samples
    // to measure a speed from yet. A scrubber jump lands here too, and that is
    // correct - it teleports rather than dragging the view across the library,
    // so nothing in between is ever requested and there is nothing to hold
    // back.
    if (e.target !== lastScrollTarget || dt > SCROLL_CALM_MS * 3) {
      scrollingFast = false;
    } else if (dt > 0) {
      scrollingFast = Math.abs(pos - lastScrollPos) / dt >= FAST_SCROLL_PX_PER_MS;
    }
    lastScrollTarget = e.target;
    lastScrollPos = pos;
    lastScrollAt = now;
    armCalmTimer();
  },
  { capture: true, passive: true }
);

// Everything waiting out the stabilize delay sits in ONE queue behind ONE
// timer, rather than each caller holding its own.
//
// A timer per caller is a TASK per caller, and at the end of a scrubber jump
// the entire mounted band comes due at the same moment - hundreds of tiles at
// the small grid sizes on a wide window. As separate tasks React commits each
// tile's src on its own and the browser gets a chance to re-render between
// every one of them; that run of hundreds of commits is the hitch right after
// a fast scrub. Released together, inside a single task, React batches them
// into one render and the browser starts the requests as one group it can
// prioritize among.
//
// The trade is that the wait becomes a sliding 0..delay window rather than
// exactly `delay` per caller - a tile joining a queue whose timer was armed
// 39ms ago waits 1ms. That is fine for what the delay is for: it filters tiles
// that flicker through the load margin, and the case it really guards against -
// a scrubber drag - is held by scrollingFast until the gesture ends, not by
// this timer.
interface PendingWait {
  // Nulled by the caller's cancel, so work can still be called off after its
  // batch has been taken off the queue.
  run: (() => void) | null;
}

const pendingWaits = new Set<PendingWait>();
let flushTimer: number | null = null;

function scheduleFlush(delay: number): void {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    // Mid-gesture: keep the queue held and re-check on the same interval, so
    // the whole of it is released within one `delay` of the drag ending.
    if (scrollingFast) {
      scheduleFlush(delay);
      return;
    }
    const batch = [...pendingWaits];
    pendingWaits.clear();
    for (const wait of batch) wait.run?.();
  }, delay);
}

// Run `fn` once the view has been still for up to `delay` ms - and never in the
// middle of a fast scroll, where it waits for the scroll to calm down first.
// Returns a cancel function; callers cancel when whatever made the work worth
// doing stops being true (a tile leaving the load margin again, or unmounting).
export function afterScrollSettles(fn: () => void, delay: number): () => void {
  const wait: PendingWait = { run: null };
  wait.run = () => {
    wait.run = null;
    fn();
  };
  pendingWaits.add(wait);
  scheduleFlush(delay);

  return () => {
    wait.run = null;
    pendingWaits.delete(wait);
  };
}

interface NearViewportCallbacks {
  enter: () => void;
  leave: () => void;
}

type Watch = (el: Element, cbs: NearViewportCallbacks) => () => void;

// One shared IntersectionObserver per margin (not one per tile).
function makeWatcher(rootMargin: string): Watch {
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

// The margins now depend on the grid's tile size, so there is one observer per
// distinct margin rather than one per band. Bounded by construction: the sizes
// come from the five THUMB_SIZES, and rounding folds near-identical margins
// (e.g. two grids whose rows differ by a pixel) onto the same observer.
function watcherFor(cache: Map<number, Watch>, marginPx: number): Watch {
  const key = Math.round(marginPx / 50) * 50;
  let watch = cache.get(key);
  if (!watch) {
    watch = makeWatcher(`${key}px 0px`);
    cache.set(key, watch);
  }
  return watch;
}

const nearWatchers = new Map<number, Watch>();
const viewWatchers = new Map<number, Watch>();
const farWatchers = new Map<number, Watch>();

// Track whether `el` is within the load margin of the viewport: `enter` fires
// when it comes near, `leave` when it moves far away again. During a fast
// scroll a tile can enter and leave within one frame batch - callers use the
// leave signal to cancel work (a debounce timer, an in-flight request) that
// only made sense while the tile was still approaching. Returns the
// unsubscribe for effect cleanup. Note the observer also fires once right
// after subscribing, reporting the initial state - a leave() for an
// off-screen tile - so leave handlers must be no-ops when nothing started.
//
// `rowHeight` is the grid's tile size, which is what the look-ahead is measured
// in (see PRELOAD_ROWS); a caller that re-renders at a new size must re-watch.
export function watchNearViewport(
  el: Element,
  cbs: NearViewportCallbacks,
  rowHeight: number = DEFAULT_ROW_HEIGHT
): () => void {
  return watcherFor(nearWatchers, loadMarginFor(rowHeight))(el, cbs);
}

// Same contract, tight margin: is the tile on screen or in the next rows about
// to be? Drives fetch priority, not loading itself.
export function watchInViewport(
  el: Element,
  cbs: NearViewportCallbacks,
  rowHeight: number = DEFAULT_ROW_HEIGHT
): () => void {
  return watcherFor(viewWatchers, viewMarginFor(rowHeight))(el, cbs);
}

// Same contract, wide margin: `leave` means "far enough away that holding this
// tile's pixels costs more than re-reading them later" (see releaseMarginFor).
export function watchFarFromViewport(
  el: Element,
  cbs: NearViewportCallbacks,
  rowHeight: number = DEFAULT_ROW_HEIGHT
): () => void {
  return watcherFor(farWatchers, releaseMarginFor(rowHeight))(el, cbs);
}

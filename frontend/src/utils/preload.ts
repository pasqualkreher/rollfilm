// Warm the browser's image cache ahead of user interaction, so pixels are
// already in memory when they're needed: grid thumbnails start loading well
// before they scroll into view, and the detail view / import lightbox load
// each photo's neighbors while the current one is on screen - flipping with
// the arrow keys then swaps instantly instead of waiting on a request.

// URLs already requested once. A repeat new Image() for the same URL would be
// pure overhead - the browser's HTTP cache already holds the bytes.
const preloadedUrls = new Set<string>();

export function preloadImage(url: string | null | undefined): void {
  if (!url || preloadedUrls.has(url)) return;
  preloadedUrls.add(url);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
}

// How far outside the viewport a thumbnail starts loading. Native
// loading="lazy" leaves this distance to the browser (and Safari in
// particular waits until the image is nearly visible, which reads as pop-in
// while scrolling); a shared IntersectionObserver with a generous margin
// makes the preload distance explicit and consistent.
const PRELOAD_MARGIN = "2500px 0px";

interface NearViewportCallbacks {
  enter: () => void;
  leave: () => void;
}

let observer: IntersectionObserver | null = null;
const callbacks = new Map<Element, NearViewportCallbacks>();

function getObserver(): IntersectionObserver {
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const cbs = callbacks.get(entry.target);
          if (!cbs) continue;
          if (entry.isIntersecting) cbs.enter();
          else cbs.leave();
        }
      },
      { rootMargin: PRELOAD_MARGIN }
    );
  }
  return observer;
}

// Track whether `el` is within the preload margin of the viewport: `enter`
// fires when it comes near, `leave` when it moves far away again. During a
// fast scroll a tile can enter and leave within one frame batch - callers use
// the leave signal to cancel work (a debounce timer, an in-flight request)
// that only made sense while the tile was still approaching. Returns the
// unsubscribe for effect cleanup. Note the observer also fires once right
// after subscribing, reporting the initial state - a leave() for an
// off-screen tile - so leave handlers must be no-ops when nothing started.
export function watchNearViewport(el: Element, cbs: NearViewportCallbacks): () => void {
  callbacks.set(el, cbs);
  getObserver().observe(el);
  return () => {
    callbacks.delete(el);
    observer?.unobserve(el);
  };
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useNavigate } from "react-router-dom";
import type { ImageOut } from "../api/types";
import { api, editVersion } from "../api/client";
import { COLOR_HEX } from "./ColorLabelPicker";
import { IconX } from "./Icons";
import { usePhotoInfoCard } from "./PhotoInfoCard";
import { TimelineScrubber } from "./TimelineScrubber";
import { thumbPx, thumbTier, useMergePairs, useThumbSize } from "../state/viewPrefs";
import {
  afterScrollSettles,
  forgetThumbLoaded,
  isScrollingFast,
  isThumbLoaded,
  markThumbLoaded,
  watchFarFromViewport,
  watchInViewport,
  watchNearViewport,
} from "../utils/preload";
import { clearLastViewedImage, peekLastViewedImage } from "../utils/lastViewed";

interface Props {
  images: ImageOut[];
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string, index: number, shiftKey: boolean) => void;
  selectMode?: boolean;
  // Immich-style timeline: break the grid into "Month Year" sections with
  // sticky headers. The list is expected to already be sorted newest-first.
  groupByDate?: boolean;
  // Optional per-photo remove (e.g. "remove from this album"); shown as an ×
  // when not in select mode.
  onRemove?: (id: string) => void;
  removeTitle?: string;
}

// Short badge shown on every thumbnail so the file kind is obvious at a glance.
// "RAW+JPG" only when this one card stands in for a merged pair; when both
// halves are shown as separate cards, each shows its own type (RAW / JPG / PNG).
export function fileTypeBadge(fileType: string, merged: boolean): string {
  if (merged) return "RAW+JPG";
  return fileType === "jpeg" ? "JPG" : fileType.toUpperCase();
}

// Badge class so RAW (and merged pairs) get a distinct color from JPG — the
// text alone is too small to tell the kinds apart when scanning a grid.
export function fileTypeBadgeClass(fileType: string, merged: boolean, base = "badge"): string {
  if (merged) return `${base} badge-pair`;
  return fileType === "raw" ? `${base} badge-raw` : base;
}

// Aspect ratio (width/height) used to size a justified grid tile. Clamped so a
// stray panorama or missing dimensions can't blow a row's height out; falls back
// to 3:2 landscape when the photo has no known dimensions.
export function tileAspectRatio(width: number | null | undefined, height: number | null | undefined): number {
  if (!width || !height) return 1.5;
  return Math.min(2.5, Math.max(0.5, width / height));
}

// Inline CSS custom property the justified grid reads for each tile's width.
export function tileStyle(width: number | null | undefined, height: number | null | undefined) {
  return { "--ar": tileAspectRatio(width, height) } as CSSProperties;
}

// Delay before a tile entering the load margin actually issues its request. A
// tile that merely flickers through the margin - a scrubber drag passing over
// it, a layout settling - leaves it again within this window and never hits
// the network at all.
//
// Short on purpose. It sits in front of EVERY tile, and with ten rows of
// look-ahead the whole point is that the band is already full by the time the
// user gets there; a delay long enough to be a filter is also long enough to
// be the reason the row underneath the fold is still grey.
const LOAD_STABILIZE_MS = 40;

// How long a tile that expects to paint from cache is allowed to stay blank
// before it gives up on that and shows the shimmer after all. A real cache hit
// paints within a frame or two; anything past this is a request that is
// actually going somewhere, and the user should see that it is.
const INSTANT_GRACE_MS = 150;

// How long a tile on screen may take to show a picture. This is a product
// requirement, not a tuning knob: everything below that could make the user
// wait is sized against it, and anything that cannot be bounded by it has to
// serve a stand-in instead of a wait (see the on-disk fallback chain in
// electron/main.js).
//
// It cannot cover one case, and no amount of client-side tuning could: a photo
// whose derivatives have never been rendered has no pixels to show anywhere, at
// any size. Those tiles shimmer and keep asking - see the tail of the ladder.
export const THUMB_BUDGET_MS = 1500;

// A thumbnail can legitimately not exist yet: right after an import the backend
// generates derivatives in the background and sheds on-demand renders it can't
// start promptly (503 + Retry-After, see images._serve_derivative) so a whole
// grid scrolling into view can't stall the API. Retry on a backoff instead of
// leaving the tile shimmering forever.
//
// Two ladders in one. The first three steps sum to well under THUMB_BUDGET_MS,
// so anything transient - a shed request, an aborted fetch, a request that lost
// its connection to a burst of neighbours - is recovered from inside the budget
// rather than after it. That is what this front half is for; it used to open
// with 1200ms, which spent the whole budget before the second attempt was even
// made.
//
// The tail is for the one case the budget cannot reach: a derivative that does
// not exist yet, where retrying faster changes nothing except load on the
// backend that is busy generating it. It still reaches ~68s in total,
// deliberately - a ladder that gave up after 19s left permanent holes in a
// library that was only busy, not broken.
//
// The last delay is the give-up point. Scrolling away and back starts over, and
// so does scrolling the tile into the viewport (see ensureLoading), which is
// the moment the user actually cares.
const RETRY_DELAYS_MS = [200, 400, 800, 2500, 5000, 10000, 20000, 30000];

// How long an exhausted tile waits before asking once more.
//
// Past the ladder a tile used to stop for good, and the only thing that ever
// re-armed it was ensureLoading - which fires when a tile ENTERS the load
// margin, something a tile already sitting in the viewport never does again.
// That is survivable when one derivative is missing, and not survivable when
// the whole library is briefly unreachable: a library on a NAS whose disk has
// spun down needs longer to wake and reconnect than the ladder lasts, so every
// visible tile burns its attempts against a volume that is still coming back
// and the grid stays a wall of empty cards until the app is restarted. The
// revive below is what makes that repair itself. It is deliberately slow - the
// case it exists for resolves in tens of seconds, and a tile with nothing to
// show costs nothing by waiting - while the shared triggers (see onRevive) do
// the same immediately when the user comes back to the window.
const REVIVE_DELAY_MS = 45000;

// Moments when a tile that gave up is worth waking: the window coming back to
// the foreground, the tab becoming visible, the network returning. All three
// mean "something about the environment changed", which is exactly when the
// unreachable volume behind an empty grid tends to be reachable again.
//
// One set of listeners for the whole grid, not three per tile: a grid can hold
// hundreds of exhausted tiles at once.
const reviveSubscribers = new Set<() => void>();

function emitRevive() {
  for (const fn of [...reviveSubscribers]) fn();
}

if (typeof window !== "undefined") {
  window.addEventListener("focus", emitRevive);
  window.addEventListener("online", emitRevive);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") emitRevive();
  });
}

function onRevive(fn: () => void): () => void {
  reviveSubscribers.add(fn);
  return () => {
    reviveSubscribers.delete(fn);
  };
}

// Grid thumbnail that starts loading shortly after it comes within the
// preload margin of the viewport (see utils/preload.ts) - well before it's
// visible. Replaces native loading="lazy", whose preload distance is
// browser-chosen and (especially in Safari) short enough to read as pop-in.
// The current view always wins the network: nothing requests while the grid is
// being flung past and the stabilize delay keeps fly-by tiles from requesting
// at all; a tile that scrolls back out of the (few rows deep) load margin
// aborts its in-flight request (src cleared), freeing one of the ~6 HTTP/1.1
// connections; and fetch priority follows actual visibility - on-screen tiles
// request high, margin tiles low. A loaded tile stays loaded while it is
// anywhere near the viewport and only lets its pixels go once it is far behind
// (releaseMarginFor), which keeps the renderer's image memory bounded on a grid
// of thousands. Also used by the import review grid, which otherwise fired
// every staged request at once.
//
// `rowHeight` is the grid's current tile size: both margins are measured in
// rows, so the look-ahead is the same few rows at XS as at XL.
export function Thumb({
  src,
  alt,
  rowHeight,
}: {
  src: string;
  alt: string;
  rowHeight?: number;
}) {
  const ref = useRef<HTMLImageElement | null>(null);
  // A thumbnail this session has already loaded is in the browser's cache, so
  // it starts with its src set: it paints from the very first render, with no
  // observer round-trip, no stabilize delay and no shimmer over a photo the
  // user has already seen. Everything else starts blank and earns its request.
  const [shownSrc, setShownSrc] = useState<string | undefined>(() =>
    isThumbLoaded(src) ? src : undefined
  );
  // Whether the pixels currently being waited on are expected to be there
  // already. Drives everything about how the tile APPEARS: an instant tile
  // shows no shimmer and does not fade (there is nothing to wait for, and
  // animating it would make scrolling back over seen photos look like they are
  // all loading again), a fresh one shimmers and then eases in.
  //
  // It is a GUESS - the memo says the browser cached this URL, but the browser
  // evicts what it likes and the request can still fail. Being wrong must
  // therefore be survivable, which is what the grace timer below is for: a
  // tile that claims to be instant and then isn't falls back to the normal
  // appearance instead of sitting there as an empty card.
  const [instant, setInstant] = useState(shownSrc !== undefined);
  const doneRef = useRef(false);

  // Point the element at `url`, recording whether that is expected to be a
  // cache hit. Every path that sets a src goes through here, so the appearance
  // can never drift from what was actually asked for.
  const show = useCallback((url: string, isInstant: boolean) => {
    setInstant(isInstant);
    setShownSrc(url);
  }, []);
  // Tiles stay visually blank (just the card background) until the pixels
  // have actually arrived - never a broken-image glyph or alt text flash
  // while pending/aborted.
  const [visible, setVisible] = useState(false);
  // Waiting out a backoff between retries. Keeps the shimmer up (src is cleared
  // during the gap) so a tile whose derivative is still being generated reads as
  // loading rather than as an empty card.
  const [retrying, setRetrying] = useState(false);
  const retryCount = useRef(0);
  const retryTimer = useRef<number | null>(null);
  // Set once the ladder is spent. Drives the revive below - and nothing about
  // how the tile looks, which is the same empty card either way.
  const [exhausted, setExhausted] = useState(false);
  // Plain ref, not state: visibility changes constantly while scrolling and
  // must never itself cause a render.
  const inViewRef = useRef(false);

  // Bring an exhausted tile back: on the slow timer, or the moment the
  // environment changes under it (see onRevive). Only mounted, still-spent
  // tiles subscribe, and a successful load clears `exhausted` through the
  // load handler, so the loop settles by itself once the volume is back.
  useEffect(() => {
    if (!exhausted) return;
    const revive = () => {
      retryCount.current = 0;
      setExhausted(false);
      show(src, false);
    };
    const timer = window.setTimeout(revive, REVIVE_DELAY_MS);
    const unsubscribe = onRevive(revive);
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [exhausted, src, show]);

  // A tile that finished loading can still end up broken later: under memory
  // pressure the browser discards decoded pixels and silently re-fetches, and
  // that fetch can fail. It does NOT reliably fire `error` again for an image
  // that already completed - which is why relying on the error handler alone
  // left cards showing the broken-image glyph and their filename. So check the
  // image itself whenever a tile comes back on screen: `complete` with a
  // naturalWidth of 0 is the browser's own "this is broken" state. Repairing
  // means dropping back to not-loaded and letting the normal path re-request.
  const repairIfBroken = useCallback(() => {
    const el = ref.current;
    if (!el || !doneRef.current) return;
    if (el.complete && el.naturalWidth === 0) {
      doneRef.current = false;
      retryCount.current = 0;
      // Whatever the cache holds for this URL is not usable, so stop claiming
      // it can paint instantly.
      forgetThumbLoaded(src);
      setVisible(false);
      setShownSrc(undefined);
      // Next frame, so the browser really drops the failed image before the
      // same URL is asked for again (re-assigning an unchanged src is a no-op).
      requestAnimationFrame(() => show(src, false));
    }
  }, [src, show]);

  // Unmounting mid-flight (a long jump in the virtualized grid): abort the
  // request imperatively - React only discards the node, the browser would
  // finish the download anyway. Freeing the connection means the newest
  // viewport's thumbnails always win over stale ones.
  //
  // Its own effect with no deps, so the cleanup runs ONLY on unmount. It used
  // to hang off the load effect, whose cleanup also runs on every src and
  // rowHeight change - so changing the grid size while tiles were loading tore
  // the src attribute off elements that were staying, behind React's back.
  // React still had the URL in state, saw no change to render, and never put
  // the attribute back: those tiles shimmered forever without a request.
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el && !doneRef.current && el.getAttribute("src")) el.removeAttribute("src");
    };
  }, []);

  // Last line of defence against an empty card. The tile is ON SCREEN with
  // nothing shown, nothing loaded and nothing in flight - whatever the reason
  // (the retry ladder ran out, a watcher missed an edge, a release with no
  // request to follow it), the user is looking straight at a hole and the only
  // right move is to ask for the photo again.
  //
  // The img element is the source of truth for "is something in flight", not a
  // piece of React state: it is what the browser is actually acting on, and it
  // cannot drift from it.
  //
  // Deliberately only on ENTERING the viewport, not on every render: a
  // thumbnail that truly cannot be served (the derivative does not exist)
  // would otherwise retry forever. Entering is a real user action, so it is
  // both bounded and exactly when a fresh attempt is worth making.
  const ensureLoading = useCallback(() => {
    const el = ref.current;
    if (!el || doneRef.current) return;
    // A pending backoff is abandoned rather than waited out. This used to
    // return early while a retry timer was set, which meant a tile that had
    // failed once could be scrolled INTO VIEW and still sit grey for the rest
    // of its backoff - up to half a minute at the far end of the ladder, with
    // the user looking straight at it. The ladder is for a tile the user is not
    // watching; the moment they are, the only acceptable answer is to ask now.
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
      setRetrying(false);
    } else if (el.getAttribute("src")) {
      // Something is already in flight and nothing is waiting on a timer.
      return;
    }
    retryCount.current = 0;
    setExhausted(false);
    show(src, isThumbLoaded(src));
    // And put it on the element directly. React state may ALREADY hold this
    // exact URL while the attribute is missing - then setting the state again
    // changes nothing, React re-renders nothing, and the element stays empty
    // forever. Writing both is what makes this a guarantee rather than a
    // second opinion.
    el.setAttribute("src", src);
  }, [src, show]);

  // Re-checked on render, but only for a tile that is actually on screen: an
  // unvirtualized grid can have thousands of these mounted at once, and doing
  // DOM work per render for every one of them is exactly the kind of
  // per-tile-per-render cost that makes a big grid crawl. Off-screen tiles get
  // their check when they scroll back in (below).
  useEffect(() => {
    if (inViewRef.current) repairIfBroken();
  });

  // The "already cached, will paint immediately" guess was wrong: whatever the
  // memo says, this tile has been sitting there with a src and nothing to show
  // for it. Drop back to the normal appearance so it shimmers like any other
  // loading tile and eases in when it arrives.
  //
  // Without this, being wrong is invisible AND silent - the shimmer is
  // suppressed for an instant tile, so a request that is slow, shed by the
  // backend (503 + Retry-After) or failing leaves a blank card with no
  // indication that anything is happening at all.
  useEffect(() => {
    if (!instant || visible || !shownSrc) return;
    const timer = window.setTimeout(() => setInstant(false), INSTANT_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [instant, visible, shownSrc]);

  // Let go of a tile that has been left far behind. Without this the renderer
  // holds every thumbnail the user ever scrolled past (~7MB decoded each), and
  // a big grid grows until the browser starts discarding images itself - the
  // discarded ones are what came back broken. Coming back re-reads it from the
  // browser cache, which is why this can afford to be strict.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return watchFarFromViewport(
      el,
      {
        // Fires once on subscribe for an off-screen tile, when nothing is
        // loaded yet - the guard below makes that a no-op.
        enter: () => {},
        leave: () => {
          if (!doneRef.current) return;
          doneRef.current = false;
          retryCount.current = 0;
          setVisible(false);
          setShownSrc(undefined);
        },
      },
      rowHeight
    );
  }, [rowHeight]);

  // Fetch priority follows actual visibility: at/near the screen -> high,
  // merely inside the load margin -> low. The browser reads the attribute
  // when the request starts (and newer Chromium also re-prioritizes
  // in-flight requests), so the photos the user is looking at always queue
  // ahead of speculative preloads on the shared connections.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.setAttribute("fetchpriority", "low");
    return watchInViewport(
      el,
      {
        enter: () => {
          inViewRef.current = true;
          el.setAttribute("fetchpriority", "high");
          repairIfBroken();
          // Not while the view is being DRAGGED. A scrubber drag sweeps the
          // whole library through the viewport, so every tile on the way
          // "enters" it - and this path sets src directly, without the
          // stabilize delay that holds the rest of the grid back. Each of
          // those requests reached the backend and was aborted a frame later
          // when the tile unmounted, leaving it busy rendering thumbnails
          // nobody would ever see while the photos at the landing spot queued
          // behind them. The near-viewport watcher already has these tiles
          // waiting; they load together the moment the drag stops.
          if (!isScrollingFast()) ensureLoading();
        },
        leave: () => {
          inViewRef.current = false;
          el.setAttribute("fetchpriority", "low");
        },
      },
      rowHeight
    );
  }, [repairIfBroken, ensureLoading, rowHeight]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Loaded once already - follow src changes (edit-version bumps) straight
    // away; the watcher below then no-ops for as long as doneRef holds.
    //
    // It is subscribed either way, and that matters: this effect re-runs on
    // every grid-size change (rowHeight), and at M/L/XL the URL does not
    // change with it, so a loaded tile used to return here without a watcher
    // at all. The far watcher can still RELEASE that tile later - and with
    // nothing observing it, nothing was left to ever bring it back. It stayed
    // an empty card until the grid was rebuilt.
    if (doneRef.current) show(src, isThumbLoaded(src));
    // Followed the src to a URL that is itself already cached (an edit-version
    // bump back to a render seen earlier): same shortcut as on mount.
    else if (isThumbLoaded(src)) show(src, true);

    let cancelLoad: (() => void) | null = null;
    const unwatch = watchNearViewport(
      el,
      {
        enter: () => {
          if (doneRef.current) return;
          // Cached: there is nothing to stabilize against and no connection to
          // queue for, so waiting would only make the user watch a photo they
          // have already seen come back slowly. Re-checked here rather than
          // remembered, because the browser can drop a cache entry at any time
          // and the answer is one Map lookup.
          if (isThumbLoaded(src)) {
            show(src, true);
            return;
          }
          if (cancelLoad === null) {
            cancelLoad = afterScrollSettles(() => {
              cancelLoad = null;
              show(src, false);
            }, LOAD_STABILIZE_MS);
          }
        },
        leave: () => {
          if (cancelLoad !== null) {
            cancelLoad();
            cancelLoad = null;
          }
          // Scrolled away mid-backoff: drop the pending retry and start the
          // budget over, so coming back later gets a fresh set of attempts.
          if (retryTimer.current !== null) {
            window.clearTimeout(retryTimer.current);
            retryTimer.current = null;
          }
          retryCount.current = 0;
          setRetrying(false);
          // Far away again with the request still in flight: removing src makes
          // the browser abort it. No-op when the image already finished - a
          // loaded tile keeps its pixels until the release margin, cached or
          // not. A cached tile that is still loading gets dropped like any
          // other: "cached" is a memo that can be wrong (the browser evicts
          // what it likes), and if it is wrong this is a real network request
          // that must not survive being scrolled away from. Coming back is
          // instant either way - `enter` re-sets it without the delay.
          if (!doneRef.current) setShownSrc(undefined);
        },
      },
      rowHeight
    );
    return () => {
      cancelLoad?.();
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      unwatch();
    };
  }, [src, rowHeight, show]);

  return (
    <>
      {/* While a tile has requested its thumbnail but the pixels haven't
          arrived yet, fill the card with the same shimmer the Albums skeleton
          cards use - so freshly imported/loading photos animate instead of
          sitting as flat grey blocks. Only shown for tiles actually loading
          (src set, not yet loaded), never for far-off tiles that haven't
          started. Also kept up across a retry backoff, when src is cleared.
          A cached tile skips it: it paints within a frame or two, and a
          shimmer that brief on a photo the user has already seen reads as a
          flicker rather than as loading. If the cache turns out to be gone
          after all, the error path drops the memo and the shimmer comes back
          with the retry.
          Deliberately NOT unmounted the moment the photo arrives: it stays and
          fades out under the image easing in on top (.is-done), so the tile
          resolves from shimmer to photo instead of blinking through the bare
          card in between. */}
      {(shownSrc || retrying) && !instant && (
        <div className={`thumb-skeleton${visible ? " is-done" : ""}`} aria-hidden />
      )}
      <img
        ref={ref}
        src={shownSrc}
        decoding="async"
        alt={alt}
        // Blank (opacity 0, see .thumb-card img in index.css) until the pixels
        // are actually there - so a pending, aborted or failed request shows
        // the card background, never a broken-image glyph or the alt text.
        // `is-instant` suppresses the ease-in for pixels that were already
        // cached; everything else eases up out of its shimmer.
        className={
          `${visible ? "is-loaded" : ""}${instant ? " is-instant" : ""}`.trim() || undefined
        }
        onLoad={() => {
          doneRef.current = true;
          // Remember the URL, not the pixels: coming back to this photo later
          // is then a browser-cache hit that paints straight away. `shownSrc`,
          // not `src` - they differ for the render between an edit-version
          // bump and the effect that follows it, and what the browser just
          // cached is what the element was actually pointed at.
          if (shownSrc) markThumbLoaded(shownSrc);
          setRetrying(false);
          setExhausted(false);
          setVisible(true);
        }}
        onError={() => {
          // Whatever the cache had for this URL is gone or unusable - back to
          // the patient path until it loads again. Clearing `instant` is what
          // brings the shimmer back: without it a tile that was believed
          // cached sits blank through the whole retry ladder (up to ~19s) and
          // then stays blank for good, showing nothing at any point.
          setInstant(false);
          if (shownSrc) forgetThumbLoaded(shownSrc);
          // Clearing src is what makes the browser re-issue the request: simply
          // re-assigning an unchanged URL is a no-op for the DOM.
          if (retryTimer.current !== null) return;
          // A tile that ALREADY loaded can still fail later - the browser drops
          // decoded pixels under memory pressure and silently re-fetches, and
          // that fetch can be aborted or time out. This used to return early on
          // the "already done" flag, which left the failed src on an img still
          // marked .is-loaded: the card then painted the broken-image glyph and
          // the filename over itself and stayed that way. Drop back to
          // not-loaded (invisible again) and run the retry ladder from the top.
          if (doneRef.current) {
            doneRef.current = false;
            retryCount.current = 0;
            setVisible(false);
          }
          const delay = RETRY_DELAYS_MS[retryCount.current];
          if (delay === undefined) {
            setRetrying(false);
            // Out of attempts: clear the failed src too, or the browser keeps
            // rendering the broken-image glyph + alt text on the card.
            setShownSrc(undefined);
            // Not the end of it - see REVIVE_DELAY_MS.
            setExhausted(true);
            return;
          }
          retryCount.current += 1;
          setRetrying(true);
          setShownSrc(undefined);
          retryTimer.current = window.setTimeout(() => {
            retryTimer.current = null;
            // A retry is never instant by definition - it shimmers through the
            // backoff and eases in when it finally arrives.
            show(src, false);
          }, delay);
        }}
      />
    </>
  );
}

function sectionDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Whether every dated photo falls inside one calendar month. Such a grid (an
// album of a single trip or event) gets day sections - month granularity would
// collapse it into a single section and the scrubber into one useless marker,
// the same reasoning as the import review's day grouping. Anything wider keeps
// the classic "Month Year" sections.
function spansSingleMonth(images: ImageOut[]): boolean {
  let monthKey: string | null = null;
  for (const image of images) {
    const d = sectionDate(image.taken_at);
    if (!d) continue;
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (monthKey === null) monthKey = key;
    else if (monthKey !== key) return false;
  }
  return monthKey !== null;
}

// Group consecutive images sharing a month (or day) into sections, carrying
// each image's global index so range-select and arrow-key nav still address
// the flat list.
function buildSections(
  images: ImageOut[],
  granularity: "month" | "day"
): { label: string; date: Date | null; items: { image: ImageOut; index: number }[] }[] {
  const sections: { label: string; date: Date | null; items: { image: ImageOut; index: number }[] }[] = [];
  images.forEach((image, index) => {
    const d = sectionDate(image.taken_at);
    const label = !d
      ? "Unknown date"
      : granularity === "day"
        ? d.toLocaleDateString(undefined, { weekday: "short", month: "long", day: "numeric", year: "numeric" })
        : d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const last = sections[sections.length - 1];
    if (last && last.label === label) last.items.push({ image, index });
    else sections.push({ label, date: d, items: [{ image, index }] });
  });
  return sections;
}

export function ThumbnailGrid({
  images,
  selectedIds,
  onToggleSelect,
  selectMode,
  groupByDate,
  onRemove,
  removeTitle = "Remove",
}: Props) {
  const navigate = useNavigate();
  const mergePairs = useMergePairs();
  const thumbSize = useThumbSize();
  // XS/S request the 640px tier - full 1600px thumbnails overflow the
  // renderer's decoded-image budget at those densities (see thumbTier).
  const tier = thumbTier(thumbSize);
  // Target row height of the CSS grid (--row-h), which is what the preload
  // look-ahead is counted in.
  const rowH = thumbPx(thumbSize);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sectionEls = useRef<Map<string, HTMLElement>>(new Map());
  const cardEls = useRef<Map<string, HTMLElement>>(new Map());
  // The per-tile "i" that opens a photo's details. Hidden while selecting -
  // the tile's top-left corner is the checkbox's there.
  const { infoButton, overlay: infoOverlay } = usePhotoInfoCard(!selectMode);

  // Coming back from the detail view: scroll the photo the user was looking
  // at back into view instead of landing at the top. The marker is one-shot -
  // consumed by the first grid that renders with data (which is exactly the
  // grid the back navigation returns to), found or not, so it can never cause
  // a surprise jump in some later, unrelated grid.
  //
  // The jump used to flash: the grid painted at the top of the library for a
  // frame or two and then snapped down. So the scroll moved into a LAYOUT
  // effect (before the browser paints anything) and the grid stays invisible
  // until it has happened, then eases in - what you see is the right part of
  // the library fading up, never the wrong one. Only grids that were actually
  // returned to do this; a normal visit renders as before.
  // Hiding the grid means the un-hiding must be unconditional: every path out
  // of this effect has to reach setRestoring(false), or the grid stays blank
  // for good. It can be entered a second time with the marker already spent
  // (StrictMode double-invokes effects, and any other grid may have consumed
  // it first), so the scroll is guarded on its own and the reveal is not. The
  // timer backs up the frame callback, which doesn't fire while the window is
  // hidden - switching apps mid-transition must not leave an empty library.
  const pendingScrollId = useRef<string | null>(peekLastViewedImage());
  const fadesIn = useRef(pendingScrollId.current !== null);
  const [restoring, setRestoring] = useState(pendingScrollId.current !== null);
  const hasImages = images.length > 0;
  useLayoutEffect(() => {
    if (!restoring) return;
    // Still waiting for the photos themselves; nothing to scroll to yet.
    if (!hasImages) return;
    if (pendingScrollId.current !== null) {
      const target = cardEls.current.get(pendingScrollId.current);
      pendingScrollId.current = null;
      clearLastViewedImage();
      target?.scrollIntoView({ block: "center" });
    }
    // Next frame, so the browser has the grid at opacity 0 in its "before"
    // state and the class removal actually transitions instead of snapping.
    const reveal = () => setRestoring(false);
    const raf = requestAnimationFrame(reveal);
    const timer = window.setTimeout(reveal, 250);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [hasImages, restoring]);
  const fadeClass = fadesIn.current ? (restoring ? " grid-fade grid-restoring" : " grid-fade") : "";

  if (images.length === 0) {
    return <div className="empty-state">No photos here yet.</div>;
  }

  const allIds = images.map((im) => im.id);

  function renderCard(image: ImageOut, index: number) {
    return (
      <div
        key={image.id}
        ref={(el) => {
          if (el) cardEls.current.set(image.id, el);
          else cardEls.current.delete(image.id);
        }}
        style={tileStyle(image.width, image.height)}
        className={`thumb-card${selectMode && selectedIds?.has(image.id) ? " selected" : ""}${
          !selectMode && onRemove ? " has-remove" : ""
        }`}
        onClick={(e) => {
          if (selectMode && onToggleSelect) {
            onToggleSelect(image.id, index, e.shiftKey);
          } else {
            navigate(`/image/${image.id}`, { state: { imageIds: allIds } });
          }
        }}
      >
        <Thumb
          src={api.images.thumbnailUrl(image.id, editVersion(image), tier)}
          alt={image.original_filename}
          rowHeight={rowH}
        />
        <span className={fileTypeBadgeClass(image.file_type, mergePairs && Boolean(image.paired_image_id))}>
          {fileTypeBadge(image.file_type, mergePairs && Boolean(image.paired_image_id))}
        </span>
        {infoButton(image.id)}
        {!selectMode && onRemove && (
          <button
            className="card-remove"
            title={removeTitle}
            aria-label={removeTitle}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(image.id);
            }}
          >
            <IconX size={12} />
          </button>
        )}
        {selectMode && onToggleSelect && (
          <input
            className="select-checkbox"
            type="checkbox"
            checked={selectedIds?.has(image.id) ?? false}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect(image.id, index, e.shiftKey);
            }}
            onChange={() => {}}
          />
        )}
        {(image.rating > 0 || image.color_label !== "none") && (
          <div className="overlay-info">
            <span className="overlay-stars">{image.rating > 0 ? "★".repeat(image.rating) : ""}</span>
            {image.color_label !== "none" && (
              <span
                className="overlay-color-dot"
                style={{ background: COLOR_HEX[image.color_label] }}
                title={image.color_label}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  if (!groupByDate) {
    return (
      <div className={`thumbnail-grid${fadeClass}`}>
        {images.map((image, index) => renderCard(image, index))}
        <i className="grid-filler" aria-hidden />
        {infoOverlay}
      </div>
    );
  }

  const granularity = spansSingleMonth(images) ? "day" : "month";
  const sections = buildSections(images, granularity);

  return (
    <div className={`timeline has-scrubber${fadeClass}`} ref={rootRef}>
      {sections.map((section) => (
        <section
          key={section.label}
          className="timeline-section"
          ref={(el) => {
            if (el) sectionEls.current.set(section.label, el);
            else sectionEls.current.delete(section.label);
          }}
        >
          <h3 className="timeline-header">
            {section.label}
            <span className="timeline-header-count">{section.items.length}</span>
          </h3>
          <div className="thumbnail-grid">
            {section.items.map(({ image, index }) => renderCard(image, index))}
            <i className="grid-filler" aria-hidden />
          </div>
        </section>
      ))}

      <TimelineScrubber
        getScroller={() =>
          (rootRef.current?.closest(".page-scroll") ?? rootRef.current?.closest(".page")) as HTMLElement | null
        }
        getSectionEl={(label) => sectionEls.current.get(label) ?? null}
        // Day mode rescales the rail like the import review: month as the big
        // tick (with year - it's the only year indicator on the rail), day
        // numbers as the small ones. Month mode keeps the year/month split the
        // scrubber derives from "July 2026" labels by itself.
        sections={sections.map((s) =>
          granularity === "day" && s.date
            ? {
                label: s.label,
                tickGroup: `${s.date.getFullYear()}-${s.date.getMonth()}`,
                tickPrimary: s.date.toLocaleDateString(undefined, { month: "short", year: "numeric" }),
                tickSecondary: String(s.date.getDate()),
              }
            : { label: s.label }
        )}
      />
      {infoOverlay}
    </div>
  );
}

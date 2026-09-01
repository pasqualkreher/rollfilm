// Scroll/pinch-to-zoom and drag-to-pan for a photo shown at fit size.
//
// Lives here because three views show the same photo the same way and must
// behave identically: the library's photo view, the import review's preview
// and (for the ceiling and the readout) the editor. Each used to carry its own
// copy of this maths, which is how the import preview ended up with no zoom at
// all while the other two had it.
//
// The unit is the FIT size, not pixels: scale 1 means "as large as the frame
// allows", which is the size the photo opens at. Everything the user thinks in
// - 100%, 200% - is derived from that through `nativeScale` below.

import { useCallback, useEffect, useRef, useState } from "react";

export const MIN_ZOOM = 0.2; // below fit, so a photo can be pushed away from the frame

// How far past 1:1 the user may go: 400% of ACTUAL pixels. The ceiling used to
// be 6x FIT, which is a different thing entirely - on a 4K screen a 6000px-wide
// photo fits at ~40%, so 6x fit was barely 240% and big files ran out of zoom
// right where pixel-peeping starts.
const MAX_NATIVE_ZOOM = 4;

// A photo far smaller than the frame is already past 1:1 at fit, and 400% of
// its actual pixels could be less than fit - so it always keeps this much
// magnification to play with. Also the ceiling before the first load, when
// there is no natural size to relate 1:1 to yet.
const MIN_MAX_FIT_ZOOM = 2;

export interface Size {
  w: number;
  h: number;
}

export interface ZoomPan {
  /** Attach to the frame the photo sits in (the element that clips it). */
  setBox: (el: HTMLElement | null) => void;
  /** Attach to the <img>. */
  setImg: (el: HTMLImageElement | null) => void;
  /** On-screen size of the photo at fit, or null until it has loaded. */
  fit: Size | null;
  scale: number;
  pan: { x: number; y: number };
  /** Zoomed in past fit - drives the pan cursor and the hi-res upgrade. */
  zoomed: boolean;
  /** The current transform should ease (discrete zoom) rather than track the input. */
  zoomAnim: boolean;
  /** Percentage of ACTUAL pixels, i.e. 100 = 1:1. Null until the size is known. */
  zoomPercent: number | null;
  /** Re-measure the fit size; call from the <img>'s onLoad. */
  refit: () => void;
  /** Forget the measured size, so the next photo doesn't flash at the old one's. */
  clearFit: () => void;
  resetZoom: (animate?: boolean) => void;
  /** Zoom to a multiple of ACTUAL pixels (1 = 100%), centred on the frame. */
  zoomToNative: (factor: number) => void;
  /** Ready-made handlers for the <img>: pan drag and the fit<->100% double-click. */
  imageHandlers: {
    onMouseDown: (e: React.MouseEvent<HTMLImageElement>) => void;
    onMouseMove: (e: React.MouseEvent<HTMLImageElement>) => void;
    onMouseUp: () => void;
    onMouseLeave: () => void;
    onDoubleClick: (e: React.MouseEvent<HTMLImageElement>) => void;
  };
  /** Style fragment for the <img> - size, transform and the grab cursor. */
  imageStyle: {
    width?: number;
    height?: number;
    transform: string;
    cursor: string;
  };
}

// `sourceSize` is the ORIGINAL photo's pixel size, when the caller knows it.
// Without it, 100% means "one pixel of the loaded bitmap per screen pixel" -
// which moves under the user: the lightbox starts on a downscaled preview and
// swaps in the full-resolution render the moment you zoom, so the readout would
// drop from 100% to some third of it while nothing on screen changed. Measured
// against the original, 100% stays 100%.
export function useImageZoomPan(sourceSize?: Size | null): ZoomPan {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoomAnim, setZoomAnim] = useState(false);
  const [fit, setFit] = useState<Size | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [dragging, setDragging] = useState(false);

  // The frame is tracked in state as well as a ref: the wheel listener is a
  // native non-passive one (see below) and has to (re)attach the moment the
  // element mounts, which a plain ref can't announce.
  const boxRef = useRef<HTMLElement | null>(null);
  const [boxNode, setBoxNode] = useState<HTMLElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const setBox = useCallback((el: HTMLElement | null) => {
    boxRef.current = el;
    setBoxNode(el);
  }, []);
  const setImg = useCallback((el: HTMLImageElement | null) => {
    imgRef.current = el;
  }, []);

  // Fit scale -> 1:1. A photo shown at 1200px that is 6000px wide has a native
  // scale of 5, so scale 5 IS 100%.
  // The source's stored size can be the un-rotated one while the rendered
  // preview is upright, so a portrait photo would come back as its own
  // landscape - compare orientations and swap rather than report a wildly
  // wrong percentage.
  const sourceW =
    sourceSize && sourceSize.w > 0 && sourceSize.h > 0 && natural
      ? sourceSize.w > sourceSize.h !== natural.w > natural.h
        ? sourceSize.h
        : sourceSize.w
      : null;
  const nativeW = sourceW ?? natural?.w ?? 0;
  const nativeScale = nativeW && fit && fit.w > 0 ? nativeW / fit.w : 1;
  const maxZoom = natural
    ? Math.max(MIN_MAX_FIT_ZOOM, nativeScale * MAX_NATIVE_ZOOM)
    : MIN_MAX_FIT_ZOOM;
  const zoomed = scale > 1.001;

  // Read by the native wheel listener, which is attached once and would
  // otherwise close over the first render's values.
  const liveRef = useRef({ nativeScale, maxZoom, fit, scale, pan });
  liveRef.current = { nativeScale, maxZoom, fit, scale, pan };

  // The pan a wheel-zoom gesture WANTS, before clampPan trims it for display.
  // Anchoring each tick on the clamped pan compounds: once the clamp bites
  // (early in a zoom, before the photo overhangs the frame), the point under
  // the cursor slips, and every further tick multiplies that slip by its zoom
  // ratio. Tracking the unclamped ideal keeps the anchor exact, and the moment
  // the clamp has room the view converges back onto it.
  const idealPanRef = useRef({ x: 0, y: 0 });
  const lastWheelAtRef = useRef(0);

  // Inner size of the frame, i.e. what the photo may occupy.
  function availableSize(box: HTMLElement): Size {
    const cs = getComputedStyle(box);
    return {
      w: box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      h: box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
    };
  }

  // Explicit on-screen size for the photo, fit to the frame. CSS max-* only
  // ever scales down, so a preview smaller than the frame sat tiny in the
  // middle of large screens; this scales up too. Done in JS (not object-fit) so
  // the <img> element stays exactly the size of the visible photo - the framed
  // shadow and the zoom maths depend on that.
  const refit = useCallback(() => {
    const box = boxRef.current;
    const img = imgRef.current;
    if (!box || !img || !img.naturalWidth || !img.naturalHeight) return;
    const avail = availableSize(box);
    if (avail.w <= 0 || avail.h <= 0) return;
    const s = Math.min(avail.w / img.naturalWidth, avail.h / img.naturalHeight);
    setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    setFit({ w: img.naturalWidth * s, h: img.naturalHeight * s });
  }, []);

  const clearFit = useCallback(() => setFit(null), []);

  // Clamp the pan so the view stays *inside the photo* - never past its edges
  // into the empty frame. The max offset is how far the scaled photo overhangs
  // the visible frame; it's 0 when the photo fits or is zoomed out, so it stays
  // centred.
  const clampPan = useCallback((p: { x: number; y: number }, s: number) => {
    const box = boxRef.current;
    const current = liveRef.current.fit;
    if (!box || !current) return p;
    const avail = availableSize(box);
    const maxX = Math.max(0, (current.w * s - avail.w) / 2);
    const maxY = Math.max(0, (current.h * s - avail.h) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, p.x)), y: Math.max(-maxY, Math.min(maxY, p.y)) };
  }, []);

  const resetZoom = useCallback((animate = false) => {
    setZoomAnim(animate);
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Zoom to a fixed step, keeping the frame's centre put.
  const zoomToNative = useCallback(
    (factor: number) => {
      const target = Math.min(liveRef.current.maxZoom, liveRef.current.nativeScale * factor);
      setZoomAnim(true);
      setScale(target);
      setPan((prev) => clampPan(prev, target));
    },
    [clampPan]
  );

  // Keep the photo fit to its frame while the window or the frame itself
  // resizes (e.g. the side panel wrapping).
  useEffect(() => {
    if (!boxNode) return;
    const observer = new ResizeObserver(() => refit());
    observer.observe(boxNode);
    window.addEventListener("resize", refit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", refit);
    };
  }, [boxNode, refit]);

  // Scroll / pinch to zoom toward the cursor. A native, non-passive listener so
  // we can preventDefault - otherwise ctrl+wheel (trackpad pinch) would zoom
  // the whole app and a plain wheel would scroll the page behind it.
  useEffect(() => {
    const el = boxNode;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      setZoomAnim(false);
      const rect = el!.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      // A pause long enough to be a new gesture (or a pan-drag in between):
      // re-seed the ideal from wherever the view actually is now.
      const now = performance.now();
      if (now - lastWheelAtRef.current > 250) idealPanRef.current = { ...liveRef.current.pan };
      lastWheelAtRef.current = now;
      const prev = liveRef.current.scale;
      const next = Math.min(
        liveRef.current.maxZoom,
        Math.max(MIN_ZOOM, prev * Math.exp(-e.deltaY * 0.0015))
      );
      const ratio = next / prev;
      const ideal =
        next <= 1.001
          ? { x: 0, y: 0 }
          : { x: dx - (dx - idealPanRef.current.x) * ratio, y: dy - (dy - idealPanRef.current.y) * ratio };
      idealPanRef.current = ideal;
      const shown = next <= 1.001 ? ideal : clampPan(ideal, next);
      // The ref leads, state follows: the next wheel event may arrive before
      // React re-renders, and it must compute from THIS tick's values.
      liveRef.current.scale = next;
      liveRef.current.pan = shown;
      setScale(next);
      setPan(shown);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [boxNode, clampPan]);

  const imageHandlers = {
    onMouseDown: (e: React.MouseEvent<HTMLImageElement>) => {
      if (!zoomed) return;
      e.preventDefault();
      setZoomAnim(false);
      dragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      setDragging(true);
    },
    onMouseMove: (e: React.MouseEvent<HTMLImageElement>) => {
      if (!dragRef.current) return;
      setPan(clampPan({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y }, scale));
    },
    onMouseUp: () => {
      dragRef.current = null;
      setDragging(false);
    },
    onMouseLeave: () => {
      dragRef.current = null;
      setDragging(false);
    },
    onDoubleClick: (e: React.MouseEvent<HTMLImageElement>) => {
      // A plain toggle: anything above fit goes back to fit, fit goes to 100%.
      // It used to cycle fit -> 100% -> 200% -> 400% -> fit, which meant a
      // double-click after zooming in with the wheel magnified further when
      // the obvious thing to expect was "put it back". Zooming past 1:1 is
      // what the wheel and the readout's buttons are for.
      const box = boxRef.current;
      if (!box) return;
      const rect = box.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      const { nativeScale: native, maxZoom: ceiling } = liveRef.current;
      // A photo smaller than its frame is already past 1:1 at fit, so 100%
      // would zoom it *out*; magnify a little instead. Zoomed *below* fit
      // counts as "not at fit" too, so the first double-click recentres.
      const target =
        Math.abs(scale - 1) > 0.001 ? 1 : Math.min(ceiling, Math.max(1.5, native));
      setZoomAnim(true);
      setScale(target);
      setPan(
        target === 1 ? { x: 0, y: 0 } : clampPan({ x: dx * (1 - target), y: dy * (1 - target) }, target)
      );
    },
  };

  return {
    setBox,
    setImg,
    fit,
    scale,
    pan,
    zoomed,
    zoomAnim,
    zoomPercent: natural ? Math.round((scale / nativeScale) * 100) : null,
    refit,
    clearFit,
    resetZoom,
    zoomToNative,
    imageHandlers,
    imageStyle: {
      ...(fit ? { width: fit.w, height: fit.h } : null),
      transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
      cursor: zoomed ? (dragging ? "grabbing" : "grab") : "default",
    },
  };
}

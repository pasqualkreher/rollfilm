import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, editVersion } from "../api/client";
import { RatingStars } from "../components/RatingStars";
import { ColorLabelPicker } from "../components/ColorLabelPicker";
import { PhotoEditor } from "../components/PhotoEditor";
import { TagEditor } from "../components/TagEditor";
import { AlbumPicker } from "../components/AlbumPicker";
import { MiniMap } from "../components/MiniMap";
import { useSelects } from "../state/selects";
import { useMergePairs } from "../state/viewPrefs";
import { usePairDeleteConfirm } from "../components/usePairDeleteConfirm";
import { ExportDialog } from "../components/ExportDialog";
import { preloadImage } from "../utils/preload";
import { rememberLastViewedImage } from "../utils/lastViewed";
import { useTransientMessage } from "../utils/transientMessage";
import type { ColorLabel, ImageOut } from "../api/types";

// exiftool delivers the exposure time as a plain decimal ("0.003571428571");
// photographers read shutter speeds as fractions ("1/280") or whole seconds.
function formatShutterSpeed(value: string | null): string {
  if (!value) return "—";
  const secs = Number(value);
  if (!isFinite(secs) || secs <= 0) return value; // already "1/280"-style or unparseable
  if (secs >= 1) return `${Number(secs.toFixed(1))}s`;
  return `1/${Math.round(1 / secs)}`;
}

export function ImageDetail() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState(id!);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [bgMode, setBgMode] = useState<"light" | "dark">("light");
  const mergePairs = useMergePairs();
  const { dialog: pairDeleteDialog, confirmDelete } = usePairDeleteConfirm();
  // Scroll / trackpad-pinch to zoom (toward the cursor), drag to pan. scale 1 =
  // fit; pan is a pixel translation applied before the scale.
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Swap the preview for the full-resolution render once the user zooms in, so
  // 100% shows true original pixels instead of an upscaled preview. If the
  // full render can't be fetched we fall back to the preview (never a broken img).
  const [hiRes, setHiRes] = useState(false);
  const [fullFailed, setFullFailed] = useState(false);
  // The preview itself failed to load (damaged/unreadable file). Shows a clean
  // error state instead of the browser's broken-image icon; navigation, rating
  // and the info panel keep working. Retry remounts the <img> (keyed by the
  // nonce) so the request is re-issued and a transient failure can recover.
  const [previewFailed, setPreviewFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  // Fades the photo in once its pixels arrive (see .detail-photo in index.css)
  // instead of it snapping in. Reset per shown photo, not per src change, so a
  // hi-res upgrade while zoomed doesn't blink.
  const [photoLoaded, setPhotoLoaded] = useState(false);
  // True once any photo has been shown. Gates the fade-in to the very first
  // open (from the grid): while paging through a set we keep the current frame
  // on screen and swap in place, so there's no fade-out/in wash between photos.
  const shownOnceRef = useRef(false);
  const imageBoxRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const selects = useSelects();
  // Explicit on-screen size for the photo, fit to the frame. CSS max-* only
  // ever scales down, so a preview smaller than the frame sat tiny in the
  // middle of large screens; this scales up too. Done in JS (not object-fit)
  // so the <img> element stays exactly the size of the visible photo - the
  // framed shadow and the double-click zoom math depend on that.
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);

  function refitImage() {
    const box = imageBoxRef.current;
    const img = imgRef.current;
    if (!box || !img || !img.naturalWidth || !img.naturalHeight) return;
    const cs = getComputedStyle(box);
    const availW = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (availW <= 0 || availH <= 0) return;
    const s = Math.min(availW / img.naturalWidth, availH / img.naturalHeight);
    setFit({ w: img.naturalWidth * s, h: img.naturalHeight * s });
  }

  const MAX_ZOOM = 6;
  const MIN_ZOOM = 0.2; // allow zooming out below fit
  const zoomed = scale > 1.001;

  // Whether the next transform change should ease (discrete zoom: double-click,
  // Esc-to-fit) or snap (wheel-zoom / pan-drag, which must track the input).
  const [zoomAnim, setZoomAnim] = useState(false);

  function resetZoom(animate = false) {
    setZoomAnim(animate);
    setScale(1);
    setPan({ x: 0, y: 0 });
  }

  // Clamp the pan so the view stays *inside the photo* - never past its edges into
  // the empty frame. The max offset is how far the scaled photo overhangs the
  // visible frame; it's 0 when the photo fits or is zoomed out, so it stays centred.
  function clampPan(p: { x: number; y: number }, s: number) {
    const box = imageBoxRef.current;
    if (!box || !fit) return p;
    const cs = getComputedStyle(box);
    const availW = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const maxX = Math.max(0, (fit.w * s - availW) / 2);
    const maxY = Math.max(0, (fit.h * s - availH) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, p.x)), y: Math.max(-maxY, Math.min(maxY, p.y)) };
  }

  // Passed from the Library grid so arrow keys can zap through the same
  // filtered/ordered set of photos you were browsing, not the whole library.
  const imageIds = (location.state as { imageIds?: string[] } | null)?.imageIds;
  // Where the back arrow should lead. Set e.g. after "Save copy" (which jumps
  // here directly) so back goes to the Library instead of replaying history.
  const backTo = (location.state as { backTo?: string } | null)?.backTo;

  function goBack() {
    if (backTo) navigate(backTo);
    else navigate(-1);
  }

  // The route param changes on arrow-key navigation (same component instance,
  // React Router just re-renders it) - activeId must follow it, or the RAW/JPEG
  // toggle state from the previous photo would stick around on the new one.
  useEffect(() => {
    setActiveId(id!);
  }, [id]);

  // Record which photo is on screen so the grid we came from can scroll back
  // to it on return (see utils/lastViewed.ts). Deliberately the route id, not
  // activeId: the RAW/JPEG toggle can show a partner that has no own card in
  // a merged grid, while the route id always does.
  useEffect(() => {
    if (id) rememberLastViewedImage(id);
  }, [id]);

  // Drop back to fit-view whenever the shown photo changes (arrow-key nav or
  // the RAW/JPEG toggle), so a new image never opens already zoomed-in.
  useEffect(() => {
    resetZoom();
    setHiRes(false);
    setFullFailed(false);
    setPreviewFailed(false);
    setRetryNonce(0);
    // Only blank + fade for the first open. When paging through a set, keep the
    // current photo (and its size) on screen until the next one's pixels have
    // decoded, then swap in place - the browser holds the old <img> content
    // until the new src is ready (neighbors are prefetched below), so paging
    // reads as a clean swap instead of a fade-out/in wash.
    if (!shownOnceRef.current) {
      setFit(null);
      setPhotoLoaded(false);
    }
  }, [activeId]);

  // Once zoomed in, upgrade to the full-resolution render (loaded lazily) unless
  // it already failed for this photo.
  useEffect(() => {
    if (zoomed && !fullFailed) setHiRes(true);
  }, [zoomed, fullFailed]);

  const { data: image } = useQuery({
    queryKey: ["image", activeId],
    queryFn: () => api.images.get(activeId),
    enabled: !!activeId,
  });

  // A saved edit regenerates the preview in place but deletes full.jpg, whose
  // full-resolution re-render happens lazily on request and can take a minute
  // for a RAW. If the lightbox had upgraded to the full render (hiRes latches
  // once the user zooms), keeping it would point the <img> at that
  // still-rendering file and leave the PRE-edit pixels on screen until it
  // finishes - looking like the save didn't take. Drop back to fit + the fresh
  // preview instead; zooming in again re-upgrades on demand.
  const editRev = image?.edit_rev;
  useEffect(() => {
    resetZoom();
    setHiRes(false);
    setFullFailed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRev]);

  const { data: paired } = useQuery({
    queryKey: ["image", image?.paired_image_id],
    queryFn: () => api.images.get(image!.paired_image_id!),
    enabled: !!image?.paired_image_id,
  });

  // Keep the photo fit to its frame when the window or the frame itself
  // resizes (e.g. the side panel wrapping). Keyed to image?.id because the
  // component early-returns a loading state before the frame element mounts.
  useEffect(() => {
    const box = imageBoxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => refitImage());
    observer.observe(box);
    window.addEventListener("resize", refitImage);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", refitImage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image?.id]);

  // Scroll / pinch to zoom toward the cursor. A native, non-passive listener so
  // we can preventDefault - otherwise ctrl+wheel (trackpad pinch) would zoom the
  // whole app and a plain wheel would scroll the page. Keyed to image?.id so it
  // (re)attaches once the .detail-image element actually mounts - the component
  // early-returns a loading state before the photo is ready.
  useEffect(() => {
    const el = imageBoxRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      setZoomAnim(false);
      const rect = el!.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      setScale((prevScale) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prevScale * factor));
        setPan((prevPan) => {
          if (next <= 1.001) return { x: 0, y: 0 };
          const ratio = next / prevScale;
          return clampPan({ x: dx - (dx - prevPan.x) * ratio, y: dy - (dy - prevPan.y) * ratio }, next);
        });
        return next;
      });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [image?.id]);

  // "Add to Immich" only shows when the integration is configured in Settings.
  const { data: immich } = useQuery({ queryKey: ["immich-settings"], queryFn: () => api.settings.getImmich() });
  const immichConfigured = Boolean(immich?.base_url && immich?.api_key_set && immich.enabled);
  const [immichBusy, setImmichBusy] = useState(false);
  // Flash message - auto-dismisses after a moment.
  const [immichMsg, setImmichMsg] = useTransientMessage();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (adjustOpen) return;

      // Esc closes the lightbox - but first drop back to fit if zoomed in, so
      // one press doesn't do both.
      if (e.key === "Escape") {
        if (zoomed) resetZoom(true);
        else goBack();
        return;
      }

      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && image && paired) {
        setActiveId(activeId === image.id ? paired.id : image.id);
        return;
      }

      // Number keys set the star rating (0 clears it) - same shortcut as the
      // import lightbox. Skipped while a control has focus so typing into the
      // tag input or a text field never rates the photo.
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inControl = tag === "INPUT" || tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA";
      if (!inControl && image && e.key >= "0" && e.key <= "5") {
        setRating(Number(e.key));
        return;
      }

      if (!imageIds || imageIds.length === 0) return;
      const currentIndex = imageIds.indexOf(id!);
      if (currentIndex === -1) return;
      if (e.key === "ArrowLeft" && currentIndex > 0) {
        navigate(`/image/${imageIds[currentIndex - 1]}`, { replace: true, state: { imageIds } });
      } else if (e.key === "ArrowRight" && currentIndex < imageIds.length - 1) {
        navigate(`/image/${imageIds[currentIndex + 1]}`, { replace: true, state: { imageIds } });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [imageIds, id, navigate, adjustOpen, image, paired, activeId, zoomed]);

  // The photo the user has actually SETTLED on: follows activeId only after a
  // short pause without further navigation. Holding an arrow key changes
  // activeId many times a second, and firing the per-photo side requests
  // (similar-search, neighbor prefetches) for every intermediate photo flooded
  // the backend with work for positions long since zapped past - requests that,
  // once started, all ran to completion. Keying that work to restedId means an
  // intermediate photo fires nothing but its own main preview load (which the
  // browser cancels natively when the src moves on).
  const [restedId, setRestedId] = useState(activeId);
  useEffect(() => {
    if (restedId === activeId) return;
    const t = setTimeout(() => setRestedId(activeId), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Once the user rests on a photo, pull its neighbors (the previous and next
  // photo of the browsed set) into memory: their metadata into the query cache
  // and their preview pixels into the browser cache. Arrow-key zapping then
  // swaps instantly instead of showing an empty frame per photo. The preview
  // URL is version-stamped for edited photos, so the metadata has to arrive
  // first - a bare previewUrl(id) would miss the edited render.
  useEffect(() => {
    if (!imageIds || imageIds.length === 0) return;
    const currentIndex = imageIds.indexOf(restedId);
    if (currentIndex === -1) return;
    let stale = false;
    for (const neighborId of [imageIds[currentIndex + 1], imageIds[currentIndex - 1]]) {
      if (!neighborId) continue;
      queryClient
        .prefetchQuery({
          queryKey: ["image", neighborId],
          queryFn: () => api.images.get(neighborId),
        })
        .then(() => {
          // The user moved on while the metadata was in flight - don't also
          // pull pixels for a position that's no longer next to anything.
          if (stale) return;
          const neighbor = queryClient.getQueryData<ImageOut>(["image", neighborId]);
          if (neighbor) preloadImage(api.images.previewUrl(neighbor.id, editVersion(neighbor)));
        });
    }
    return () => {
      stale = true;
    };
  }, [imageIds, restedId, queryClient]);

  // Direction-aware look-ahead for FAST paging: while the arrow key is going,
  // activeId never rests, so the rested-neighbor warmup above never fires and
  // every photo past the first pair was a cold load. Each navigation step
  // therefore immediately warms the next TWO photos in the direction of
  // travel - the +1 is usually already warm from the previous step (preload
  // dedups), so each step costs one metadata fetch and one low-priority
  // preview fetch for work the very next keypress needs anyway. The heavy
  // rest-keyed requests (similar-search, both neighbors, the RAW/JPEG
  // partner) stay rest-keyed.
  const prevIndexRef = useRef(-1);
  useEffect(() => {
    if (!imageIds || imageIds.length === 0) return;
    const index = imageIds.indexOf(id!);
    const prev = prevIndexRef.current;
    prevIndexRef.current = index;
    if (index === -1 || prev === -1 || prev === index) return;
    const dir = index > prev ? 1 : -1;
    for (const aheadId of [imageIds[index + dir], imageIds[index + 2 * dir]]) {
      if (!aheadId) continue;
      queryClient
        .prefetchQuery({
          queryKey: ["image", aheadId],
          queryFn: () => api.images.get(aheadId),
        })
        .then(() => {
          const ahead = queryClient.getQueryData<ImageOut>(["image", aheadId]);
          if (ahead) preloadImage(api.images.previewUrl(ahead.id, editVersion(ahead)));
        });
    }
  }, [imageIds, id, queryClient]);

  // Warm the RAW/JPEG partner's preview once the user rests on a photo, so the
  // ArrowUp/Down switch swaps instantly instead of downloading the partner's
  // preview on first use (a low-priority fetch, behind the visible photo).
  useEffect(() => {
    if (!paired || restedId !== activeId) return;
    preloadImage(api.images.previewUrl(paired.id, editVersion(paired)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paired, restedId]);

  // Similar-photos strip: a CLIP search per photo is the most expensive
  // per-view request the lightbox makes - only run it for the rested photo,
  // never for photos zapped past.
  const { data: similar } = useQuery({
    queryKey: ["similar", restedId],
    queryFn: () => api.images.similar(restedId, 50),
    enabled: !!restedId,
  });

  // A RAW+JPEG pair is the same shot, so the raw search hits both halves - and
  // often the open photo's own partner. Collapse each pair to one suggestion
  // (prefer the viewable JPEG) and drop the current photo's partner, so the
  // strip proposes genuinely different photos instead of raw/jpg duplicates.
  const shownSimilar = useMemo(() => {
    if (!similar) return [];
    const partnerId = image?.paired_image_id ?? null;
    const groups = new Map<string, typeof similar>();
    const order: string[] = [];
    for (const r of similar) {
      if (r.image.id === partnerId) continue;
      const key = r.image.paired_image_id
        ? [r.image.id, r.image.paired_image_id].sort().join("|")
        : r.image.id;
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key)!.push(r);
    }
    return order.map((key) => {
      const group = groups.get(key)!;
      return group.find((g) => g.image.file_type !== "raw") ?? group[0];
    });
  }, [similar, image?.paired_image_id]);

  if (!image) return <div className="page empty-state">Loading...</div>;

  // With "Merge RAW+JPG" on, rating/coloring the shown file also writes the
  // partner - and we refresh its cached copy so the other tab reflects it.
  function invalidateActiveAndPair() {
    queryClient.invalidateQueries({ queryKey: ["image", activeId] });
    if (mergePairs && image!.paired_image_id) {
      queryClient.invalidateQueries({ queryKey: ["image", image!.paired_image_id] });
    }
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  async function setRating(rating: number) {
    await api.images.update(image!.id, { rating, apply_to_pair: mergePairs });
    invalidateActiveAndPair();
  }

  async function setColor(color_label: ColorLabel) {
    await api.images.update(image!.id, { color_label, apply_to_pair: mergePairs });
    invalidateActiveAndPair();
  }

  async function addTag(name: string) {
    await api.images.addTag(image!.id, name);
    queryClient.invalidateQueries({ queryKey: ["image", activeId] });
    queryClient.invalidateQueries({ queryKey: ["tags"] });
  }

  async function removeTag(name: string) {
    await api.images.removeTag(image!.id, name);
    queryClient.invalidateQueries({ queryKey: ["image", activeId] });
  }

  // With merged pairs the photo stands for the whole RAW+JPEG shot, so album
  // membership changes cover the hidden partner too.
  function idsWithPair(): string[] {
    return mergePairs && image!.paired_image_id ? [image!.id, image!.paired_image_id] : [image!.id];
  }

  async function addToAlbum(albumId: string) {
    await api.albums.addImages(albumId, idsWithPair());
    queryClient.invalidateQueries({ queryKey: ["image", activeId] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  async function removeFromAlbum(albumId: string) {
    await Promise.all(idsWithPair().map((x) => api.albums.removeImage(albumId, x)));
    queryClient.invalidateQueries({ queryKey: ["image", activeId] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  async function toggleImageImmichSync() {
    if (!image) return;
    const ids = paired ? [image.id, paired.id] : [image.id];
    await api.images.setImmichSync(ids, !image.immich_sync);
    queryClient.invalidateQueries({ queryKey: ["image", activeId] });
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  async function addToImmich() {
    if (!image) return;
    setImmichBusy(true);
    setImmichMsg(null);
    // Push both halves of a pair so the JPEG is uploaded regardless of which is
    // shown (the backend skips RAW files itself).
    const ids = paired ? [image.id, paired.id] : [image.id];
    try {
      const result = await api.images.pushToImmich(ids);
      setImmichMsg(result.message);
    } catch (e) {
      setImmichMsg((e as Error).message);
    } finally {
      setImmichBusy(false);
    }
  }

  async function deletePhoto() {
    if (!image) return;
    // A RAW+JPEG pair is one shot, so both halves go together by default. With
    // the "ask what to delete" setting on, the user can keep the partner.
    const ids = await confirmDelete({
      baseIds: [image.id],
      baseItems: [image],
      partnerIds: paired ? [paired.id] : [],
      partnerItems: paired ? [paired] : [],
    });
    if (!ids) return;
    await api.images.bulkDelete(ids);
    ids.forEach((delId) => selects.has(delId) && selects.remove(delId));
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["trash"] });

    // Move to the next remaining photo in the set you were browsing; if none is
    // left (or we arrived here without a set), fall back to where we came from.
    if (imageIds && imageIds.length > 0) {
      const remaining = imageIds.filter((x) => !ids.includes(x));
      if (remaining.length > 0) {
        const currentIndex = imageIds.indexOf(id!);
        const next =
          remaining.find((x) => imageIds.indexOf(x) > currentIndex) ?? remaining[remaining.length - 1];
        navigate(`/image/${next}`, { replace: true, state: { imageIds: remaining } });
        return;
      }
    }
    goBack();
  }

  return (
    <div className="page detail-page">
      {pairDeleteDialog}
      <button className="icon-btn back-btn" onClick={goBack} title="Back (Esc)" aria-label="Back">
        ←
      </button>
      <div className="detail-layout" style={{ marginTop: 16 }}>
        <div className="detail-main">
          <div className={`detail-image${bgMode === "dark" ? " detail-image-dark" : ""}`} ref={imageBoxRef}>
            {previewFailed ? (
              <div className="detail-photo-error">
                <span className="detail-photo-error-icon" aria-hidden="true">🖼️</span>
                <p>This photo can't be displayed - the file may be damaged or unreadable.</p>
                <p className="detail-photo-error-name">{image.original_filename}</p>
                <button
                  className="btn"
                  onClick={() => {
                    setPreviewFailed(false);
                    setRetryNonce((n) => n + 1);
                  }}
                >
                  Retry
                </button>
              </div>
            ) : (
            <img
              key={retryNonce}
              ref={imgRef}
              // The photo the user is looking at must always win the connection
              // pool over similar-strip thumbs and neighbor prefetches.
              {...({ fetchpriority: "high" } as Record<string, string>)}
              className={`detail-photo${bgMode === "dark" ? " framed" : ""}${zoomed ? " zoomed" : ""}${zoomAnim ? " zoom-anim" : ""}`}
              style={{
                ...(fit ? { width: fit.w, height: fit.h } : null),
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                cursor: zoomed ? (dragRef.current ? "grabbing" : "grab") : "default",
                opacity: photoLoaded ? 1 : 0,
              }}
              onLoad={() => {
                refitImage();
                setPhotoLoaded(true);
                shownOnceRef.current = true;
              }}
              draggable={false}
              src={
                hiRes
                  ? api.images.fullUrl(image.id, editVersion(image))
                  : api.images.previewUrl(image.id, editVersion(image))
              }
              alt={image.original_filename}
              onError={() => {
                // Full render unavailable - fall back to the preview so the
                // photo never shows as a broken image. If the preview itself
                // fails, switch to the error state instead of leaving the
                // browser's broken-image icon behind.
                if (hiRes) {
                  setFullFailed(true);
                  setHiRes(false);
                } else {
                  setPreviewFailed(true);
                }
              }}
              onMouseDown={(e: ReactMouseEvent<HTMLImageElement>) => {
                if (!zoomed) return;
                e.preventDefault();
                setZoomAnim(false);
                dragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
              }}
              onMouseMove={(e: ReactMouseEvent<HTMLImageElement>) => {
                if (!dragRef.current) return;
                setPan(clampPan({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y }, scale));
              }}
              onMouseUp={() => {
                dragRef.current = null;
              }}
              onMouseLeave={() => {
                dragRef.current = null;
              }}
              onDoubleClick={(e: ReactMouseEvent<HTMLImageElement>) => {
                // Lightroom-style: double-click toggles fit <-> 100% at the cursor.
                const box = imageBoxRef.current!.getBoundingClientRect();
                const dx = e.clientX - (box.left + box.width / 2);
                const dy = e.clientY - (box.top + box.height / 2);
                if (zoomed) {
                  resetZoom(true);
                } else {
                  const img = e.currentTarget;
                  const target = Math.min(MAX_ZOOM, Math.max(1.5, img.naturalWidth / img.getBoundingClientRect().width));
                  setZoomAnim(true);
                  setScale(target);
                  setPan(clampPan({ x: dx * (1 - target), y: dy * (1 - target) }, target));
                }
              }}
            />
            )}
          </div>
          <div className="detail-image-toolbar">
            <span className="segmented">
              <button className={bgMode === "light" ? "active" : ""} onClick={() => setBgMode("light")}>
                Light background
              </button>
              <button className={bgMode === "dark" ? "active" : ""} onClick={() => setBgMode("dark")}>
                Black background
              </button>
            </span>
            <span className="detail-zoom-hint">
              {zoomed ? "Drag to pan · double-click or Esc to fit" : "Scroll, pinch, or double-click to zoom"}
            </span>
          </div>
        </div>
        <div className="detail-panel">
          <h3 className="section-title">{image.original_filename}</h3>

          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <button className="btn primary" onClick={() => setAdjustOpen(true)}>
              Edit
            </button>
            <button
              className={`btn${selects.has(image.id) ? " primary" : ""}`}
              onClick={() => selects.toggle(image!.id)}
            >
              {selects.has(image.id) ? "✓ In selects" : "+ Add to selects"}
            </button>
            {immichConfigured && immich?.sync_mode === "selective" && (
              <label
                className="filter-field filter-field-inline"
                title="Flag this photo for automatic Immich sync (JPEG only; RAW is skipped)"
              >
                <input
                  type="checkbox"
                  checked={image.immich_sync}
                  onChange={toggleImageImmichSync}
                />{" "}
                Sync to Immich
              </label>
            )}
            {/* Manual mode only: selective shows the sync checkbox instead, and
                in full mode everything uploads automatically anyway. */}
            {immichConfigured && immich?.sync_mode === "manual" && (
              <button
                className="btn"
                onClick={addToImmich}
                disabled={immichBusy}
                title="Upload this photo's JPEG to your configured Immich server (RAW is skipped)"
              >
                {immichBusy ? "Uploading..." : "Add to Immich"}
              </button>
            )}
            <button
              className="btn danger"
              onClick={deletePhoto}
              title="Delete this photo (and its RAW/JPEG partner) - library photos move to the Trash, external photos are only removed from the catalog"
            >
              Delete
            </button>
          </div>
          {immichMsg && (
            <p className="status-note" style={{ marginTop: -8, marginBottom: 16 }}>{immichMsg}</p>
          )}

          {paired && (
            <div style={{ marginBottom: 16 }}>
              <span className="segmented">
                {/* Render the pair in a fixed order (RAW then JPEG) so the two
                    buttons keep their positions and the highlight tracks the
                    active file - `image` is always the *active* one, so mapping
                    [image, paired] directly would swap the labels on each toggle. */}
                {[image, paired]
                  .sort((a, b) => {
                    const rank = (t: string) => (t === "raw" ? 0 : 1);
                    return rank(a.file_type) - rank(b.file_type) || a.id.localeCompare(b.id);
                  })
                  .map((member) => (
                    <button
                      key={member.id}
                      className={activeId === member.id ? "active" : ""}
                      onClick={() => setActiveId(member.id)}
                    >
                      {member.file_type.toUpperCase()}
                    </button>
                  ))}
              </span>
            </div>
          )}

          <div className="detail-section">
            <div className="detail-section-label">Rating</div>
            <RatingStars rating={image.rating} onChange={setRating} />
          </div>
          <div className="detail-section">
            <div className="detail-section-label">Color label</div>
            <ColorLabelPicker value={image.color_label} onChange={setColor} />
          </div>
          <div className="detail-section">
            <div className="detail-section-label">Tags</div>
            <TagEditor tags={image.tags} onAdd={addTag} onRemove={removeTag} />
          </div>
          <div className="detail-section">
            <div className="detail-section-label">Albums</div>
            <AlbumPicker onAdd={addToAlbum} currentAlbumIds={image.album_ids} onRemove={removeFromAlbum} />
          </div>

          <div className="detail-section">
            <div className="detail-section-label">Info</div>
          <table className="exif-table">
            <tbody>
              <tr>
                <td>Taken</td>
                <td>{image.taken_at ? new Date(image.taken_at).toLocaleString() : "—"}</td>
              </tr>
              <tr>
                <td>Camera</td>
                <td>
                  {image.camera_make} {image.camera_model}
                </td>
              </tr>
              <tr>
                <td>Dimensions</td>
                <td>
                  {image.width}×{image.height}
                </td>
              </tr>
              <tr>
                <td>ISO</td>
                <td>{image.iso ?? "—"}</td>
              </tr>
              <tr>
                <td>Aperture</td>
                <td>{image.aperture ? `f/${image.aperture}` : "—"}</td>
              </tr>
              <tr>
                <td>Shutter</td>
                <td>{formatShutterSpeed(image.shutter_speed)}</td>
              </tr>
              <tr>
                <td>Focal length</td>
                <td>{image.focal_length ? `${image.focal_length}mm` : "—"}</td>
              </tr>
            </tbody>
          </table>

            <button
              className="btn"
              style={{ display: "block", width: "100%", marginTop: 14, textAlign: "center" }}
              onClick={() => setExportOpen(true)}
              title="Export a JPEG with your edits baked in, or download the original file 1:1 with all meta tags"
            >
              Export…
            </button>
          </div>

          {image.gps_lat != null && image.gps_lon != null && (
            <div className="detail-section">
              <div className="detail-section-label">Location</div>
              <MiniMap
                lat={image.gps_lat}
                lon={image.gps_lon}
                onClick={() =>
                  navigate("/map", {
                    state: { focus: { id: image.id, lat: image.gps_lat, lon: image.gps_lon } },
                  })
                }
              />
            </div>
          )}

          {shownSimilar.length > 0 && (
            <div className="detail-section">
              <div className="detail-section-label">Similar photos</div>
              <div className="thumbnail-grid similar-grid">
                {shownSimilar.map((r) => (
                  <div
                    key={r.image.id}
                    className="thumb-card"
                    // Replace (don't push) so exploring similars doesn't stack
                    // history - one Back returns straight to the grid you came
                    // from instead of walking back through each similar you viewed.
                    onClick={() =>
                      navigate(`/image/${r.image.id}`, { replace: true, state: { imageIds } })
                    }
                  >
                    <img
                      src={api.images.thumbnailUrl(r.image.id, editVersion(r.image))}
                      alt={r.image.original_filename}
                      // Lazy + low priority: the strip fires up to 50 thumbnail
                      // requests, and over HTTP/1.1 (6 connections per origin)
                      // they queued AHEAD of the photo/neighbor loads the user
                      // is actually waiting on - opening the lightbox in a
                      // fresh area hung until the strip finished. Lazy fetches
                      // only what's scrolled into view, low priority keeps the
                      // rest behind the photos being paged through.
                      loading="lazy"
                      decoding="async"
                      {...({ fetchpriority: "low" } as Record<string, string>)}
                      // Plain <img> (not the Thumb component), so add the
                      // fade-in class ourselves on load - otherwise the shared
                      // `.thumb-card img { opacity: 0 }` keeps it invisible.
                      onLoad={(e) => e.currentTarget.classList.add("is-loaded")}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {adjustOpen && <PhotoEditor image={image} onClose={() => setAdjustOpen(false)} />}
      {exportOpen && (
        <ExportDialog
          imageIds={[image.id]}
          singleFilename={image.original_filename}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}

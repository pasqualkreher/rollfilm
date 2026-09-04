import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, editVersion } from "../api/client";
import { preloadImage } from "../utils/preload";
import {
  SLIDESHOW_SPEEDS,
  setSlideshowSeconds,
  useSlideshowSeconds,
} from "../state/viewPrefs";
import { IconChevronLeft, IconChevronRight, IconPause, IconPlay, IconX } from "./Icons";
import type { ImageOut } from "../api/types";

// Fullscreen slideshow over the set of photos being browsed - started from the
// photo view's toolbar, so it plays whatever the grid you came from was
// showing (the Library's filtered set, an album, the selects...). Auto-advances
// on a fixed pace and wraps around at the end; Space pauses, the arrow keys
// step manually, Esc (or leaving fullscreen) ends it. The controls fade out
// while the show is running and come back on a mouse move or a pause.

// How long the control bar stays up after the mouse last moved.
const IDLE_HIDE_MS = 2500;

export function Slideshow({
  imageIds,
  startId,
  onClose,
}: {
  imageIds: string[];
  startId: string;
  /** Called once with the photo the show ended on, so the lightbox can follow. */
  onClose: (lastId: string) => void;
}) {
  const queryClient = useQueryClient();
  const seconds = useSlideshowSeconds();
  const [index, setIndex] = useState(() => Math.max(0, imageIds.indexOf(startId)));
  const [playing, setPlaying] = useState(true);
  // The photo whose pixels are actually on screen. The auto-advance countdown
  // starts from the load, not from the request - a slow disk must never have
  // photos skipped past while they are still arriving. A failed load counts as
  // shown, so one broken file can't stall the whole show.
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [mouseAwake, setMouseAwake] = useState(true);
  const idleTimer = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const closedRef = useRef(false);

  const currentId = imageIds[index];
  const { data: image } = useQuery({
    queryKey: ["image", currentId],
    queryFn: () => api.images.get(currentId),
    enabled: !!currentId,
  });

  const close = useCallback(() => {
    // Guarded: Esc and the fullscreenchange it triggers both land here.
    if (closedRef.current) return;
    closedRef.current = true;
    onClose(imageIds[index] ?? startId);
  }, [onClose, imageIds, index, startId]);
  // Lets the mount-only listeners (keyboard, fullscreen) call the CURRENT
  // close - re-registering them per index just to capture it would be noise.
  const closeRef = useRef(close);
  closeRef.current = close;

  const step = useCallback(
    (delta: number) => {
      setIndex((i) => (i + delta + imageIds.length) % imageIds.length);
    },
    [imageIds.length]
  );

  // The countdown to the next photo. Manual paging restarts it naturally:
  // the shown id changes, and nothing counts until its pixels have loaded.
  useEffect(() => {
    if (!playing || loadedId !== currentId) return;
    const t = window.setTimeout(() => step(1), seconds * 1000);
    return () => window.clearTimeout(t);
  }, [playing, loadedId, currentId, seconds, step]);

  // Warm the next photo (metadata, then preview pixels) while the current one
  // is on screen, so the advance is a swap instead of a load. The preview URL
  // is version-stamped for edited photos, hence metadata first.
  useEffect(() => {
    const nextId = imageIds[(index + 1) % imageIds.length];
    if (!nextId || nextId === currentId) return;
    queryClient
      .prefetchQuery({
        queryKey: ["image", nextId],
        queryFn: () => api.images.get(nextId),
        staleTime: 60_000,
      })
      .then(() => {
        const next = queryClient.getQueryData<ImageOut>(["image", nextId]);
        if (next) preloadImage(api.images.previewUrl(next.id, editVersion(next)));
      });
  }, [index, imageIds, currentId, queryClient]);

  // Take the whole screen if the browser lets us; the fixed overlay is the show
  // either way. Once IN fullscreen, leaving it (Esc goes to the browser first
  // there) ends the slideshow - the two must not come apart, or Esc would strand
  // a windowed slideshow that a second Esc then closes confusingly.
  useEffect(() => {
    boxRef.current?.requestFullscreen?.().catch(() => {
      /* no fullscreen (denied or unsupported) - the overlay stands alone */
    });
    function onFsChange() {
      if (!document.fullscreenElement) closeRef.current();
    }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  // Capture phase so the lightbox underneath never sees these keys - it gates
  // on the slideshow being open too, but belt and braces.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowLeft") {
        e.stopPropagation();
        step(-1);
      } else if (e.key === "ArrowRight") {
        e.stopPropagation();
        step(1);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [step]);

  // Controls (and the cursor) melt away while the show runs untouched; a mouse
  // move brings them back, pausing keeps them up.
  const poke = useCallback(() => {
    setMouseAwake(true);
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setMouseAwake(false), IDLE_HIDE_MS);
  }, []);
  useEffect(() => {
    poke();
    return () => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
    };
  }, [poke]);

  const showControls = mouseAwake || !playing;

  return (
    <div
      ref={boxRef}
      className={`slideshow${showControls ? "" : " slideshow--idle"}`}
      onMouseMove={poke}
      role="dialog"
      aria-label="Slideshow"
    >
      {image && (
        <img
          key={currentId}
          className="slideshow-photo"
          src={api.images.previewUrl(image.id, editVersion(image))}
          alt={image.original_filename}
          draggable={false}
          onLoad={() => setLoadedId(currentId)}
          onError={() => setLoadedId(currentId)}
          // The photo is the biggest click target there is - use it as the
          // pause/resume toggle, like every video player does.
          onClick={() => setPlaying((p) => !p)}
        />
      )}
      {/* Thin countdown along the bottom edge - says the show is running and
          how far into this photo's turn it is. Keyed so it restarts whenever
          the countdown itself does (new photo, or resume after a pause). */}
      {playing && loadedId === currentId && (
        <div
          key={`${currentId}:${seconds}`}
          className="slideshow-progress"
          style={{ animationDuration: `${seconds}s` }}
          aria-hidden
        />
      )}
      <div className="slideshow-controls">
        <button onClick={() => step(-1)} title="Previous photo (Left arrow)" aria-label="Previous photo">
          <IconChevronLeft size={16} />
        </button>
        <button
          onClick={() => setPlaying((p) => !p)}
          title={playing ? "Pause (Space)" : "Resume (Space)"}
          aria-label={playing ? "Pause" : "Resume"}
        >
          {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
        </button>
        <button onClick={() => step(1)} title="Next photo (Right arrow)" aria-label="Next photo">
          <IconChevronRight size={16} />
        </button>
        <span className="slideshow-counter">
          {index + 1} / {imageIds.length}
        </span>
        <span className="slideshow-speeds" role="group" aria-label="Seconds per photo">
          {SLIDESHOW_SPEEDS.map((s) => (
            <button
              key={s}
              className={s === seconds ? "active" : ""}
              onClick={() => setSlideshowSeconds(s)}
              title={`${s} seconds per photo`}
            >
              {s}s
            </button>
          ))}
        </span>
        <button onClick={close} title="End the slideshow (Esc)" aria-label="End the slideshow">
          <IconX size={14} />
        </button>
      </div>
    </div>
  );
}

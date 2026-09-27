import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { ColorLabel, StagedFileOut } from "../api/types";
import { RatingStars } from "./RatingStars";
import { ColorLabelPicker } from "./ColorLabelPicker";
import { fileTypeBadge, fileTypeBadgeClass } from "./ThumbnailGrid";
import { flaggedDuplicate } from "./ImportReviewGrid";
import { LIGHTBOX_NEIGHBOR_DEPTH, PinnedImageWindow } from "../utils/preload";
import { IconArrowLeft, IconChevronLeft, IconChevronRight, IconImage } from "./Icons";
import { ExifTable } from "./ExifTable";
import { useImageZoomPan } from "../utils/useImageZoomPan";
import { useFullResUpgrade } from "../utils/useFullResUpgrade";
import { ZoomReadout } from "./ZoomReadout";
import { StageBackgroundToggle } from "./StageBackgroundToggle";
import { setImportInfoPanelOpen, useImportInfoPanelOpen, useStageBg } from "../state/viewPrefs";

interface Props {
  sessionId: string;
  files: StagedFileOut[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onUpdate: (
    fileId: string,
    patch: { selected?: boolean; rating?: number; color_label?: ColorLabel; immich_sync?: boolean }
  ) => void;
  // Selective Immich sync is active - show the per-photo "Sync to Immich" checkbox.
  showImmichSync?: boolean;
  // The files list collapses RAW+JPEG pairs into one stand-in card - label that
  // card "RAW+JPG" instead of its own file type.
  pairsMerged?: boolean;
  // Set by <Presence> while the lightbox fades out: keys are ignored, so an
  // arrow pressed during the fade cannot reopen it on the neighbour.
  closing?: boolean;
}

export function ImportLightbox({
  sessionId,
  files,
  index,
  onIndexChange,
  onClose,
  onUpdate,
  showImmichSync = false,
  pairsMerged = false,
  closing = false,
}: Props) {
  const file = files[index];
  // The preview failed to load (damaged/unreadable file). Show a clean error
  // state instead of the browser's broken-image icon; rating, the import
  // toggle and arrow-key navigation keep working.
  const [loadFailed, setLoadFailed] = useState(false);
  // Whether the <img> currently on the stage has decoded. Until it has, the
  // stage shows a "Developing…" hint instead of nothing: a staged RAW whose
  // preview the import's render pass hasn't reached yet is rendered on this
  // very request, which is seconds - an empty stage read as "the photo doesn't
  // show". Reset with the photo and with the preview/full swap.
  const [photoLoaded, setPhotoLoaded] = useState(false);
  // Bumped to re-mount the <img> for a retry - a fresh request rather than the
  // browser's cached failure. The server answers 503 while every render slot
  // is busy (and the browser reports that as an error), so a failed preview is
  // asked for again a few times before it counts as unreadable.
  const [retryNonce, setRetryNonce] = useState(0);
  const retriesRef = useRef(0);
  const retryTimerRef = useRef<number | undefined>(undefined);
  const PREVIEW_RETRIES = 6;
  const PREVIEW_RETRY_MS = 2000;
  // Swap the review preview for the full-resolution render once the user zooms
  // in, so 100% shows the photo's own pixels (which is what judging critical
  // focus needs) instead of an upscaled 2048px preview. If that render can't be
  // fetched we stay on the preview - never a broken image.
  const [hiRes, setHiRes] = useState(false);
  const [fullFailed, setFullFailed] = useState(false);
  // Light / mid grey / black surround - the same shared preference (and the
  // same control) as the library photo view and the editor.
  const bgMode = useStageBg();
  // The camera-settings panel right of the photo (I, or the Info button).
  // Closed until opened, then remembered like the library's side panel.
  const infoOpen = useImportInfoPanelOpen();
  // Scroll/pinch zoom, drag pan, fit sizing - the same hook the library photo
  // view uses, so culling an import inspects photos exactly like browsing the
  // library does. The editor is deliberately NOT here: import review rates and
  // selects, it doesn't develop. Handed the staged file's real pixel size, so
  // 100% means the photo's pixels, not the review preview's.
  const zoom = useImageZoomPan(
    file?.width && file?.height ? { w: file.width, h: file.height } : null
  );
  useEffect(() => {
    setLoadFailed(false);
    setHiRes(false);
    setFullFailed(false);
    setPhotoLoaded(false);
    retriesRef.current = 0;
    window.clearTimeout(retryTimerRef.current);
    // A new photo always opens at fit - carrying a 400% view over to the next
    // frame would show a random corner of it.
    zoom.resetZoom();
    zoom.clearFit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  // Once zoomed in, upgrade to the full-resolution render (fetched lazily)
  // unless it already failed for this photo. Latches: zooming back out keeps
  // the pixels we already paid for rather than flipping back to the preview.
  useEffect(() => {
    if (zoom.zoomed && !fullFailed) setHiRes(true);
  }, [zoom.zoomed, fullFailed]);
  // A staged RAW's full render is seconds away and the server sheds load (503
  // while its single render slot stays busy, 409 once a newer zoom claimed
  // it): fetched off-screen with retries while the preview stays up, then
  // swapped in decoded - the same loader as the library lightbox. A JPEG's
  // full size is the file itself and goes straight onto the <img>.
  const isRaw = file?.file_type === "raw";
  const full = useFullResUpgrade(
    hiRes && isRaw && file ? api.import.stagedFullUrl(sessionId, file.id) : null
  );
  useEffect(() => () => window.clearTimeout(retryTimerRef.current), []);

  useEffect(() => {
    if (!file) return;
    const duplicate = flaggedDuplicate(file);
    function onKeyDown(e: KeyboardEvent) {
      if (closing) return;
      // Don't hijack keys while a text/choice control (checkbox, select,
      // text field) has focus - let it handle its own Space/Enter natively.
      // BUTTONS are deliberately NOT exempt: after clicking the ‹/› arrows
      // the clicked button kept focus, and the browser's native "Space
      // activates the focused button" then navigated AGAIN instead of
      // toggling the photo's selection.
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inControl = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";

      // Esc drops back to fit if zoomed in, and only closes from there - one
      // press must not do both (same as the library photo view).
      if (e.key === "Escape") {
        if (zoom.zoomed) zoom.resetZoom(true);
        else onClose();
      } else if (e.key === "ArrowLeft") onIndexChange(Math.max(0, index - 1));
      else if (e.key === "ArrowRight") onIndexChange(Math.min(files.length - 1, index + 1));
      else if (!inControl && e.key >= "0" && e.key <= "5") {
        // Number keys set the star rating (0 clears it).
        onUpdate(file!.id, { rating: Number(e.key) });
      } else if (!inControl && (e.key === " " || e.code === "Space")) {
        // Space toggles whether this file is imported (skipped for files that
        // are already in the library and can't be re-imported).
        e.preventDefault();
        if (!duplicate) onUpdate(file!.id, { selected: !file!.selected });
      } else if (!inControl && (e.key === "i" || e.key === "I") && !e.metaKey && !e.ctrlKey) {
        setImportInfoPanelOpen(!infoOpen);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, files.length, onIndexChange, onClose, onUpdate, file, zoom.zoomed, closing, infoOpen]);

  // Hold the 10 previous and 10 next staged previews pinned in memory while
  // this one is on screen (same sliding window as the library lightbox) -
  // zapping through a fresh import with the arrow keys swaps instantly in
  // both directions, and whatever falls out of the window is released. Also
  // triggers the server's lazy preview generation for RAW files ahead of the
  // user, hiding that first-request cost. Ordered nearest-first so the
  // immediate neighbors are warm before the far ones.
  const pinnedNeighbors = useRef(new PinnedImageWindow());
  useEffect(() => {
    const pins = pinnedNeighbors.current;
    return () => pins.clear();
  }, []);
  useEffect(() => {
    // The photo on screen goes first: its request must not share the
    // browser's few connections with a dozen low-priority neighbours while
    // the user is looking at an empty stage.
    if (!photoLoaded) return;
    const order: string[] = [];
    // Bounded window: each pinned preview holds ~11MB decoded, and an
    // unbounded one fed system-wide swapping during imports. The depth scales
    // with device RAM (±2 on 4GB machines, ±6 otherwise) - enough that a held
    // arrow key doesn't outrun it.
    for (let d = 1; d <= LIGHTBOX_NEIGHBOR_DEPTH; d++) {
      const ahead = files[index + d];
      const behind = files[index - d];
      if (ahead) order.push(ahead.id);
      if (behind) order.push(behind.id);
    }
    pinnedNeighbors.current.update(order, (id) => api.import.stagedPreviewUrl(sessionId, id));
  }, [files, index, sessionId, photoLoaded]);

  if (!file) return null;

  const isDuplicate = flaggedDuplicate(file);

  return (
    // Styled like the library's photo view (opaque app surface, the same
    // elevated image box with the light/black background toggle and the Back
    // button in the stage toolbar). Instead of the library's side panel there
    // is an optional camera-settings panel in the same rail; the review
    // controls bar above the photo stays.
    <div className={`lightbox-overlay lightbox-overlay--page${closing ? " pm-closing" : ""}`} onClick={onClose}>
      <div className="detail-layout lightbox-detail-layout" onClick={(e) => e.stopPropagation()}>
        <div className="detail-main">
          {/* The review bar sits above the photo, in a band of its own - it
              never covers image pixels, and rating/import stay in one place
              while the eye moves across the frame below. */}
          <div className="lightbox-controls">
            <div className="lightbox-controls-meta">
              <span className="lightbox-filename">{file.original_filename}</span>
              <span
                className={fileTypeBadgeClass(
                  file.file_type,
                  pairsMerged && Boolean(file.paired_staged_file_id),
                  "badge-inline"
                )}
              >
                {fileTypeBadge(file.file_type, pairsMerged && Boolean(file.paired_staged_file_id))}
              </span>
              <span className="lightbox-counter lightbox-counter--index">
                {index + 1} / {files.length}
              </span>
              <span className="lightbox-counter" title="Keyboard shortcuts">
                0-5 rate · Space import · ←/→ navigate · I info
              </span>
            </div>
            <div className="lightbox-controls-actions">
              {/* Selective sync replaces the import checkbox with the sync one -
                  two checkboxes crowded the bar, and import is still toggled by
                  Space (or Select mode in the grid). */}
              {showImmichSync && !isDuplicate ? (
                <label
                  className="lightbox-import-toggle"
                  title="Upload this photo to Immich right after import. RAW files only when “Also upload RAW files” is on in Settings."
                >
                  <input
                    type="checkbox"
                    checked={file.immich_sync}
                    onChange={(e) => onUpdate(file.id, { immich_sync: e.target.checked })}
                  />{" "}
                  Sync to Immich
                </label>
              ) : (
                <label className={`lightbox-import-toggle${isDuplicate ? " disabled" : ""}`}>
                  <input
                    type="checkbox"
                    checked={file.selected}
                    disabled={isDuplicate}
                    onChange={(e) => onUpdate(file.id, { selected: e.target.checked })}
                  />{" "}
                  {isDuplicate ? "Already in library" : "Import this file"}
                </label>
              )}
              <RatingStars rating={file.rating} onChange={(rating) => onUpdate(file.id, { rating })} />
              <ColorLabelPicker value={file.color_label} onChange={(color_label) => onUpdate(file.id, { color_label })} />
            </div>
          </div>
          <div
            className={`detail-image lightbox-stage detail-image-${bgMode}`}
            ref={zoom.setBox}
          >
            <button
              className="lightbox-nav-btn lightbox-nav-prev"
              onClick={(e) => {
                e.stopPropagation();
                e.currentTarget.blur(); // Space/Enter must never re-trigger the arrow
                onIndexChange(Math.max(0, index - 1));
              }}
              disabled={index === 0}
              tabIndex={-1}
              title="Previous photo (Left arrow)"
              aria-label="Previous photo"
            >
              <IconChevronLeft size={20} />
            </button>
            {loadFailed ? (
              <div className="detail-photo-error">
                <span className="detail-photo-error-icon" aria-hidden="true"><IconImage size={40} /></span>
                <p>This photo cannot be displayed. The file may be damaged or unreadable.</p>
                <p className="detail-photo-error-name">{file.original_filename}</p>
                <button
                  className="btn"
                  onClick={() => {
                    retriesRef.current = 0;
                    setLoadFailed(false);
                    setRetryNonce((n) => n + 1);
                  }}
                >
                  Retry
                </button>
              </div>
            ) : (
              <img
                key={retryNonce}
                ref={zoom.setImg}
                // The photo the user is looking at always wins the connection
                // pool over the neighbour prefetches and the grid's thumbnails.
                {...({ fetchpriority: "high" } as Record<string, string>)}
                className={`detail-photo${bgMode === "dark" ? " framed" : ""}${
                  zoom.zoomed ? " zoomed" : ""
                }${zoom.zoomAnim ? " zoom-anim" : ""}`}
                style={zoom.imageStyle}
                draggable={false}
                src={
                  hiRes && !isRaw
                    ? api.import.stagedFullUrl(sessionId, file.id)
                    : full.state === "ready" && full.src
                      ? full.src
                      : api.import.stagedPreviewUrl(sessionId, file.id)
                }
                alt={file.original_filename}
                onLoad={() => {
                  zoom.refit();
                  setPhotoLoaded(true);
                }}
                onError={() => {
                  // The full render is unavailable (or was superseded because
                  // the user zapped on): drop back to the preview so the photo
                  // never shows as a broken image. Only a failing PREVIEW is a
                  // real "can't display this file" - and only after the
                  // retries the busy-server case is given (see retryNonce).
                  if (hiRes && !isRaw) {
                    setFullFailed(true);
                    setHiRes(false);
                  } else if (retriesRef.current < PREVIEW_RETRIES) {
                    retriesRef.current++;
                    window.clearTimeout(retryTimerRef.current);
                    retryTimerRef.current = window.setTimeout(
                      () => setRetryNonce((n) => n + 1),
                      PREVIEW_RETRY_MS
                    );
                  } else {
                    setLoadFailed(true);
                  }
                }}
                {...zoom.imageHandlers}
              />
            )}
            {!loadFailed && !photoLoaded && (
              <div className="stage-rendering" role="status">
                <span className="spinner" aria-hidden="true" />
                {file.file_type === "raw" && !file.processed ? "Analysing…" : "Developing preview…"}
              </div>
            )}
            {!loadFailed && photoLoaded && hiRes && isRaw && full.state === "loading" && (
              <div className="stage-rendering" role="status">
                <span className="spinner" aria-hidden="true" />
                Rendering full resolution…
              </div>
            )}
            {!loadFailed && photoLoaded && hiRes && isRaw && full.state === "failed" && (
              <div className="stage-rendering" role="status">
                Full resolution unavailable – showing the preview
              </div>
            )}
            <button
              className="lightbox-nav-btn lightbox-nav-next"
              onClick={(e) => {
                e.stopPropagation();
                e.currentTarget.blur(); // Space/Enter must never re-trigger the arrow
                onIndexChange(Math.min(files.length - 1, index + 1));
              }}
              disabled={index === files.length - 1}
              tabIndex={-1}
              title="Next photo (Right arrow)"
              aria-label="Next photo"
            >
              <IconChevronRight size={20} />
            </button>
          </div>
          <div className="detail-image-toolbar">
            {/* Back sits with the other stage controls under the photo (same as
                the library's photo view), labelled rather than a bare arrow. */}
            <button
              className="btn btn-sm back-btn stage-back-btn"
              onClick={onClose}
              title="Back (Esc)"
            >
              <IconArrowLeft size={13} /> Back
            </button>
            <StageBackgroundToggle />
            <ZoomReadout zoom={zoom} />
            <span className="stage-end">
              <button
                className="btn btn-sm detail-panel-toggle"
                onClick={() => setImportInfoPanelOpen(!infoOpen)}
                title={infoOpen ? "Hide the camera settings (I)" : "Show the camera settings (I)"}
                aria-label={infoOpen ? "Hide the camera settings" : "Show the camera settings"}
                aria-expanded={infoOpen}
                aria-controls="import-info-panel"
              >
                Info {infoOpen ? <IconChevronRight size={13} /> : <IconChevronLeft size={13} />}
              </button>
            </span>
          </div>
        </div>
        {/* Same rail as the library's side panel (width, slide, chrome), kept
            mounted so opening it doesn't wait on anything. The settings come
            from the analysis; until it has run the rows read "—". */}
        <div id="import-info-panel" className={`detail-panel${infoOpen ? "" : " detail-panel--collapsed"}`}>
          <div className="detail-section">
            <div className="detail-section-label">Camera settings</div>
            <ExifTable image={file} />
          </div>
        </div>
      </div>
    </div>
  );
}

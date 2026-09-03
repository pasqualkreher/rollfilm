import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { ColorLabel, StagedFileOut } from "../api/types";
import { RatingStars } from "./RatingStars";
import { ColorLabelPicker } from "./ColorLabelPicker";
import { fileTypeBadge, fileTypeBadgeClass } from "./ThumbnailGrid";
import { LIGHTBOX_NEIGHBOR_DEPTH, PinnedImageWindow } from "../utils/preload";
import { IconArrowLeft, IconChevronLeft, IconChevronRight, IconImage } from "./Icons";
import { useImageZoomPan } from "../utils/useImageZoomPan";
import { ZoomReadout } from "./ZoomReadout";
import { StageBackgroundToggle } from "./StageBackgroundToggle";
import { useStageBg } from "../state/viewPrefs";

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
}: Props) {
  const file = files[index];
  // The preview failed to load (damaged/unreadable file). Show a clean error
  // state instead of the browser's broken-image icon; rating, the import
  // toggle and arrow-key navigation keep working.
  const [loadFailed, setLoadFailed] = useState(false);
  // Swap the review preview for the full-resolution render once the user zooms
  // in, so 100% shows the photo's own pixels (which is what judging critical
  // focus needs) instead of an upscaled 2048px preview. If that render can't be
  // fetched we stay on the preview - never a broken image.
  const [hiRes, setHiRes] = useState(false);
  const [fullFailed, setFullFailed] = useState(false);
  // Light / mid grey / black surround - the same shared preference (and the
  // same control) as the library photo view and the editor.
  const bgMode = useStageBg();
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

  useEffect(() => {
    if (!file) return;
    const duplicate = Boolean(file.duplicate_of_image_id || file.duplicate_of_staged_file_id);
    function onKeyDown(e: KeyboardEvent) {
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
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, files.length, onIndexChange, onClose, onUpdate, file, zoom.zoomed]);

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
  }, [files, index, sessionId]);

  if (!file) return null;

  const isDuplicate = Boolean(file.duplicate_of_image_id || file.duplicate_of_staged_file_id);

  return (
    // Styled like the library's photo view (opaque app surface, the same
    // elevated image box with the light/black background toggle and the Back
    // button in the stage toolbar) - just without the library's info panel;
    // the review controls bar below stays.
    <div className="lightbox-overlay lightbox-overlay--page" onClick={onClose}>
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
                0-5 rate · Space import · ←/→ navigate
              </span>
            </div>
            <div className="lightbox-controls-actions">
              {/* Selective sync replaces the import checkbox with the sync one -
                  two checkboxes crowded the bar, and import is still toggled by
                  Space (or Select mode in the grid). */}
              {showImmichSync && !isDuplicate ? (
                <label
                  className="lightbox-import-toggle"
                  title="Flag this photo for Immich sync — it uploads right after import (JPG only; RAW is skipped)"
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
                <p>This photo can't be displayed - the file may be damaged or unreadable.</p>
              </div>
            ) : (
              <img
                ref={zoom.setImg}
                className={`detail-photo${bgMode === "dark" ? " framed" : ""}${
                  zoom.zoomed ? " zoomed" : ""
                }${zoom.zoomAnim ? " zoom-anim" : ""}`}
                style={zoom.imageStyle}
                draggable={false}
                src={
                  hiRes
                    ? api.import.stagedFullUrl(sessionId, file.id)
                    : api.import.stagedPreviewUrl(sessionId, file.id)
                }
                alt={file.original_filename}
                onLoad={() => zoom.refit()}
                onError={() => {
                  // The full render is unavailable (or was superseded because
                  // the user zapped on): drop back to the preview so the photo
                  // never shows as a broken image. Only a failing PREVIEW is a
                  // real "can't display this file".
                  if (hiRes) {
                    setFullFailed(true);
                    setHiRes(false);
                  } else {
                    setLoadFailed(true);
                  }
                }}
                {...zoom.imageHandlers}
              />
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
          </div>
        </div>
      </div>
    </div>
  );
}

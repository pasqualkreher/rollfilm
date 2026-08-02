import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { ColorLabel, StagedFileOut } from "../api/types";
import { RatingStars } from "./RatingStars";
import { ColorLabelPicker } from "./ColorLabelPicker";
import { fileTypeBadge, fileTypeBadgeClass } from "./ThumbnailGrid";
import { LIGHTBOX_NEIGHBOR_DEPTH, PinnedImageWindow } from "../utils/preload";
import { IconArrowLeft } from "./Icons";

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
  // Light-table vs black background, same toggle as the library photo view.
  const [bgMode, setBgMode] = useState<"light" | "dark">("light");
  useEffect(() => {
    setLoadFailed(false);
  }, [file?.id]);

  useEffect(() => {
    if (!file) return;
    const exactDuplicate =
      Boolean(file.duplicate_of_image_id || file.duplicate_of_staged_file_id) && !file.is_near_duplicate;
    function onKeyDown(e: KeyboardEvent) {
      // Don't hijack keys while a text/choice control (checkbox, select,
      // text field) has focus - let it handle its own Space/Enter natively.
      // BUTTONS are deliberately NOT exempt: after clicking the ‹/› arrows
      // the clicked button kept focus, and the browser's native "Space
      // activates the focused button" then navigated AGAIN instead of
      // toggling the photo's selection.
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inControl = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";

      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onIndexChange(Math.max(0, index - 1));
      else if (e.key === "ArrowRight") onIndexChange(Math.min(files.length - 1, index + 1));
      else if (!inControl && e.key >= "0" && e.key <= "5") {
        // Number keys set the star rating (0 clears it).
        onUpdate(file!.id, { rating: Number(e.key) });
      } else if (!inControl && (e.key === " " || e.code === "Space")) {
        // Space toggles whether this file is imported (skipped for files that
        // are already in the library and can't be re-imported).
        e.preventDefault();
        if (!exactDuplicate) onUpdate(file!.id, { selected: !file!.selected });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [index, files.length, onIndexChange, onClose, onUpdate, file]);

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
    // Narrow window (not ±10): each pinned preview holds ~11MB decoded, and
    // a wide window fed system-wide swapping during imports. The depth
    // scales with device RAM (±2 on 4GB machines, ±4 otherwise) - both
    // cover arrow-key zapping speed comfortably.
    for (let d = 1; d <= LIGHTBOX_NEIGHBOR_DEPTH; d++) {
      const ahead = files[index + d];
      const behind = files[index - d];
      if (ahead) order.push(ahead.id);
      if (behind) order.push(behind.id);
    }
    pinnedNeighbors.current.update(order, (id) => api.import.stagedPreviewUrl(sessionId, id));
  }, [files, index, sessionId]);

  if (!file) return null;

  const isExactDuplicate = Boolean(file.duplicate_of_image_id || file.duplicate_of_staged_file_id) && !file.is_near_duplicate;

  return (
    // Styled like the library's photo view (opaque app surface, back-arrow
    // column, the same elevated image box with the light/black background
    // toggle) - just without the library's info panel; the review controls
    // bar below stays.
    <div className="lightbox-overlay lightbox-overlay--page" onClick={onClose}>
      <div className="detail-layout lightbox-detail-layout" onClick={(e) => e.stopPropagation()}>
        <button
          className="icon-btn detail-back-btn"
          onClick={onClose}
          title="Back (Esc)"
          aria-label="Back"
        >
          <IconArrowLeft size={16} />
        </button>
        <div className="detail-main">
          <div className={`detail-image lightbox-stage${bgMode === "dark" ? " detail-image-dark" : ""}`}>
            <button
              className="lightbox-nav-btn lightbox-nav-prev"
              onClick={(e) => {
                e.stopPropagation();
                e.currentTarget.blur(); // Space/Enter must never re-trigger the arrow
                onIndexChange(Math.max(0, index - 1));
              }}
              disabled={index === 0}
              tabIndex={-1}
            >
              ‹
            </button>
            {loadFailed ? (
              <div className="detail-photo-error">
                <span className="detail-photo-error-icon" aria-hidden="true">🖼️</span>
                <p>This photo can't be displayed - the file may be damaged or unreadable.</p>
              </div>
            ) : (
              <img
                className={bgMode === "dark" ? "framed" : undefined}
                src={api.import.stagedPreviewUrl(sessionId, file.id)}
                alt={file.original_filename}
                onError={() => setLoadFailed(true)}
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
            >
              ›
            </button>
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
          </div>
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
            <span className="lightbox-counter">
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
            {showImmichSync && !isExactDuplicate ? (
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
              <label className={`lightbox-import-toggle${isExactDuplicate ? " disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={file.selected}
                  disabled={isExactDuplicate}
                  onChange={(e) => onUpdate(file.id, { selected: e.target.checked })}
                />{" "}
                {isExactDuplicate ? "Already in library" : "Import this file"}
              </label>
            )}
            <RatingStars rating={file.rating} onChange={(rating) => onUpdate(file.id, { rating })} />
            <ColorLabelPicker value={file.color_label} onChange={(color_label) => onUpdate(file.id, { color_label })} />
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}

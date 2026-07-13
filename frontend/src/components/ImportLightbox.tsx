import { useEffect } from "react";
import { api } from "../api/client";
import type { ColorLabel, StagedFileOut } from "../api/types";
import { RatingStars } from "./RatingStars";
import { ColorLabelPicker } from "./ColorLabelPicker";
import { fileTypeBadge } from "./ThumbnailGrid";

interface Props {
  sessionId: string;
  files: StagedFileOut[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onUpdate: (fileId: string, patch: { selected?: boolean; rating?: number; color_label?: ColorLabel }) => void;
}

export function ImportLightbox({ sessionId, files, index, onIndexChange, onClose, onUpdate }: Props) {
  const file = files[index];

  useEffect(() => {
    if (!file) return;
    const exactDuplicate =
      Boolean(file.duplicate_of_image_id || file.duplicate_of_staged_file_id) && !file.is_near_duplicate;
    function onKeyDown(e: KeyboardEvent) {
      // Don't hijack keys while a control (checkbox/button) has focus - let it
      // handle its own Space/Enter natively.
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inControl = tag === "INPUT" || tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA";

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

  if (!file) return null;

  const isExactDuplicate = Boolean(file.duplicate_of_image_id || file.duplicate_of_staged_file_id) && !file.is_near_duplicate;

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} aria-label="Close">
        ✕
      </button>

      <button
        className="lightbox-nav-btn lightbox-nav-prev"
        onClick={(e) => {
          e.stopPropagation();
          onIndexChange(Math.max(0, index - 1));
        }}
        disabled={index === 0}
      >
        ‹
      </button>

      <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
        <img
          className="lightbox-image"
          src={api.import.stagedPreviewUrl(sessionId, file.id)}
          alt={file.original_filename}
        />
        <div className="lightbox-controls">
          <div className="lightbox-controls-meta">
            <span className="lightbox-filename">{file.original_filename}</span>
            <span className="badge-inline">
              {fileTypeBadge(file.file_type, Boolean(file.paired_staged_file_id))}
            </span>
            <span className="lightbox-counter">
              {index + 1} / {files.length}
            </span>
            <span className="lightbox-counter" title="Keyboard shortcuts">
              0-5 rate · Space import · ←/→ navigate
            </span>
          </div>
          <div className="lightbox-controls-actions">
            <label className={`lightbox-import-toggle${isExactDuplicate ? " disabled" : ""}`}>
              <input
                type="checkbox"
                checked={file.selected}
                disabled={isExactDuplicate}
                onChange={(e) => onUpdate(file.id, { selected: e.target.checked })}
              />{" "}
              {isExactDuplicate ? "Already in library" : "Import this file"}
            </label>
            <RatingStars rating={file.rating} onChange={(rating) => onUpdate(file.id, { rating })} />
            <ColorLabelPicker value={file.color_label} onChange={(color_label) => onUpdate(file.id, { color_label })} />
          </div>
        </div>
      </div>

      <button
        className="lightbox-nav-btn lightbox-nav-next"
        onClick={(e) => {
          e.stopPropagation();
          onIndexChange(Math.min(files.length - 1, index + 1));
        }}
        disabled={index === files.length - 1}
      >
        ›
      </button>
    </div>
  );
}

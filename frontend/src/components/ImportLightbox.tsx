import { useEffect } from "react";
import { api } from "../api/client";
import type { ColorLabel, StagedFileOut } from "../api/types";
import { RatingStars } from "./RatingStars";
import { ColorLabelPicker } from "./ColorLabelPicker";

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
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onIndexChange(Math.max(0, index - 1));
      else if (e.key === "ArrowRight") onIndexChange(Math.min(files.length - 1, index + 1));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [index, files.length, onIndexChange, onClose]);

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
              {file.paired_staged_file_id ? "RAW+JPG" : file.file_type.toUpperCase()}
            </span>
            <span className="lightbox-counter">
              {index + 1} / {files.length}
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

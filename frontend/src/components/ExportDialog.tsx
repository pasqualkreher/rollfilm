import { useState } from "react";
import { api } from "../api/client";

// Long-edge presets for the size dropdown; null = keep the original size.
const SIZE_OPTIONS: { label: string; value: number | null }[] = [
  { label: "Original size", value: null },
  { label: "3840 px (4K)", value: 3840 },
  { label: "2048 px", value: 2048 },
  { label: "1024 px", value: 1024 },
];

// One export dialog for both entry points: the photo page passes a single id,
// the Selects toolbar the whole selection. Same options either way - the
// server answers with a plain .jpg for one photo and a zip for several.
export function ExportDialog({ imageIds, onClose }: { imageIds: string[]; onClose: () => void }) {
  const [quality, setQuality] = useState(90);
  const [maxSize, setMaxSize] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doExport() {
    setBusy(true);
    setError(null);
    try {
      await api.images.exportImages(imageIds, { quality, max_size: maxSize });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal pair-delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pair-delete-body">
          <h3>{imageIds.length === 1 ? "Export photo" : `Export ${imageIds.length} photos`}</h3>
          <p className="settings-desc" style={{ margin: 0 }}>
            Exports a JPEG with your edits baked in, rendered at full resolution
            {imageIds.length === 1 ? "." : " - several photos download as a zip."}
          </p>
          <label className="editor-slider">
            <span className="editor-slider-head">
              <span>JPEG quality</span>
              <span className="editor-slider-val">{quality}</span>
            </span>
            <input
              type="range"
              min={60}
              max={100}
              step={1}
              value={quality}
              disabled={busy}
              onChange={(e) => setQuality(Number(e.target.value))}
            />
          </label>
          <label className="editor-slider">
            <span className="editor-slider-head">
              <span>Size</span>
            </span>
            <select
              className="preset-select"
              value={maxSize ?? ""}
              disabled={busy}
              onChange={(e) => setMaxSize(e.target.value === "" ? null : Number(e.target.value))}
            >
              {SIZE_OPTIONS.map((opt) => (
                <option key={opt.label} value={opt.value ?? ""}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
          <div className="pair-delete-actions">
            <button className="btn primary" onClick={doExport} disabled={busy}>
              {busy ? "Exporting…" : "Export"}
            </button>
            <button className="btn ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

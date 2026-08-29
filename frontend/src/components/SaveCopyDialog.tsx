import { useState } from "react";
import { useTransientMessage } from "../utils/transientMessage";
import { Dropdown } from "./Dropdown";
import { SIZE_OPTIONS } from "./ExportDialog";

// The quality a copy is baked at when nobody picks one: the maximum JPEG
// quality, which is also this dialog's starting point. A copy is a photo you
// keep, not a file you send somewhere, so it should cost detail only when you
// deliberately ask it to.
export const FULL_COPY_QUALITY = 100;

// The editor's Save-copy options, styled after the export dialog: pick the
// JPEG quality and long-edge size the copy is baked at, then wait out the
// full-resolution render right here (spinner + note instead of a progress
// bar - it's a single render, there is no per-photo count to show).
export function SaveCopyDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  // Runs the actual save-copy request; the caller closes the editor and
  // navigates to the new photo on success, which unmounts this dialog.
  onSave: (opts: { quality: number; maxSize: number | null }) => Promise<unknown>;
}) {
  const [quality, setQuality] = useState(FULL_COPY_QUALITY);
  const [maxSize, setMaxSize] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useTransientMessage();

  async function doSave() {
    setBusy(true);
    setError(null);
    try {
      await onSave({ quality, maxSize });
    } catch (e) {
      setBusy(false);
      setError((e as Error).message || "Could not save the copy.");
    }
  }

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal pair-delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pair-delete-body">
          <h3>Save copy</h3>
          <p className="settings-desc" style={{ margin: 0 }}>
            Bakes your edits into a new JPEG in your library, tagged “edit copy”. The original stays
            untouched.
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
          <div className="editor-slider">
            <span className="editor-slider-head">
              <span>Size</span>
            </span>
            <Dropdown
              value={String(maxSize ?? "")}
              disabled={busy}
              ariaLabel="Copy size"
              onChange={(v) => setMaxSize(v === "" ? null : Number(v))}
              options={SIZE_OPTIONS.map((opt) => ({
                value: String(opt.value ?? ""),
                label: opt.label,
              }))}
            />
          </div>
          {error && <span className="status-note status-note--error">{error}</span>}
          {busy && (
            <span className="status-note" role="status" aria-live="polite">
              Rendering your photo… please keep this window open.
            </span>
          )}
          <div className="pair-delete-actions">
            <button className="btn primary" onClick={doSave} disabled={busy}>
              {busy ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Saving…
                </>
              ) : (
                "Save copy"
              )}
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

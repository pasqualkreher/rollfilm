import { useState } from "react";
import { useTransientMessage } from "../utils/transientMessage";
import { Dropdown } from "./Dropdown";
import { SIZE_OPTIONS } from "./ExportDialog";
import { IconDisk, IconDuplicate } from "./Icons";

// The quality a copy is baked at when nobody picks one: the maximum JPEG
// quality, which is also this dialog's starting point. A copy is a photo you
// keep, not a file you send somewhere, so it should cost detail only when you
// deliberately ask it to.
export const FULL_COPY_QUALITY = 100;

// What Save copy can make. "physical" bakes the edits into a new JPEG on disk
// (tagged "edit copy"); "virtual" adds a second library entry that shares the
// original's file and only carries its own edits (tagged "virtual copy").
export type SaveCopyRequest =
  | { kind: "physical"; quality: number; maxSize: number | null }
  | { kind: "virtual" };

// Save copy always asks one question first: a real file or a virtual copy.
// With the Settings toggle on, picking the physical copy also exposes the
// export-style quality/size controls; otherwise it bakes at full quality. The
// render runs while the dialog is open, so it doubles as the progress popup.
export function SaveCopyDialog({
  onClose,
  onSave,
  askOptions,
}: {
  onClose: () => void;
  // Runs the actual request; the caller closes the editor and navigates to
  // the new photo on success, which unmounts this dialog.
  onSave: (req: SaveCopyRequest) => Promise<unknown>;
  // Show the JPEG quality / size controls for the physical copy.
  askOptions: boolean;
}) {
  const [kind, setKind] = useState<SaveCopyRequest["kind"]>("physical");
  const [quality, setQuality] = useState(FULL_COPY_QUALITY);
  const [maxSize, setMaxSize] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useTransientMessage();

  async function doSave() {
    setBusy(true);
    setError(null);
    try {
      await onSave(kind === "physical" ? { kind, quality, maxSize } : { kind });
    } catch (e) {
      setBusy(false);
      setError((e as Error).message || "Could not save the copy.");
    }
  }

  const physical = kind === "physical";

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal pair-delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pair-delete-body">
          <h3>Save copy</h3>
          <p className="settings-desc" style={{ margin: 0 }}>
            The original stays untouched either way.
          </p>
          <div className="copy-kind-choice" role="radiogroup" aria-label="Kind of copy">
            <button
              type="button"
              role="radio"
              aria-checked={physical}
              className={`copy-kind${physical ? " is-selected" : ""}`}
              disabled={busy}
              onClick={() => setKind("physical")}
            >
              <span className="copy-kind-icon" aria-hidden="true">
                <IconDisk size={16} />
              </span>
              <span className="copy-kind-text">
                <strong>Physical copy</strong>
                <span>A new JPEG file with your edits baked in, tagged “edit copy”.</span>
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!physical}
              className={`copy-kind${!physical ? " is-selected" : ""}`}
              disabled={busy}
              onClick={() => setKind("virtual")}
            >
              <span className="copy-kind-icon" aria-hidden="true">
                <IconDuplicate size={16} />
              </span>
              <span className="copy-kind-text">
                <strong>Virtual copy</strong>
                <span>
                  No new file: a second library entry that shares the original’s file and keeps
                  its own edits, tagged “virtual copy”.
                </span>
              </span>
            </button>
          </div>
          {physical && askOptions && (
            <>
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
            </>
          )}
          {error && <span className="status-note status-note--error">{error}</span>}
          {busy && (
            <span className="status-note" role="status" aria-live="polite">
              {physical
                ? "Rendering your photo… please keep this window open."
                : "Creating the virtual copy…"}
            </span>
          )}
          <div className="pair-delete-actions">
            <button className="btn primary" onClick={doSave} disabled={busy}>
              {busy ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Saving…
                </>
              ) : physical ? (
                "Save physical copy"
              ) : (
                "Save virtual copy"
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

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
  count = 1,
  closing = false,
}: {
  onClose: () => void;
  // Runs the actual request; the caller closes the editor and navigates to
  // the new photo on success, which unmounts this dialog. `report` tells the
  // dialog how many of `count` photos are done, for the multi-photo note.
  onSave: (req: SaveCopyRequest, report: (done: number) => void) => Promise<unknown>;
  // Show the JPEG quality / size controls for the physical copy.
  askOptions: boolean;
  // How many photos the copy is made of - the grid's multi-select passes the
  // selection size; the editor and the lightbox always copy one.
  count?: number;
  // Set by <Presence> while the dialog animates out.
  closing?: boolean;
}) {
  const [kind, setKind] = useState<SaveCopyRequest["kind"]>("physical");
  const [quality, setQuality] = useState(FULL_COPY_QUALITY);
  const [maxSize, setMaxSize] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useTransientMessage();

  async function doSave() {
    setBusy(true);
    setDone(0);
    setError(null);
    try {
      await onSave(kind === "physical" ? { kind, quality, maxSize } : { kind }, setDone);
    } catch (e) {
      setBusy(false);
      setError((e as Error).message || "Could not save the copy.");
    }
  }

  const physical = kind === "physical";
  const many = count > 1;

  return (
    <div className={`modal-overlay${closing ? " pm-closing" : ""}`} onClick={() => !busy && onClose()}>
      <div className="modal pair-delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pair-delete-body">
          <h3>{many ? `Save copy of ${count} photos` : "Save copy"}</h3>
          <p className="settings-desc" style={{ margin: 0 }}>
            {many ? "The original photos are not changed." : "The original photo is not changed."}
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
                <span>
                  {many
                    ? "A new JPEG file per photo with its edits applied, tagged “edit copy”."
                    : "A new JPEG file with your edits applied, tagged “edit copy”."}
                </span>
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
                  {many
                    ? "No new files. A second entry in the library per photo that uses the original file and keeps its own edits, tagged “virtual copy”."
                    : "No new file. A second entry in the library that uses the original file and keeps its own edits, tagged “virtual copy”."}
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
              {many
                ? `${physical ? "Rendering" : "Copying"} photo ${Math.min(done + 1, count)} of ${count}… Please keep this window open.`
                : physical
                  ? "Rendering your photo… Please keep this window open."
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
                many ? "Save physical copies" : "Save physical copy"
              ) : many ? (
                "Save virtual copies"
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

import { useState } from "react";
import { useTransientMessage } from "../utils/transientMessage";
import { useEscapeToClose } from "../utils/modalKeys";
import { Dropdown } from "./Dropdown";
import { SIZE_OPTIONS } from "./ExportDialog";
import { IconDisk, IconDuplicate } from "./Icons";
import { rangeFillStyle } from "../utils/rangeFill";
import { Spinner } from "./Spinner";

// The quality a copy is baked at when nobody picks one: the maximum JPEG
// quality, which is also this dialog's starting point. A copy is a photo you
// keep, not a file you send somewhere, so it should cost detail only when you
// deliberately ask it to.
export const FULL_COPY_QUALITY = 100;

// The long-edge slider's reach: from a thumbnail up past 8K. The presets in
// the dropdown are the common stops on this range.
const SIZE_MIN = 256;
const SIZE_MAX = 8192;
const SIZE_STEP = 8;
// Where the slider lands when "Custom" is picked with no size set yet.
const SIZE_CUSTOM_START = 2000;
const CUSTOM_SIZE = "custom";

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
  physicalOnly = false,
  title,
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
  // The bulk "Apply ... and save copy": the copies are files by definition,
  // so the physical/virtual choice stays out and only the options are asked
  // (the caller shows the dialog once for the whole batch, before it starts).
  physicalOnly?: boolean;
  // A heading of the caller's own, in place of "Save copy of N photos".
  title?: string;
}) {
  const [kind, setKind] = useState<SaveCopyRequest["kind"]>("physical");
  const [quality, setQuality] = useState(FULL_COPY_QUALITY);
  const [maxSize, setMaxSize] = useState<number | null>(null);
  // True once the size came from the slider or the "Custom" entry: the
  // dropdown then says "Custom" even while the slider sits on a preset value.
  const [customSize, setCustomSize] = useState(false);
  // The pixel field's text while it is being typed; null = shows the value.
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useTransientMessage();
  // Escape is the Cancel button - which is disabled while the copy renders.
  useEscapeToClose(!closing, () => {
    if (!busy) onClose();
  });

  async function doSave() {
    setBusy(true);
    setDone(0);
    setError(null);
    try {
      await onSave(kind === "physical" ? { kind, quality, maxSize } : { kind }, setDone);
    } catch (e) {
      setBusy(false);
      setError((e as Error).message || "Could not save the copy.", { keep: true });
    }
  }

  const physical = kind === "physical";
  const many = count > 1;

  // What the size dropdown shows: a preset, "Custom" or "Original size".
  const sizeChoice = maxSize === null ? "" : customSize ? CUSTOM_SIZE : String(maxSize);
  function pickSize(v: string) {
    setSizeDraft(null);
    if (v === "") {
      setMaxSize(null);
      setCustomSize(false);
    } else if (v === CUSTOM_SIZE) {
      setMaxSize(maxSize ?? SIZE_CUSTOM_START);
      setCustomSize(true);
    } else {
      setMaxSize(Number(v));
      setCustomSize(false);
    }
  }
  function slideSize(px: number) {
    setMaxSize(px);
    setCustomSize(true);
  }
  // The typed pixel count, applied on Enter or blur and clamped to the
  // slider's range; anything that is not a number leaves the size alone.
  function commitSizeDraft() {
    if (sizeDraft === null) return;
    const typed = Number.parseInt(sizeDraft.replace(/[^0-9]/g, ""), 10);
    setSizeDraft(null);
    if (!Number.isFinite(typed)) return;
    slideSize(Math.max(SIZE_MIN, Math.min(SIZE_MAX, typed)));
  }

  return (
    <div className={`modal-overlay${closing ? " pm-closing" : ""}`} onClick={() => !busy && onClose()}>
      <div className="modal pair-delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pair-delete-body">
          <h3>{title ?? (many ? `Save copy of ${count} photos` : "Save copy")}</h3>
          <p className="settings-desc" style={{ margin: 0 }}>
            {physicalOnly
              ? many
                ? "A new JPEG file per photo with the edits applied, tagged “edit copy”. The original photos are not changed."
                : "A new JPEG file with the edits applied, tagged “edit copy”. The original photo is not changed."
              : many
                ? "The original photos are not changed."
                : "The original photo is not changed."}
          </p>
          {!physicalOnly && (
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
          )}
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
                  style={rangeFillStyle(quality, 60, 100)}
                  onChange={(e) => setQuality(Number(e.target.value))}
                />
              </label>
              <div className="editor-slider">
                <span className="editor-slider-head">
                  <span>Size</span>
                </span>
                <Dropdown
                  value={sizeChoice}
                  disabled={busy}
                  ariaLabel="Copy size"
                  onChange={pickSize}
                  options={[
                    ...SIZE_OPTIONS.map((opt) => ({
                      value: String(opt.value ?? ""),
                      label: opt.label,
                    })),
                    { value: CUSTOM_SIZE, label: "Custom…" },
                  ]}
                />
              </div>
              {/* The long edge in pixels, always in the dialog so picking a
                  preset or "Custom" moves nothing: it follows the dropdown
                  and dragging it (or typing a number) makes the size custom.
                  Greyed out while the copy keeps its original size. */}
              <label className="editor-slider">
                <span className="editor-slider-head">
                  <span>Long edge</span>
                  <span className="copy-size-field">
                    <input
                      type="text"
                      inputMode="numeric"
                      className="copy-size-px"
                      aria-label="Long edge in pixels"
                      value={sizeDraft ?? (maxSize === null ? "" : String(maxSize))}
                      placeholder="–"
                      disabled={busy || maxSize === null}
                      onChange={(e) => setSizeDraft(e.target.value)}
                      onBlur={commitSizeDraft}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitSizeDraft();
                        } else if (e.key === "Escape") {
                          setSizeDraft(null); // the dialog's Escape handler closes it unless busy
                        }
                      }}
                    />
                    <span className="editor-slider-val">px</span>
                  </span>
                </span>
                <input
                  type="range"
                  min={SIZE_MIN}
                  max={SIZE_MAX}
                  step={SIZE_STEP}
                  value={maxSize ?? SIZE_MAX}
                  disabled={busy || maxSize === null}
                  style={rangeFillStyle(maxSize ?? SIZE_MIN, SIZE_MIN, SIZE_MAX)}
                  onChange={(e) => slideSize(Number(e.target.value))}
                  title="Drag, or type a number in the field above."
                />
              </label>
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
                  <Spinner tone="inherit" inline />
                  Saving…
                </>
              ) : physicalOnly ? (
                "Continue"
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

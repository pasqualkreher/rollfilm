// The photo view's compare group: the editor's compare toolbar (PhotoEditor's
// baseline switch, hold-to-compare eye and split / side-by-side toggles) for a
// photo that already carries its edits - minus the snapshot, which only means
// something while an edit is in progress.
//
// Always rendered, disabled when there is nothing to compare: the toolbar is
// centred, so a group that came and went per photo would shift the zoom
// readout and the slideshow button every time you paged between an edited and
// an untouched photo. The JPG step stays for the same reason (greyed out for
// a photo that has no camera JPEG) where the editor can afford to drop it.

import { IconEye, IconImage, IconSideBySide, IconSplit } from "./Icons";

export type CompareMode = "off" | "split" | "pair";

interface Props {
  /** The photo is a raw with a camera JPEG beside it. */
  hasJpg: boolean;
  vsJpg: boolean;
  onVsJpg: (on: boolean) => void;
  mode: CompareMode;
  onMode: (mode: CompareMode) => void;
  holding: boolean;
  onHold: (on: boolean) => void;
  /** Both sides would be the same picture (no tonal edit, JPG not chosen). */
  nothingToCompare: boolean;
  /** The photo on the stage has its pixels; before that, nothing to lay over. */
  ready: boolean;
}

export function CompareControls({ hasJpg, vsJpg, onVsJpg, mode, onMode, holding, onHold, nothingToCompare, ready }: Props) {
  const off = nothingToCompare || !ready;
  // In a sentence: "the original", "the camera JPG".
  const baselineName = vsJpg ? "camera JPG" : "original";
  const split = mode === "split";
  const pair = mode === "pair";
  return (
    <span className="editor-compare-group">
      <span className="segmented editor-baseline" role="group" aria-label="Compare with">
        <button
          className={vsJpg ? "" : "active"}
          aria-pressed={!vsJpg}
          aria-label="Compare with the original"
          onClick={() => onVsJpg(false)}
          title="Compare with the original photo"
        >
          <IconImage size={14} />
        </button>
        <button
          className={`editor-baseline-jpg${vsJpg ? " active" : ""}`}
          aria-pressed={vsJpg}
          aria-label="Compare with the camera JPG"
          disabled={!hasJpg}
          onClick={() => onVsJpg(true)}
          title={
            hasJpg
              ? "Compare with the JPG the camera saved beside this RAW"
              : "Only for a RAW that was shot together with a camera JPG"
          }
        >
          JPG
        </button>
      </span>
      <span className="editor-toolbar-sep" aria-hidden />
      <button
        className={`btn btn-sm editor-compare-btn${holding ? " active" : ""}`}
        onMouseDown={() => onHold(true)}
        onMouseUp={() => onHold(false)}
        onMouseLeave={() => onHold(false)}
        // A compare mode already shows the baseline; swapping the whole photo
        // under it would only make both sides the same picture.
        disabled={off || mode !== "off"}
        aria-label="Hold to compare"
        title={
          nothingToCompare
            ? "Nothing to compare: this photo has no edits"
            : holding
              ? `Showing the ${baselineName}`
              : `Hold to compare with the ${baselineName}`
        }
      >
        <IconEye size={14} />
      </button>
      <span className="segmented editor-compare-modes">
        <button
          className={split ? "active" : ""}
          aria-pressed={split}
          aria-label="Compare split by a draggable line"
          disabled={off}
          onClick={() => onMode(split ? "off" : "split")}
          title={`Split view: ${baselineName} and edit in one picture, divided by a draggable line`}
        >
          <IconSplit size={14} />
        </button>
        <button
          className={pair ? "active" : ""}
          aria-pressed={pair}
          aria-label="Compare side by side"
          disabled={off}
          onClick={() => onMode(pair ? "off" : "pair")}
          title={`Side by side: ${baselineName} and edit as two pictures`}
        >
          <IconSideBySide size={14} />
        </button>
      </span>
    </span>
  );
}

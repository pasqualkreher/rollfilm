import { IconCheck } from "./Icons";
import {
  THUMB_SIZES,
  setMergePairs,
  setThumbSize,
  useMergePairs,
  useThumbSize,
} from "../state/viewPrefs";

// Compact "light table" controls: the thumbnail size (XS-XL) plus an optional
// "merge RAW+JPG" toggle. Rendered inside the shared filter bar so every grid
// screen exposes the same controls. Size leads the bar (the file type choice
// lives in the Filter menu now); Merge follows it.
export function ViewPrefsControls({ showMerge = true }: { showMerge?: boolean }) {
  const size = useThumbSize();
  const merge = useMergePairs();

  return (
    <>
      {/* A group, not a <label>: a label belongs to its first control, so
          hovering anywhere over it lit up XS (and a click on "Size" picked it). */}
      <span className="filter-field" role="group" aria-label="Thumbnail size">
        Size
        <span className="segmented">
          {THUMB_SIZES.map((s) => (
            <button
              key={s.key}
              className={size === s.key ? "active" : ""}
              onClick={() => setThumbSize(s.key)}
              title={`Thumbnails ${s.label}`}
            >
              {s.label}
            </button>
          ))}
        </span>
      </span>

      {showMerge && (
        <button
          className={`toggle-chip${merge ? " active" : ""}`}
          onClick={() => setMergePairs(!merge)}
          aria-pressed={merge}
          title="Show each RAW and JPEG pair as one photo. Ratings and color labels apply to both files."
        >
          {merge && <IconCheck size={12} />} Merge RAW+JPG
        </button>
      )}
    </>
  );
}

import { IconPair } from "./Icons";
import {
  THUMB_SIZES,
  setMergePairs,
  setThumbSize,
  useMergePairs,
  useThumbSize,
} from "../state/viewPrefs";

// Compact "light table" controls: the thumbnail size (XS-XL) plus an optional
// "merge RAW+JPG" toggle. Rendered inside the shared filter bar so every grid
// screen exposes the same controls. Size leads the view group (the file type
// choice lives in the Filter menu); Merge follows it as an icon.
export function ViewPrefsControls({ showMerge = true }: { showMerge?: boolean }) {
  const size = useThumbSize();
  const merge = useMergePairs();

  return (
    <>
      {/* No "Size" caption: XS-XL says what it is, and the bar stays a row of
          controls rather than words. The group's name lives in aria-label and
          each segment's tooltip. data-label lets the CSS reserve the bold
          width, so picking a size never nudges the rest of the bar. */}
      <span className="segmented segmented--sizes" role="group" aria-label="Thumbnail size">
        {THUMB_SIZES.map((s) => (
          <button
            key={s.key}
            className={size === s.key ? "active" : ""}
            onClick={() => setThumbSize(s.key)}
            aria-pressed={size === s.key}
            title={`Thumbnails ${s.label}`}
            data-label={s.label}
          >
            {s.label}
          </button>
        ))}
      </span>

      {/* Icon plus the two words: the icon alone did not say what it merges.
          The on-state reads from the soft accent (no tick); data-label lets
          the CSS reserve the bold width so toggling never nudges the bar. */}
      {showMerge && (
        <button
          type="button"
          className={`toggle-chip toggle-chip--steady toggle-chip--iconlabel${merge ? " active" : ""}`}
          onClick={() => setMergePairs(!merge)}
          aria-pressed={merge}
          data-label="RAW+JPG"
          title="Show each RAW and JPEG pair as one photo. Ratings and color labels apply to both files."
        >
          <span className="toggle-chip-row">
            <IconPair size={14} /> RAW+JPG
          </span>
        </button>
      )}
    </>
  );
}

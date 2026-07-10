import {
  THUMB_SIZES,
  setMergePairs,
  setThumbSize,
  useMergePairs,
  useThumbSize,
} from "../state/viewPrefs";

// Compact "light table" controls: thumbnail size (S/M/L/XL) plus an optional
// "merge RAW+JPG" toggle. Rendered inside the shared filter bar so every grid
// screen exposes the same controls.
export function ViewPrefsControls({ showMerge = true }: { showMerge?: boolean }) {
  const size = useThumbSize();
  const merge = useMergePairs();

  return (
    <>
      <label className="filter-field">
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
      </label>

      {showMerge && (
        <button
          className={`toggle-chip${merge ? " active" : ""}`}
          onClick={() => setMergePairs(!merge)}
          aria-pressed={merge}
          title="Show each RAW+JPEG pair as one photo. Rating or coloring it applies to the RAW too."
        >
          {merge ? "✓ " : ""}Merge RAW+JPG
        </button>
      )}
    </>
  );
}

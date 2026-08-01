import {
  THUMB_SIZES,
  setMergePairs,
  setThumbSize,
  useMergePairs,
  useThumbSize,
} from "../state/viewPrefs";

// Compact "light table" controls: an optional "merge RAW+JPG" toggle plus the
// thumbnail size (S/M/L/XL). Rendered inside the shared filter bar so every
// grid screen exposes the same controls. Merge comes first so it sits right
// next to the RAW/JPEG type toggle it belongs with; Size is a generic display
// preference and closes the group.
export function ViewPrefsControls({ showMerge = true }: { showMerge?: boolean }) {
  const size = useThumbSize();
  const merge = useMergePairs();

  return (
    <>
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
    </>
  );
}

import { THUMB_SIZES, setThumbSize, useThumbSize } from "../state/viewPrefs";

// The thin strip under a photo grid: how many photos are in view, how many are
// selected, which filters narrow the set, and the thumbnail size - the status
// bar every desktop image browser keeps at the foot of the window.

export function LibraryStatusBar({
  shown,
  selected,
  filters,
}: {
  // Photos in the grid right now; undefined while they load.
  shown: number | undefined;
  selected: number;
  // Human labels for the active filters, in the order they read best.
  filters: string[];
}) {
  const size = useThumbSize();
  return (
    <div className="status-bar" role="status" aria-live="polite">
      <span className="status-bar-count">
        {shown === undefined ? "…" : `${shown.toLocaleString()} photo${shown === 1 ? "" : "s"}`}
      </span>
      {selected > 0 && <span className="status-bar-selected">{selected.toLocaleString()} selected</span>}
      {filters.length > 0 && (
        <span className="status-bar-filters" data-tip={filters.join(" · ")}>
          {filters.join(" · ")}
        </span>
      )}
      <span className="status-bar-spacer" />
      <div className="segmented status-bar-size" role="group" aria-label="Thumbnail size">
        {THUMB_SIZES.map((s) => (
          <button
            key={s.key}
            type="button"
            className={s.key === size ? "active" : undefined}
            aria-pressed={s.key === size}
            onClick={() => setThumbSize(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// The active filters as short labels. Every argument is optional so each grid
// passes what it has.
export function summarizeFilters(f: {
  q?: string;
  viewMode?: string;
  ratingMin?: number;
  colorLabel?: string;
  albumName?: string | null;
  canvasName?: string | null;
  tags?: string[];
  camera?: string;
  lens?: string;
  focalMin?: number | null;
  focalMax?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}): string[] {
  const out: string[] = [];
  if (f.q) out.push(`“${f.q}”`);
  if (f.viewMode === "raw") out.push("RAW only");
  else if (f.viewMode === "jpeg") out.push("JPEG only");
  if (f.ratingMin) out.push(`★ ${f.ratingMin}+`);
  if (f.colorLabel && f.colorLabel !== "none") out.push(f.colorLabel[0].toUpperCase() + f.colorLabel.slice(1));
  if (f.albumName) out.push(`Album: ${f.albumName}`);
  if (f.canvasName) out.push(`Canvas: ${f.canvasName}`);
  if (f.tags && f.tags.length) out.push(f.tags.length === 1 ? f.tags[0] : `${f.tags.length} tags`);
  if (f.camera) out.push(f.camera);
  if (f.lens) out.push(f.lens);
  if (f.focalMin || f.focalMax) {
    out.push(
      f.focalMin && f.focalMax
        ? `${f.focalMin}–${f.focalMax} mm`
        : f.focalMin
          ? `≥ ${f.focalMin} mm`
          : `≤ ${f.focalMax} mm`
    );
  }
  if (f.dateFrom || f.dateTo) {
    out.push(f.dateFrom && f.dateTo ? `${f.dateFrom} → ${f.dateTo}` : f.dateFrom ? `from ${f.dateFrom}` : `until ${f.dateTo}`);
  }
  return out;
}

import type { ReactNode } from "react";
import type { AlbumOut, ColorLabel, Facet, ViewMode } from "../api/types";
import { ViewModeToggle } from "./ViewModeToggle";
import { ColorLabelPicker } from "./ColorLabelPicker";
import { ViewPrefsControls } from "./ViewPrefsControls";
import { TagFilter } from "./TagFilter";
import { FilterChip } from "./FilterChip";
import { Dropdown } from "./Dropdown";
import { IconFilter } from "./Icons";

// Dual-thumb slider over the focal lengths actually present in the library
// (the facet's sorted, formatted mm values are its stops). Dragging both
// thumbs to the outer ends means "any" and clears the filter.
function FocalRangeSlider({
  options,
  min,
  max,
  onChange,
}: {
  options: Facet[];
  min: string;
  max: string;
  onChange: (min: string, max: string) => void;
}) {
  const values = options.map((o) => parseFloat(o.value));
  const last = values.length - 1;

  // Selected bounds as slider positions. The stops shift under cross-filtering
  // (picking a camera narrows them), so snap a stored bound to the nearest
  // remaining stop rather than requiring an exact match.
  const toIndex = (bound: string, fallback: number) => {
    if (!bound) return fallback;
    const num = parseFloat(bound);
    let best = fallback;
    let bestDist = Infinity;
    values.forEach((v, i) => {
      const d = Math.abs(v - num);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  };
  const lo = toIndex(min, 0);
  const hi = toIndex(max, last);

  const commit = (nextLo: number, nextHi: number) => {
    if (nextLo <= 0 && nextHi >= last) onChange("", "");
    else onChange(options[nextLo].value, options[nextHi].value);
  };

  if (values.length === 0) return null;
  if (values.length === 1) {
    return <span className="focal-range-value">{options[0].value}mm</span>;
  }

  const active = Boolean(min || max);
  return (
    <div className="focal-range">
      <span className={`focal-range-value${active ? " active" : ""}`}>
        {active ? `${options[lo].value}mm – ${options[hi].value}mm` : "Any"}
      </span>
      <div className="dual-range">
        <div className="dual-range-track" />
        <div
          className="dual-range-fill"
          style={{
            left: `${(lo / last) * 100}%`,
            width: `${((hi - lo) / last) * 100}%`,
          }}
        />
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={lo}
          aria-label="Minimum focal length"
          onChange={(e) => {
            const v = Math.min(Number(e.target.value), hi);
            commit(v, hi);
          }}
        />
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={hi}
          aria-label="Maximum focal length"
          onChange={(e) => {
            const v = Math.max(Number(e.target.value), lo);
            commit(lo, v);
          }}
        />
      </div>
    </div>
  );
}

interface Props {
  viewMode: ViewMode;
  onViewMode: (v: ViewMode) => void;
  ratingMin: number;
  onRatingMin: (n: number) => void;
  colorLabel: ColorLabel;
  onColorLabel: (c: ColorLabel) => void;
  // When provided, an album filter is shown. Album detail pages omit this
  // (they're already scoped to one album); the Library shows it.
  albums?: AlbumOut[];
  albumId?: string;
  onAlbumId?: (id: string) => void;
  // When provided, a multi-select "Tag" filter is shown. `allTags` is every
  // tag name the user has ever created; `selectedTags` are the ones the grid is
  // currently filtered to (AND - a photo must have all of them). Album detail
  // and Library both show it; Import review omits it (staged files aren't
  // tagged yet).
  allTags?: string[];
  selectedTags?: string[];
  onTags?: (tags: string[]) => void;
  // When provided, a "Camera" dropdown of the camera models present in the
  // library is shown. `camera` is the selected model ("" = any).
  cameras?: Facet[];
  camera?: string;
  onCamera?: (model: string) => void;
  // When provided, a "Lens" dropdown of the lens names present in the library
  // is shown. `lens` is the selected name ("" = any).
  lenses?: Facet[];
  lens?: string;
  onLens?: (lens: string) => void;
  // When provided, a "Focal length" range slider over the focal lengths
  // present in the library is shown. Bounds are the facet's formatted mm
  // numbers ("23", "8.8"); "" = unbounded on that side.
  focalLengths?: Facet[];
  focalMin?: string;
  focalMax?: string;
  onFocalRange?: (min: string, max: string) => void;
  // When provided, a "From date – To date" range is shown that filters by
  // capture date (taken_at) with month/day precision via native date pickers.
  // Both handlers must be given to enable it. Values are ISO dates ("YYYY-MM-DD").
  dateFrom?: string | null;
  dateTo?: string | null;
  onDateFrom?: (d: string | null) => void;
  onDateTo?: (d: string | null) => void;
  // Whether to show the "Merge RAW+JPG" toggle. Off for the import review grid,
  // which works on staged files rather than library pairs.
  showMerge?: boolean;
  // Extra view controls (e.g. import's "Hide duplicates") rendered inside the
  // view group, left of the divider - so they read as a display option rather
  // than a page action.
  viewExtras?: ReactNode;
  // Extra actions (e.g. import's Select / Select all buttons) render after the
  // shared filters, right of the divider, so every screen keeps an identical
  // filter core.
  children?: ReactNode;
}

// The shared filter row used by the Library, Album detail, and Import review
// screens - so rating and color filtering behave identically everywhere.
export function PhotoFilters({
  viewMode,
  onViewMode,
  ratingMin,
  onRatingMin,
  colorLabel,
  onColorLabel,
  albums,
  albumId,
  onAlbumId,
  allTags,
  selectedTags,
  onTags,
  cameras,
  camera,
  onCamera,
  lenses,
  lens,
  onLens,
  focalLengths,
  focalMin,
  focalMax,
  onFocalRange,
  dateFrom,
  dateTo,
  onDateFrom,
  onDateTo,
  showMerge = true,
  viewExtras,
  children,
}: Props) {
  const showDates = Boolean(onDateFrom && onDateTo);
  const showCamera = Boolean(cameras && onCamera);
  const showLens = Boolean(lenses && onLens);
  const showFocal = Boolean(focalLengths && onFocalRange);
  // How many filters are engaged - shown on the closed Filter chip so the
  // state stays visible while the menu is shut.
  const activeCount =
    (ratingMin > 0 ? 1 : 0) +
    (colorLabel !== "none" ? 1 : 0) +
    ((albumId ?? "") !== "" ? 1 : 0) +
    ((selectedTags?.length ?? 0) > 0 ? 1 : 0) +
    ((camera ?? "") !== "" ? 1 : 0) +
    ((lens ?? "") !== "" ? 1 : 0) +
    (focalMin || focalMax ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0);
  const isFiltering = activeCount > 0;

  function clearAll() {
    onRatingMin(0);
    onColorLabel("none");
    onAlbumId?.("");
    onTags?.([]);
    onCamera?.("");
    onLens?.("");
    onFocalRange?.("", "");
    onDateFrom?.(null);
    onDateTo?.(null);
  }

  return (
    <div className="filter-bar filter-bar--sticky">
      {/* View: how the same photos are displayed (type, size, pairing). */}
      <div className="control-group control-group--view">
        <ViewModeToggle value={viewMode} onChange={onViewMode} />
        <ViewPrefsControls showMerge={showMerge} />
        {viewExtras}
      </div>

      {/* All filters live behind one quiet "Filter" chip (funnel + count),
          like a pro app's filter popover - the bar itself stays one calm row.
          Inside the menu every filter gets a labelled row and full-width
          control, where that verbosity belongs. Sits between the view
          controls and the page actions. */}
      <div className="control-group">
        <FilterChip
          title="Filter photos"
          active={isFiltering}
          label={
            <>
              <IconFilter size={12} /> Filter
              {activeCount > 0 ? ` · ${activeCount}` : ""}
            </>
          }
        >
          <div className="filter-menu">
            {albums && onAlbumId && (
              <div className="filter-menu-row">
                <span className="filter-menu-label">Album</span>
                <Dropdown
                  ariaLabel="Album"
                  value={albumId ?? ""}
                  onChange={onAlbumId}
                  options={[
                    { value: "", label: "All photos" },
                    ...albums.map((a) => ({ value: a.id, label: a.name })),
                  ]}
                />
              </div>
            )}

            <div className="filter-menu-row">
              <span className="filter-menu-label">Rating</span>
              <Dropdown
                ariaLabel="Rating"
                value={String(ratingMin)}
                onChange={(v) => onRatingMin(Number(v))}
                options={[0, 1, 2, 3, 4, 5].map((n) => ({
                  value: String(n),
                  label: n === 0 ? "Any" : `${"★".repeat(n)}+`,
                }))}
              />
            </div>

            <div className="filter-menu-row">
              <span className="filter-menu-label">Color</span>
              <ColorLabelPicker value={colorLabel} onChange={onColorLabel} />
            </div>

            {allTags && onTags && (
              <div className="filter-menu-row">
                <span className="filter-menu-label">Tags</span>
                <TagFilter options={allTags} value={selectedTags ?? []} onChange={onTags} />
              </div>
            )}

            {showCamera && (
              <div className="filter-menu-row">
                <span className="filter-menu-label">Camera</span>
                <Dropdown
                  ariaLabel="Camera"
                  value={camera ?? ""}
                  onChange={(v) => onCamera?.(v)}
                  // The selected value can drop out of the cross-filtered
                  // options (facets refetching); keep it listed so the button
                  // never shows a stale blank.
                  options={[
                    { value: "", label: "All cameras" },
                    ...cameras!.map((c) => ({ value: c.value, label: `${c.value} (${c.count})` })),
                    ...(camera && !cameras!.some((c) => c.value === camera)
                      ? [{ value: camera, label: camera }]
                      : []),
                  ]}
                />
              </div>
            )}

            {showLens && (
              <div className="filter-menu-row">
                <span className="filter-menu-label">Lens</span>
                <Dropdown
                  ariaLabel="Lens"
                  value={lens ?? ""}
                  onChange={(v) => onLens?.(v)}
                  options={[
                    { value: "", label: "All lenses" },
                    ...lenses!.map((l) => ({ value: l.value, label: `${l.value} (${l.count})` })),
                    ...(lens && !lenses!.some((l) => l.value === lens)
                      ? [{ value: lens, label: lens }]
                      : []),
                  ]}
                />
              </div>
            )}

            {showFocal && focalLengths!.length > 0 && (
              <div className="filter-menu-row">
                <span className="filter-menu-label">Focal length</span>
                <FocalRangeSlider
                  options={focalLengths!}
                  min={focalMin ?? ""}
                  max={focalMax ?? ""}
                  onChange={(min, max) => onFocalRange?.(min, max)}
                />
              </div>
            )}

            {showDates && (
              <div className="filter-menu-row">
                <span className="filter-menu-label">Date</span>
                <span className="date-range">
                  <input
                    type="date"
                    value={dateFrom ?? ""}
                    max={dateTo ?? undefined}
                    onChange={(e) => onDateFrom?.(e.target.value || null)}
                    aria-label="From date"
                  />
                  <span className="date-range-sep">–</span>
                  <input
                    type="date"
                    value={dateTo ?? ""}
                    min={dateFrom ?? undefined}
                    onChange={(e) => onDateTo?.(e.target.value || null)}
                    aria-label="To date"
                  />
                </span>
              </div>
            )}
          </div>
        </FilterChip>

        {isFiltering && (
          <button className="btn ghost btn-sm" onClick={clearAll}>
            Clear
          </button>
        )}
      </div>

      {/* Page-specific actions (Select, Select all, ...). */}
      {children && <div className="control-group control-group--actions">{children}</div>}
    </div>
  );
}

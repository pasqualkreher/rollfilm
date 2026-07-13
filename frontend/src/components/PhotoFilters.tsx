import type { ReactNode } from "react";
import type { AlbumOut, ColorLabel, Facet, ViewMode } from "../api/types";
import { ViewModeToggle } from "./ViewModeToggle";
import { ColorLabelPicker } from "./ColorLabelPicker";
import { ViewPrefsControls } from "./ViewPrefsControls";
import { TagFilter } from "./TagFilter";

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
  const isFiltering =
    ratingMin > 0 ||
    colorLabel !== "none" ||
    (albumId ?? "") !== "" ||
    (selectedTags?.length ?? 0) > 0 ||
    (camera ?? "") !== "" ||
    Boolean(dateFrom) ||
    Boolean(dateTo);

  function clearAll() {
    onRatingMin(0);
    onColorLabel("none");
    onAlbumId?.("");
    onTags?.([]);
    onCamera?.("");
    onDateFrom?.(null);
    onDateTo?.(null);
  }

  return (
    <div className="filter-bar filter-bar--sticky">
      {/* Filters: narrow down *which* photos are shown. */}
      <div className="control-group">
        {albums && onAlbumId && (
          <label className="filter-field">
            Album
            <select value={albumId ?? ""} onChange={(e) => onAlbumId(e.target.value)}>
              <option value="">All photos</option>
              {albums.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="filter-field">
          Rating
          <select value={ratingMin} onChange={(e) => onRatingMin(Number(e.target.value))}>
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "Any" : `${"★".repeat(n)}+`}
              </option>
            ))}
          </select>
        </label>

        <label className="filter-field">
          Color
          <ColorLabelPicker value={colorLabel} onChange={onColorLabel} />
        </label>

        {allTags && onTags && (
          <label className="filter-field">
            Tags
            <TagFilter options={allTags} value={selectedTags ?? []} onChange={onTags} />
          </label>
        )}

        {showCamera && (
          <label className="filter-field">
            Camera
            <select value={camera ?? ""} onChange={(e) => onCamera?.(e.target.value)}>
              <option value="">All cameras</option>
              {cameras!.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.value} ({c.count})
                </option>
              ))}
            </select>
          </label>
        )}

        {showDates && (
          <label className="filter-field">
            Date
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
          </label>
        )}

        {isFiltering && (
          <button className="btn ghost btn-sm" onClick={clearAll}>
            Clear
          </button>
        )}
      </div>

      {/* View: how the same photos are displayed (type, size, pairing). Pushed
          to the right and divided off so it reads as a distinct concern from the
          filters above. */}
      <div className="control-group control-group--view">
        <ViewModeToggle value={viewMode} onChange={onViewMode} />
        <ViewPrefsControls showMerge={showMerge} />
        {viewExtras}
      </div>

      {/* Page-specific actions (Select, Select all, ...). */}
      {children && <div className="control-group control-group--actions">{children}</div>}
    </div>
  );
}

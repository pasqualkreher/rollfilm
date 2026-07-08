import type { ReactNode } from "react";
import type { AlbumOut, ColorLabel, ViewMode } from "../api/types";
import { ViewModeToggle } from "./ViewModeToggle";
import { ColorLabelPicker } from "./ColorLabelPicker";

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
  // Extra controls (e.g. import's "Hide duplicates" / select buttons) render
  // after the shared filters so every screen keeps an identical filter core.
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
  children,
}: Props) {
  const isFiltering = ratingMin > 0 || colorLabel !== "none" || (albumId ?? "") !== "";

  function clearAll() {
    onRatingMin(0);
    onColorLabel("none");
    onAlbumId?.("");
  }

  return (
    <div className="filter-bar">
      <ViewModeToggle value={viewMode} onChange={onViewMode} />

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

      <button className="btn ghost" onClick={clearAll} disabled={!isFiltering}>
        Clear filters
      </button>

      {children}
    </div>
  );
}

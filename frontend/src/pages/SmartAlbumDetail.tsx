import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { withoutMembershipNames } from "../utils/autoTags";
import type { ColorLabel, ImageOut, SmartAlbumOut, ViewMode } from "../api/types";
import { ThumbnailGrid } from "../components/ThumbnailGrid";
import { PhotoFilters } from "../components/PhotoFilters";
import { IconArrowLeft } from "../components/Icons";
import { collapsePairs } from "../state/viewPrefs";

// Read-only view of one smart album's photos. Smart albums are virtual (no
// Album row, nothing to rename or edit), so unlike AlbumDetail this page is
// just a title and the grid - selection, tagging etc. happen in the library.
export function SmartAlbumDetail() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<ViewMode>("combined");
  const [ratingMin, setRatingMin] = useState(0);
  const [colorLabel, setColorLabel] = useState<ColorLabel>("none");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState<string | null>(null);
  const [dateTo, setDateTo] = useState<string | null>(null);

  // Escape walks back to the albums, the same as it leaves a manual album,
  // the lightbox and the editor - one key out of any view. A dialog on top
  // captures Escape before this sees it.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      // A text box keeps its own Escape (backing out of a search).
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      navigate("/albums");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);
  // Navigating from the Albums page passes the card's metadata along; a
  // direct/reloaded visit falls back to looking it up in the smart list.
  const fromState = (location.state as { smart?: SmartAlbumOut } | null)?.smart;

  const { data: smart } = useQuery({
    queryKey: ["smart-albums"],
    queryFn: () => api.smartAlbums.list(),
    enabled: !fromState,
  });
  const meta =
    fromState ??
    (smart
      ? [
          ...smart.clusters,
          ...smart.tags,
          ...smart.places,
          ...smart.countries,
          ...smart.country_years,
          ...smart.years,
          ...smart.months,
          ...smart.days,
          ...smart.edits,
        ].find(
          (a) => a.id === id
        )
      : undefined);

  const { data: images, isLoading, isError } = useQuery({
    queryKey: ["smart-album-images", id],
    queryFn: () => api.smartAlbums.images(id!),
    enabled: !!id,
  });

  const { data: allTags } = useQuery({
    queryKey: ["tags"],
    queryFn: () => api.tags.list(),
    select: withoutMembershipNames,
  });

  // A smart album is a fixed, server-computed list (no filter parameters on its
  // endpoint), so the bar's filters are applied here to the photos already in
  // hand - same rules as the backend's library query, just client-side.
  const matches = (img: ImageOut) => {
    if (viewMode === "jpeg_only" && img.file_type !== "jpeg") return false;
    if (viewMode === "raw_only" && img.file_type !== "raw") return false;
    if (ratingMin > 0 && img.rating < ratingMin) return false;
    if (colorLabel !== "none" && img.color_label !== colorLabel) return false;
    // AND, like the library: a photo must carry every picked tag.
    if (selectedTags.length && !selectedTags.every((t) => img.tags.includes(t))) return false;
    // Capture date, so a photo without one drops out of a date range at all -
    // the same as the server's NULL comparison. ISO strings compare by date.
    if (dateFrom && !(img.taken_at && img.taken_at >= `${dateFrom}T00:00:00`)) return false;
    if (dateTo && !(img.taken_at && img.taken_at <= `${dateTo}T23:59:59`)) return false;
    return true;
  };
  const filtered = (images ?? []).filter(matches);

  // Like an opened manual album: the default view collapses each RAW+JPEG pair
  // to its JPEG - one card per shot, showing the file everyone actually looks
  // at - while the JPEG/RAW buttons give a flat, type-filtered list instead.
  const orderedImages = viewMode === "combined" ? collapsePairs(filtered) : filtered;
  // Date sections + the right-edge scrubber, like an opened manual album. The
  // grid picks the granularity itself: a single-month album (a month card, a
  // one-trip moment) gets day sections, anything wider months - so a "July
  // 2026" album scrubs by day instead of being one giant section.

  return (
    <div className="page page-timeline">
      {/* The same view + filter bar as the library and a manual album, so a
          smart album is looked through the same way as everything else. Merge
          is hidden: the combined view always collapses pairs here. */}
      <PhotoFilters
        viewMode={viewMode}
        onViewMode={setViewMode}
        showMerge={false}
        ratingMin={ratingMin}
        onRatingMin={setRatingMin}
        colorLabel={colorLabel}
        onColorLabel={setColorLabel}
        allTags={allTags}
        selectedTags={selectedTags}
        onTags={setSelectedTags}
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFrom={setDateFrom}
        onDateTo={setDateTo}
      />
      <div className="page-scroll">
        {isError && (
          <div className="empty-state">
            This smart album is gone - it was recomputed after new imports. Go back and pick a fresh one.
          </div>
        )}
        {isLoading && (
          <div className="smart-row" style={{ flexWrap: "wrap", overflowX: "hidden" }} aria-hidden>
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="smart-card smart-card--skeleton" />
            ))}
          </div>
        )}
        {images && images.length === 0 && <div className="empty-state">No photos here right now.</div>}
        {images && images.length > 0 && orderedImages.length === 0 && (
          <div className="empty-state">No photos match the filters.</div>
        )}
        {orderedImages.length > 0 && <ThumbnailGrid images={orderedImages} groupByDate />}
      </div>

      {/* The album's row - Back and name - lives UNDER the content, like the
          manual albums' row and the stage rows of the editor and photo view:
          the name centred, Back flush left and out of the row's flow. */}
      <h2 className="section-title album-bottom-bar">
        {/* Same Back button as the photo view, the import review and the
            editor - one look for leaving any view. */}
        <Link to="/albums" className="btn btn-sm back-btn stage-back-btn" title="Back to albums">
          <IconArrowLeft size={13} /> Back
        </Link>
        {meta?.name ?? "Smart album"}
        {meta && <span className="count-pill">{meta.image_count} photos</span>}
      </h2>
    </div>
  );
}

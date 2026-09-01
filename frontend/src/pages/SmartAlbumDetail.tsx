import { useEffect } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { SmartAlbumOut } from "../api/types";
import { ThumbnailGrid } from "../components/ThumbnailGrid";
import { IconArrowLeft } from "../components/Icons";
import { collapsePairs } from "../state/viewPrefs";

// Read-only view of one smart album's photos. Smart albums are virtual (no
// Album row, nothing to rename or edit), so unlike AlbumDetail this page is
// just a title and the grid - selection, tagging etc. happen in the library.
export function SmartAlbumDetail() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();

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

  // Smart albums have no filter bar to host a "Merge RAW+JPG" toggle, so we
  // always collapse each RAW+JPEG pair to its JPEG - one card per shot, showing
  // the JPEG everyone actually looks at (same as the merged library/import view).
  const orderedImages = collapsePairs(images ?? []);
  // Date sections + the right-edge scrubber, like an opened manual album. The
  // grid picks the granularity itself: a single-month album (a month card, a
  // one-trip moment) gets day sections, anything wider months - so a "July
  // 2026" album scrubs by day instead of being one giant section.

  return (
    <div className="page page-timeline">
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
        {images && images.length > 0 && <ThumbnailGrid images={orderedImages} groupByDate />}
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

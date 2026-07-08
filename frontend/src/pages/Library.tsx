import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ColorLabel, LibraryFilters, ViewMode } from "../api/types";
import { ThumbnailGrid } from "../components/ThumbnailGrid";
import { RatingStars } from "../components/RatingStars";
import { ColorLabelPicker } from "../components/ColorLabelPicker";
import { AlbumPicker } from "../components/AlbumPicker";
import { BulkTagInput } from "../components/BulkTagInput";
import { PhotoFilters } from "../components/PhotoFilters";
import { useSelects } from "../state/selects";
import { groupPairsAdjacent } from "../utils/pairing";

export function Library() {
  const [viewMode, setViewMode] = useState<ViewMode>("combined");
  const [ratingMin, setRatingMin] = useState<number>(0);
  const [colorLabel, setColorLabel] = useState<ColorLabel>("none");
  const [albumId, setAlbumId] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const selects = useSelects();

  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });

  const filters: LibraryFilters = {
    view_mode: viewMode,
    rating_min: ratingMin || undefined,
    color_label: colorLabel !== "none" ? colorLabel : undefined,
    album_id: albumId || undefined,
  };

  const { data: images, isLoading } = useQuery({
    queryKey: ["images", filters],
    queryFn: () => api.images.list(filters),
  });

  const orderedImages =
    viewMode === "combined" ? groupPairsAdjacent(images ?? [], (img) => img.paired_image_id) : images ?? [];

  // Click = toggle; shift-click = select the whole range since the last
  // click, like Finder/Photos - makes selecting a long run of photos fast
  // instead of clicking every single one.
  function toggleSelect(id: string, index: number, shiftKey: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastIndex !== null) {
        const [start, end] = lastIndex < index ? [lastIndex, index] : [index, lastIndex];
        for (let i = start; i <= end; i++) next.add(orderedImages[i].id);
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setLastIndex(index);
  }

  function selectAll() {
    setSelected(new Set(orderedImages.map((img) => img.id)));
  }

  function clearSelection() {
    setSelected(new Set());
    setLastIndex(null);
  }

  async function applyBulk(patch: { rating?: number; color_label?: string }) {
    if (selected.size === 0) return;
    await api.images.bulkUpdate(Array.from(selected), patch);
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} photo(s)? This removes the original files too - it cannot be undone.`)) {
      return;
    }
    await api.images.bulkDelete(Array.from(selected));
    clearSelection();
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  async function addTagToSelected(name: string) {
    if (selected.size === 0 || !name.trim()) return;
    await api.images.bulkAddTags(Array.from(selected), [name.trim()]);
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["tags"] });
  }

  async function addSelectedToAlbum(albumId: string) {
    if (selected.size === 0) return;
    await api.albums.addImages(albumId, Array.from(selected));
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  async function resetSelectedMetadata() {
    if (selected.size === 0) return;
    if (!window.confirm(`Reset stars, colors, and tags for ${selected.size} photo(s)?`)) return;
    await api.images.bulkReset(Array.from(selected));
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  return (
    <div className="page page-timeline">
      <PhotoFilters
        viewMode={viewMode}
        onViewMode={setViewMode}
        ratingMin={ratingMin}
        onRatingMin={setRatingMin}
        colorLabel={colorLabel}
        onColorLabel={setColorLabel}
        albums={albums}
        albumId={albumId}
        onAlbumId={setAlbumId}
      >
        <button
          className={`btn${selectMode ? " primary" : ""}`}
          onClick={() => {
            setSelectMode((v) => !v);
            if (selectMode) clearSelection();
          }}
        >
          {selectMode ? "Done selecting" : "Select"}
        </button>
        {selectMode && (
          <>
            <button className="btn" onClick={selectAll}>
              Select all
            </button>
            <button className="btn" onClick={clearSelection} disabled={selected.size === 0}>
              Clear selection
            </button>
          </>
        )}
      </PhotoFilters>
      {selected.size > 0 && (
        <div className="filter-bar">
          <span>{selected.size} selected</span>
          <RatingStars rating={0} onChange={(r) => applyBulk({ rating: r })} />
          <ColorLabelPicker value="none" onChange={(c) => applyBulk({ color_label: c })} />
          <BulkTagInput onAdd={addTagToSelected} />
          <AlbumPicker onAdd={addSelectedToAlbum} />
          <button className="btn" onClick={() => selects.add(Array.from(selected))}>
            Add to selects
          </button>
          <button className="btn" onClick={resetSelectedMetadata}>
            Reset stars/tags/colors
          </button>
          <button className="btn" style={{ borderColor: "var(--danger)", color: "var(--danger)" }} onClick={deleteSelected}>
            Delete selected
          </button>
        </div>
      )}
      {selectMode && (
        <p style={{ color: "var(--text-muted)", marginTop: -8, marginBottom: 16 }}>
          Click photos to select them - shift-click to select a range.
        </p>
      )}

      {isLoading ? (
        <div className="empty-state">Loading...</div>
      ) : (
        <ThumbnailGrid
          images={orderedImages}
          selectedIds={selected}
          onToggleSelect={toggleSelect}
          selectMode={selectMode}
          groupByDate
        />
      )}
    </div>
  );
}

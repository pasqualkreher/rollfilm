import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
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

export function AlbumDetail() {
  const { id } = useParams<{ id: string }>();
  const [viewMode, setViewMode] = useState<ViewMode>("combined");
  const [ratingMin, setRatingMin] = useState<number>(0);
  const [colorLabel, setColorLabel] = useState<ColorLabel>("none");
  const [dateFrom, setDateFrom] = useState<string | null>(null);
  const [dateTo, setDateTo] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const selects = useSelects();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = (searchParams.get("q") ?? "").trim();

  const { data: album } = useQuery({
    queryKey: ["album", id],
    queryFn: () => api.albums.get(id!),
    enabled: !!id,
  });

  const filters: LibraryFilters = {
    view_mode: viewMode,
    album_id: id,
    rating_min: ratingMin || undefined,
    color_label: colorLabel !== "none" ? colorLabel : undefined,
    date_from: dateFrom ? `${dateFrom}T00:00:00` : undefined,
    date_to: dateTo ? `${dateTo}T23:59:59` : undefined,
  };

  const { data: images, isLoading } = useQuery({
    queryKey: ["images", { ...filters, q }],
    // A search here stays scoped to this album (album_id is part of filters),
    // so it only ranks photos that are actually in the album.
    queryFn: async () => {
      if (q) return (await api.search.query(q, filters)).map((r) => r.image);
      return api.images.list(filters);
    },
    enabled: !!id,
  });

  const orderedImages =
    viewMode === "combined"
      ? groupPairsAdjacent(images ?? [], (img) => img.paired_image_id)
      : images ?? [];

  async function removeFromAlbum(imageId: string) {
    if (!id) return;
    await api.albums.removeImage(id, imageId);
    // Refresh both the album's photo list and its header count.
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["album", id] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  // Click = toggle; shift-click = select the whole range since the last click,
  // like the library grid - makes selecting a long run of photos fast.
  function toggleSelect(imageId: string, index: number, shiftKey: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastIndex !== null) {
        const [start, end] = lastIndex < index ? [lastIndex, index] : [index, lastIndex];
        for (let i = start; i <= end; i++) next.add(orderedImages[i].id);
      } else if (next.has(imageId)) {
        next.delete(imageId);
      } else {
        next.add(imageId);
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
    queryClient.invalidateQueries({ queryKey: ["album", id] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  async function removeSelectedFromAlbum() {
    if (!id || selected.size === 0) return;
    await Promise.all(Array.from(selected).map((imageId) => api.albums.removeImage(id, imageId)));
    clearSelection();
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["album", id] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  async function addTagToSelected(name: string) {
    if (selected.size === 0 || !name.trim()) return;
    await api.images.bulkAddTags(Array.from(selected), [name.trim()]);
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["tags"] });
  }

  async function addSelectedToAlbum(targetAlbumId: string) {
    if (selected.size === 0) return;
    await api.albums.addImages(targetAlbumId, Array.from(selected));
    queryClient.invalidateQueries({ queryKey: ["albums"] });
    queryClient.invalidateQueries({ queryKey: ["album", targetAlbumId] });
  }

  async function resetSelectedMetadata() {
    if (selected.size === 0) return;
    if (!window.confirm(`Reset stars, colors, and tags for ${selected.size} photo(s)?`)) return;
    await api.images.bulkReset(Array.from(selected));
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  return (
    <div className="page page-timeline">
      <h2 className="section-title">
        {album?.name ?? "Album"}
        {album && <span className="count-pill">{album.image_count} photos</span>}
      </h2>
      <PhotoFilters
        viewMode={viewMode}
        onViewMode={setViewMode}
        ratingMin={ratingMin}
        onRatingMin={setRatingMin}
        colorLabel={colorLabel}
        onColorLabel={setColorLabel}
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFrom={setDateFrom}
        onDateTo={setDateTo}
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
      {q && (
        <div className="search-scope-banner">
          <span>
            Results for <strong>"{q}"</strong> in this album
            {!isLoading && images ? ` (${images.length})` : ""}
          </span>
          <button
            className="btn ghost"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete("q");
              setSearchParams(next);
            }}
          >
            Clear search
          </button>
        </div>
      )}
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
          <button className="btn" onClick={removeSelectedFromAlbum}>
            Remove from this album
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
          groupByDate={!q}
          onRemove={removeFromAlbum}
          removeTitle="Remove from this album"
        />
      )}
    </div>
  );
}

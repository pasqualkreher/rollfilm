import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ColorLabel, LibraryFilters, ViewMode } from "../api/types";
import { ThumbnailGrid } from "../components/ThumbnailGrid";
import { PhotoFilters } from "../components/PhotoFilters";
import { groupPairsAdjacent } from "../utils/pairing";

export function AlbumDetail() {
  const { id } = useParams<{ id: string }>();
  const [viewMode, setViewMode] = useState<ViewMode>("combined");
  const [ratingMin, setRatingMin] = useState<number>(0);
  const [colorLabel, setColorLabel] = useState<ColorLabel>("none");
  const queryClient = useQueryClient();

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
  };

  const { data: images, isLoading } = useQuery({
    queryKey: ["images", filters],
    queryFn: () => api.images.list(filters),
    enabled: !!id,
  });

  async function removeFromAlbum(imageId: string) {
    if (!id) return;
    await api.albums.removeImage(id, imageId);
    // Refresh both the album's photo list and its header count.
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["album", id] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  const orderedImages =
    viewMode === "combined"
      ? groupPairsAdjacent(images ?? [], (img) => img.paired_image_id)
      : images ?? [];

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
      />
      {isLoading ? (
        <div className="empty-state">Loading...</div>
      ) : (
        <ThumbnailGrid
          images={orderedImages}
          groupByDate
          onRemove={removeFromAlbum}
          removeTitle="Remove from this album"
        />
      )}
    </div>
  );
}

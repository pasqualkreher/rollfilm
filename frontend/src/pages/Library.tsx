import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ColorLabel, ImageOut, LibraryFilters, ViewMode } from "../api/types";
import { ThumbnailGrid } from "../components/ThumbnailGrid";
import { RatingStars } from "../components/RatingStars";
import { ColorLabelPicker } from "../components/ColorLabelPicker";
import { AlbumPicker } from "../components/AlbumPicker";
import { BulkTagInput } from "../components/BulkTagInput";
import { PhotoFilters } from "../components/PhotoFilters";
import { useSelects } from "../state/selects";
import { useTasks } from "../state/tasks";
import { groupPairsAdjacent } from "../utils/pairing";
import { deleteConfirmMessage } from "../utils/deleteMessage";
import { collapsePairs, useMergePairs } from "../state/viewPrefs";

export function Library() {
  const [viewMode, setViewMode] = useState<ViewMode>("combined");
  const [ratingMin, setRatingMin] = useState<number>(0);
  const [colorLabel, setColorLabel] = useState<ColorLabel>("none");
  const [albumId, setAlbumId] = useState<string>("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState<string | null>(null);
  const [dateTo, setDateTo] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const selects = useSelects();
  const mergePairs = useMergePairs();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = (searchParams.get("q") ?? "").trim();

  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });
  const { data: allTags } = useQuery({ queryKey: ["tags"], queryFn: () => api.tags.list() });

  // "Add to Immich" only appears when the integration is configured in Settings.
  const { data: immich } = useQuery({ queryKey: ["immich-settings"], queryFn: () => api.settings.getImmich() });
  const immichConfigured = Boolean(immich?.base_url && immich?.api_key_set);
  const [immichBusy, setImmichBusy] = useState(false);
  const [immichMsg, setImmichMsg] = useState<string | null>(null);

  // Lock the nav + show the top-bar spinner while uploading to Immich, same as
  // the Settings maintenance tasks.
  const { setBusyLabel } = useTasks();
  useEffect(() => {
    setBusyLabel(immichBusy ? "Uploading to Immich…" : null);
  }, [immichBusy, setBusyLabel]);
  useEffect(() => () => setBusyLabel(null), [setBusyLabel]);

  const filters: LibraryFilters = {
    view_mode: viewMode,
    rating_min: ratingMin || undefined,
    color_label: colorLabel !== "none" ? colorLabel : undefined,
    album_id: albumId || undefined,
    tags: selectedTags.length ? selectedTags : undefined,
    // Capture-date range from the date pickers: include the whole "from" day
    // through the end of the "to" day.
    date_from: dateFrom ? `${dateFrom}T00:00:00` : undefined,
    date_to: dateTo ? `${dateTo}T23:59:59` : undefined,
  };

  // Load the library in pages and append as the user scrolls, so a large
  // library (thousands of shots) opens fast and never renders every thumbnail
  // at once, while still growing to the full set on demand. Merge/timeline all
  // operate on the accumulated list, so RAW+JPG pairs collapse correctly as
  // more pages arrive.
  const PAGE_SIZE = 200;
  const listQuery = useInfiniteQuery({
    queryKey: ["images", filters],
    enabled: !q,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.images.list(filters, { limit: PAGE_SIZE, offset: pageParam }),
    // Another page exists only when the last one came back full; a short page
    // means we've reached the end.
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === PAGE_SIZE ? pages.length * PAGE_SIZE : undefined,
  });

  // A search query switches to scoped search (same filters, ranked by
  // relevance) and returns the full ranked set in one go.
  const searchQuery = useQuery({
    // Key starts with "images" so the same invalidateQueries(["images"]) after
    // bulk edits/deletes refreshes search results too.
    queryKey: ["images", "search", { ...filters, q }],
    enabled: Boolean(q),
    queryFn: async () => (await api.search.query(q, filters)).map((r) => r.image),
  });

  const images = q ? searchQuery.data : listQuery.data?.pages.flat();
  const isLoading = q ? searchQuery.isLoading : listQuery.isLoading;

  // Bottom sentinel: fetch the next page whenever it scrolls into view.
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = listQuery;
  useEffect(() => {
    if (q) return;
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { rootMargin: "600px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [q, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // In combined view, either merge each RAW+JPEG pair into one JPEG card, or
  // just keep the two partners adjacent. Other view modes show a flat list.
  const orderedImages =
    viewMode === "combined"
      ? mergePairs
        ? collapsePairs(images ?? [])
        : groupPairsAdjacent(images ?? [], (img) => img.paired_image_id)
      : images ?? [];

  // Expand a set of ids with each one's RAW/JPEG partner, but only in merged
  // view where the partner is hidden behind the shown card. In the split view
  // the user can see and pick each half, so we leave their selection exact.
  function withPairedIds(ids: string[]): string[] {
    if (!mergePairs) return ids;
    const byId = new Map((images ?? []).map((im) => [im.id, im]));
    const out = new Set(ids);
    for (const id of ids) {
      const partner = byId.get(id)?.paired_image_id;
      if (partner) out.add(partner);
    }
    return Array.from(out);
  }

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
    // When pairs are merged the grid only shows the JPEG, so fan the change out
    // to each hidden RAW partner too.
    await api.images.bulkUpdate(Array.from(selected), { ...patch, apply_to_pair: mergePairs });
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    // In merged view only the JPEG is shown, so a delete must take the hidden
    // RAW partner with it - a RAW+JPEG pair is one shot.
    const ids = withPairedIds(Array.from(selected));
    const byId = new Map((images ?? []).map((im) => [im.id, im]));
    const items = ids.map((x) => byId.get(x)).filter((im): im is ImageOut => Boolean(im));
    if (!window.confirm(deleteConfirmMessage(items, ids.length - selected.size))) {
      return;
    }
    await api.images.bulkDelete(ids);
    clearSelection();
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["trash"] });
  }

  async function addTagToSelected(name: string) {
    if (selected.size === 0 || !name.trim()) return;
    await api.images.bulkAddTags(Array.from(selected), [name.trim()]);
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["tags"] });
  }

  async function addSelectedToAlbum(albumId: string) {
    if (selected.size === 0) return;
    // In merged view the RAW partner is hidden behind the JPEG card - add it
    // too, so the album holds the whole shot and its own merge toggle works.
    await api.albums.addImages(albumId, withPairedIds(Array.from(selected)));
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  async function resetSelectedMetadata() {
    if (selected.size === 0) return;
    if (!window.confirm(`Reset stars, colors, and tags for ${selected.size} photo(s)?`)) return;
    await api.images.bulkReset(Array.from(selected));
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  async function addSelectedToImmich() {
    if (selected.size === 0) return;
    setImmichBusy(true);
    setImmichMsg(null);
    try {
      const result = await api.images.pushToImmich(Array.from(selected));
      setImmichMsg(result.message);
    } catch (e) {
      setImmichMsg((e as Error).message);
    } finally {
      setImmichBusy(false);
    }
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
        allTags={allTags}
        selectedTags={selectedTags}
        onTags={setSelectedTags}
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
      <div className="page-scroll">
      {q && (
        <div className="search-scope-banner">
          <span>
            Results for <strong>"{q}"</strong> in this view
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
        // Related controls are grouped so a narrow window wraps whole groups
        // to the next line instead of splitting them mid-cluster; Delete
        // right-aligns on whatever line it ends up on (margin-left auto).
        <div className="filter-bar action-bar--bottom">
          <div className="control-group">
            <span>{selected.size} selected</span>
            <RatingStars rating={0} onChange={(r) => applyBulk({ rating: r })} />
            <ColorLabelPicker value="none" onChange={(c) => applyBulk({ color_label: c })} />
          </div>
          <div className="control-group">
            <BulkTagInput onAdd={addTagToSelected} />
            <AlbumPicker onAdd={addSelectedToAlbum} />
          </div>
          <div className="control-group">
            <button className="btn" onClick={() => selects.add(Array.from(selected))}>
              Add to selects
            </button>
            {immichConfigured && (
              <button
                className="btn"
                onClick={addSelectedToImmich}
                disabled={immichBusy}
                title="Upload the selected JPEGs to your configured Immich server (RAW files are skipped)"
              >
                {immichBusy ? "Uploading to Immich..." : "Add to Immich"}
              </button>
            )}
            <button className="btn" onClick={resetSelectedMetadata}>
              Reset stars/tags/colors
            </button>
          </div>
          <button
            className="btn quiet-danger btn-sm"
            style={{ marginLeft: "auto" }}
            onClick={deleteSelected}
            title="Delete the selected photos"
          >
            Delete
          </button>
          {immichMsg && <span style={{ color: "var(--text-muted)" }}>{immichMsg}</span>}
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
        />
      )}
      {!q && (
        <div ref={loadMoreRef} className="load-more-sentinel">
          {isFetchingNextPage ? "Loading more photos…" : ""}
        </div>
      )}
      </div>
    </div>
  );
}

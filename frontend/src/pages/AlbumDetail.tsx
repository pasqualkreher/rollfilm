import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BulkResetOptions, ColorLabel, ImageOut, LibraryFilters, ViewMode } from "../api/types";
import { ThumbnailGrid } from "../components/ThumbnailGrid";
import { RatingStars } from "../components/RatingStars";
import { ColorLabelPicker } from "../components/ColorLabelPicker";
import { AlbumPicker } from "../components/AlbumPicker";
import { BulkTagInput } from "../components/BulkTagInput";
import { ResetMenu } from "../components/ResetMenu";
import { PhotoFilters } from "../components/PhotoFilters";
import { loadPresets } from "../utils/presets";
import { useSelects } from "../state/selects";
import { useTasks } from "../state/tasks";
import { usePairDeleteConfirm } from "../components/usePairDeleteConfirm";
import { collapsePairs } from "../state/viewPrefs";
import { selectionSharedMeta } from "../utils/selectionMeta";

export function AlbumDetail() {
  const { id } = useParams<{ id: string }>();
  const [viewMode, setViewMode] = useState<ViewMode>("combined");
  const [ratingMin, setRatingMin] = useState<number>(0);
  const [colorLabel, setColorLabel] = useState<ColorLabel>("none");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState<string | null>(null);
  const [dateTo, setDateTo] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const selects = useSelects();
  // The album always collapses each RAW+JPEG pair to one card (see
  // orderedImages), so in the combined view the pair-aware bulk/remove helpers
  // below must treat the shown JPEG as standing for its hidden RAW partner.
  const mergePairs = viewMode === "combined";
  const { dialog: pairDeleteDialog, confirmDelete } = usePairDeleteConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = (searchParams.get("q") ?? "").trim();

  const { data: album } = useQuery({
    queryKey: ["album", id],
    queryFn: () => api.albums.get(id!),
    enabled: !!id,
  });

  const { data: allTags } = useQuery({ queryKey: ["tags"], queryFn: () => api.tags.list() });

  // "Add to Immich" only appears when the integration is configured in Settings.
  const { data: immich } = useQuery({ queryKey: ["immich-settings"], queryFn: () => api.settings.getImmich() });
  const immichConfigured = Boolean(immich?.base_url && immich?.api_key_set);
  const [immichBusy, setImmichBusy] = useState(false);
  const [immichMsg, setImmichMsg] = useState<string | null>(null);
  const [developBusy, setDevelopBusy] = useState(false);
  const [developMsg, setDevelopMsg] = useState<string | null>(null);
  // Auto-dismiss the develop status after a moment, like the other flash messages.
  useEffect(() => {
    if (!developMsg) return;
    const t = window.setTimeout(() => setDevelopMsg(null), 4000);
    return () => window.clearTimeout(t);
  }, [developMsg]);
  const presetNames = Object.keys(loadPresets());

  // Lock the nav + show the top-bar spinner while uploading to Immich, same as
  // the Settings maintenance tasks.
  const { setBusyLabel } = useTasks();
  useEffect(() => {
    setBusyLabel(immichBusy ? "Uploading to Immich…" : null);
  }, [immichBusy, setBusyLabel]);
  useEffect(() => () => setBusyLabel(null), [setBusyLabel]);

  const filters: LibraryFilters = {
    view_mode: viewMode,
    album_id: id,
    rating_min: ratingMin || undefined,
    color_label: colorLabel !== "none" ? colorLabel : undefined,
    tags: selectedTags.length ? selectedTags : undefined,
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

  // Default view shows one card per shot: the JPEG of each RAW+JPEG pair, and a
  // lone RAW only when it has no JPEG sibling. The JPEG/RAW view-mode buttons
  // still give a flat, type-filtered list when the user wants just one kind.
  const orderedImages = viewMode === "combined" ? collapsePairs(images ?? []) : images ?? [];

  const sharedMeta = selectionSharedMeta(images ?? [], selected);

  // Expand a set of ids with each one's RAW/JPEG partner, but only in merged
  // view where the partner is hidden behind the shown card (the split view lets
  // the user pick each half, so we keep their selection exact there).
  function withPairedIds(ids: string[]): string[] {
    if (!mergePairs) return ids;
    const byId = new Map((images ?? []).map((im) => [im.id, im]));
    const out = new Set(ids);
    for (const imgId of ids) {
      const partner = byId.get(imgId)?.paired_image_id;
      if (partner) out.add(partner);
    }
    return Array.from(out);
  }

  async function removeFromAlbum(imageId: string) {
    if (!id) return;
    // In merged view the card stands for the whole RAW+JPEG shot - remove the
    // hidden partner too, or it would linger in the album as an orphan.
    await Promise.all(withPairedIds([imageId]).map((x) => api.albums.removeImage(id, x)));
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
    // With merged pairs only the JPEG is visible, so mirror the change to each
    // hidden RAW partner too.
    await api.images.bulkUpdate(Array.from(selected), { ...patch, apply_to_pair: mergePairs });
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    // Merged view hides the RAW behind its JPEG, so both halves of the shot go
    // together by default. The "ask what to delete" setting lets the user keep
    // the partners.
    const baseIds = Array.from(selected);
    const partnerIds = withPairedIds(baseIds).filter((x) => !selected.has(x));
    const byId = new Map((images ?? []).map((im) => [im.id, im]));
    const toItems = (list: string[]) =>
      list.map((x) => byId.get(x)).filter((im): im is ImageOut => Boolean(im));
    const ids = await confirmDelete({
      baseIds,
      baseItems: toItems(baseIds),
      partnerIds,
      partnerItems: toItems(partnerIds),
    });
    if (!ids) return;
    await api.images.bulkDelete(ids);
    clearSelection();
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["album", id] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
    queryClient.invalidateQueries({ queryKey: ["trash"] });
  }

  async function removeSelectedFromAlbum() {
    if (!id || selected.size === 0) return;
    // Merged view hides the RAW behind its JPEG - remove both halves.
    const ids = withPairedIds(Array.from(selected));
    await Promise.all(ids.map((imageId) => api.albums.removeImage(id, imageId)));
    clearSelection();
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["album", id] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  async function addTagToSelected(name: string) {
    if (selected.size === 0 || !name.trim()) return;
    const tag = name.trim();
    await api.images.bulkAddTags(Array.from(selected), [tag]);
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["tags"] });
    setDevelopMsg(`Added tag “${tag}” to ${selected.size} photo(s).`);
  }

  async function addSelectedToAlbum(targetAlbumId: string) {
    if (selected.size === 0) return;
    // In merged view the RAW partner is hidden behind the JPEG card - add it
    // too, so the target album holds the whole shot.
    await api.albums.addImages(targetAlbumId, withPairedIds(Array.from(selected)));
    queryClient.invalidateQueries({ queryKey: ["albums"] });
    queryClient.invalidateQueries({ queryKey: ["album", targetAlbumId] });
  }

  async function resetSelected(opts: BulkResetOptions) {
    if (selected.size === 0) return;
    await api.images.bulkReset(Array.from(selected), opts);
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["tags"] });
    queryClient.invalidateQueries({ queryKey: ["album", id] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  async function autoDevelopSelected() {
    if (selected.size === 0) return;
    const editedCount = (images ?? []).filter((im) => selected.has(im.id) && im.edit_rev).length;
    if (
      editedCount > 0 &&
      !window.confirm(
        `Auto-develop ${selected.size} photo(s)? This overwrites the develop settings of ${editedCount} already-edited photo(s).`
      )
    )
      return;
    setDevelopBusy(true);
    setDevelopMsg(null);
    try {
      const result = await api.images.bulkAutoDevelop(Array.from(selected));
      setDevelopMsg(
        result.skipped > 0
          ? `Auto-developed ${result.applied} photo(s); skipped ${result.skipped} (no similar edits to learn from yet).`
          : `Auto-developed ${result.applied} photo(s).`
      );
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["album", id] });
    } catch (e) {
      setDevelopMsg((e as Error).message);
    } finally {
      setDevelopBusy(false);
    }
  }

  async function applyPresetToSelected(name: string) {
    const preset = loadPresets()[name];
    if (selected.size === 0 || !preset) return;
    const editedCount = (images ?? []).filter((im) => selected.has(im.id) && im.edit_rev).length;
    if (
      editedCount > 0 &&
      !window.confirm(
        `Apply preset “${name}” to ${selected.size} photo(s)? This overwrites the develop settings of ${editedCount} already-edited photo(s).`
      )
    )
      return;
    setDevelopBusy(true);
    setDevelopMsg(null);
    try {
      await api.images.bulkDevelop(Array.from(selected), preset.adjustments as Record<string, unknown>);
      setDevelopMsg(`Applied preset “${name}” to ${selected.size} photo(s).`);
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["album", id] });
    } catch (e) {
      setDevelopMsg((e as Error).message);
    } finally {
      setDevelopBusy(false);
    }
  }

  async function toggleAlbumImmichSync(enabled: boolean) {
    await api.albums.setImmichSync(id!, enabled);
    queryClient.invalidateQueries({ queryKey: ["album", id] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
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
      {pairDeleteDialog}
      <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {album?.name ?? "Album"}
        {album && <span className="count-pill">{album.image_count} photos</span>}
        {album && immichConfigured && immich?.sync_mode === "selective" && (
          <label
            className="filter-field filter-field-inline"
            style={{ fontSize: 13, fontWeight: 400 }}
            title="Mirror this album to Immich and upload its JPEGs"
          >
            <input
              type="checkbox"
              checked={album.immich_sync}
              onChange={(e) => toggleAlbumImmichSync(e.target.checked)}
            />{" "}
            Sync to Immich
          </label>
        )}
        <span style={{ flex: 1 }} />
        {album && (
          <button
            className="btn quiet-danger btn-sm"
            title="Delete this album - its photos stay in the library"
            onClick={async () => {
              if (
                !window.confirm(
                  `Delete album “${album.name}”? Its ${album.image_count} photo(s) stay in your library.`
                )
              ) {
                return;
              }
              await api.albums.remove(album.id);
              queryClient.invalidateQueries({ queryKey: ["albums"] });
              navigate("/albums");
            }}
          >
            Delete album
          </button>
        )}
      </h2>
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
        // Same grouped layout as the Library bar: groups wrap as units and
        // Delete right-aligns on whatever line it ends up on.
        <div className="filter-bar action-bar--bottom">
          <div className="control-group">
            <span>{selected.size} selected</span>
            <RatingStars rating={sharedMeta.rating} onChange={(r) => applyBulk({ rating: r })} />
            <ColorLabelPicker value={sharedMeta.colorLabel} onChange={(c) => applyBulk({ color_label: c })} />
          </div>
          <div className="control-group">
            <BulkTagInput onAdd={addTagToSelected} />
            <AlbumPicker onAdd={addSelectedToAlbum} />
          </div>
          <div className="control-group">
            <button className="btn" onClick={() => selects.add(Array.from(selected))}>
              Add to selects
            </button>
            {/* Hidden in full sync mode - everything uploads automatically there. */}
            {immichConfigured && immich?.sync_mode !== "full" && (
              <button
                className="btn"
                onClick={addSelectedToImmich}
                disabled={immichBusy}
                title="Upload the selected JPEGs to your configured Immich server (RAW files are skipped)"
              >
                {immichBusy ? "Uploading to Immich..." : "Add to Immich"}
              </button>
            )}
          </div>
          <div className="control-group">
            <button
              className="btn"
              onClick={autoDevelopSelected}
              disabled={developBusy}
              title="Develop each selected photo automatically, learned from your own saved edits"
            >
              {developBusy ? "Working…" : "Auto develop"}
            </button>
            {presetNames.length > 0 && (
              <select
                className="preset-select"
                value=""
                disabled={developBusy}
                onChange={(e) => {
                  if (e.target.value) applyPresetToSelected(e.target.value);
                }}
                title="Apply a saved editor preset to the whole selection"
              >
                <option value="">Apply preset…</option>
                {presetNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <ResetMenu count={selected.size} onReset={resetSelected} />
            <button className="btn" onClick={removeSelectedFromAlbum}>
              Remove from this album
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
          {(immichMsg || developMsg) && (
            <div className="action-bar-messages">
              {immichMsg && <span>{immichMsg}</span>}
              {developMsg && <span>{developMsg}</span>}
            </div>
          )}
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
    </div>
  );
}

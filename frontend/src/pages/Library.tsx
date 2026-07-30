import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAppDialogs } from "../components/AppDialogs";
import type {
  BulkResetOptions,
  ColorLabel,
  ImageOut,
  LibraryFilters,
  LibraryIndexImage,
  ViewMode,
} from "../api/types";
import { ThumbnailGrid } from "../components/ThumbnailGrid";
import { VirtualTimeline } from "../components/VirtualTimeline";
import { RatingStars } from "../components/RatingStars";
import { ColorLabelPicker } from "../components/ColorLabelPicker";
import { AlbumPicker } from "../components/AlbumPicker";
import { BulkTagInput } from "../components/BulkTagInput";
import { ResetMenu } from "../components/ResetMenu";
import { PhotoFilters } from "../components/PhotoFilters";
import { loadPresets } from "../utils/presets";
import { useSelects } from "../state/selects";
import { useTasks } from "../state/tasks";
import { useWait } from "../state/wait";
import { collapsePairsBy, groupPairsAdjacent } from "../utils/pairing";
import { usePairDeleteConfirm } from "../components/usePairDeleteConfirm";
import { useMergePairs } from "../state/viewPrefs";
import { selectionSharedMeta } from "../utils/selectionMeta";
import { useTransientMessage, useTransientValue } from "../utils/transientMessage";

// Browse mode works on slim index entries (the whole library in one query),
// search mode on full rows - the shared selection/bulk handlers only touch
// the fields both carry.
type GridImage = LibraryIndexImage | ImageOut;

export function Library() {
  const [viewMode, setViewMode] = useState<ViewMode>("combined");
  const [ratingMin, setRatingMin] = useState<number>(0);
  const [colorLabel, setColorLabel] = useState<ColorLabel>("none");
  const [albumId, setAlbumId] = useState<string>("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [camera, setCamera] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string | null>(null);
  const [dateTo, setDateTo] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const { withWait } = useWait();
  const selects = useSelects();
  const mergePairs = useMergePairs();
  const { dialog: pairDeleteDialog, confirmDelete } = usePairDeleteConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = (searchParams.get("q") ?? "").trim();

  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });
  const { data: allTags } = useQuery({ queryKey: ["tags"], queryFn: () => api.tags.list() });
  // Camera + region dropdown options, refreshed with the library so new imports
  // (and their reverse-geocoded regions) show up.
  const { data: facets } = useQuery({ queryKey: ["facets"], queryFn: () => api.images.facets() });

  // "Add to Immich" only appears when the integration is configured in Settings.
  const { data: immich } = useQuery({ queryKey: ["immich-settings"], queryFn: () => api.settings.getImmich() });
  const immichConfigured = Boolean(immich?.base_url && immich?.api_key_set && immich.enabled);
  const [immichBusy, setImmichBusy] = useState(false);
  // Both flash messages auto-dismiss after a moment.
  const [immichMsg, setImmichMsg] = useTransientMessage();
  const [developBusy, setDevelopBusy] = useState(false);
  const [developMsg, setDevelopMsg] = useTransientMessage();
  // Adding to an album is otherwise invisible (the dropdown just snaps back to
  // its placeholder), so confirm it in the action bar's message row - same place
  // the tag note appears. Carries its own error flag since a failed add must not
  // read like a success.
  const [albumMsg, setAlbumMsg] = useTransientValue<{ text: string; error: boolean }>();
  // Read once per render so the preset dropdown reflects saves made in the editor.
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
    rating_min: ratingMin || undefined,
    color_label: colorLabel !== "none" ? colorLabel : undefined,
    album_id: albumId || undefined,
    tags: selectedTags.length ? selectedTags : undefined,
    camera_model: camera || undefined,
    // Capture-date range from the date pickers: include the whole "from" day
    // through the end of the "to" day.
    date_from: dateFrom ? `${dateFrom}T00:00:00` : undefined,
    date_to: dateTo ? `${dateTo}T23:59:59` : undefined,
  };

  // Browse mode loads the library INDEX: one slim row per photo (id, aspect
  // ratio, date, badges) for the whole filtered library. The virtual grid
  // computes every tile's position from it up front - exact scrollbar, jump
  // anywhere - and only ever fetches the thumbnails near the viewport. Key
  // starts with "images" so invalidateQueries(["images"]) after imports/
  // edits/deletes refreshes it too.
  const indexQuery = useQuery({
    queryKey: ["images", "index", filters],
    enabled: !q,
    queryFn: () => api.images.index(filters),
    // Refetches (after edits/imports, or filter changes) keep showing the
    // previous grid until the new index arrives, instead of blanking to a
    // "Loading..." screen - on a busy backend that request can take seconds.
    placeholderData: (prev) => prev,
    staleTime: 15_000,
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

  const images: GridImage[] | undefined = q ? searchQuery.data : indexQuery.data?.images;
  const isLoading = q ? searchQuery.isLoading : indexQuery.isLoading;

  // In combined view, either merge each RAW+JPEG pair into one JPEG card, or
  // just keep the two partners adjacent. Other view modes show a flat list.
  const orderedImages: GridImage[] =
    viewMode === "combined"
      ? mergePairs
        ? collapsePairsBy(images ?? [], (img) => img.file_type, (img) => img.paired_image_id)
        : groupPairsAdjacent(images ?? [], (img) => img.file_type, (img) => img.paired_image_id)
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
    await withWait(`Updating ${selected.size} photo${selected.size === 1 ? "" : "s"}…`, () =>
      api.images.bulkUpdate(Array.from(selected), { ...patch, apply_to_pair: mergePairs })
    );
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    // In merged view only the JPEG is shown, so a delete takes the hidden RAW
    // partner with it by default - a pair is one shot. The "ask what to delete"
    // setting lets the user keep the partners.
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
    await withWait(`Moving ${ids.length} photo${ids.length === 1 ? "" : "s"} to trash…`, () =>
      api.images.bulkDelete(ids)
    );
    clearSelection();
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["trash"] });
  }

  async function addTagToSelected(name: string) {
    if (selected.size === 0 || !name.trim()) return;
    const tag = name.trim();
    await withWait(`Tagging ${selected.size} photo${selected.size === 1 ? "" : "s"}…`, () =>
      api.images.bulkAddTags(Array.from(selected), [tag])
    );
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["tags"] });
    setDevelopMsg(`Added tag “${tag}” to ${selected.size} photo(s).`);
  }

  async function addSelectedToAlbum(albumId: string) {
    if (selected.size === 0) return;
    // In merged view the RAW partner is hidden behind the JPEG card - add it
    // too, so the album holds the whole shot and its own merge toggle works.
    await withWait(`Adding ${selected.size} photo${selected.size === 1 ? "" : "s"} to album…`, () =>
      api.albums.addImages(albumId, withPairedIds(Array.from(selected)))
    );
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  // Counts the selection, not the ids actually sent: merged view silently adds
  // each shot's RAW partner too, and reporting that larger number would look
  // like a bug to someone who selected 3 photos. Mirrors the tag note's phrasing.
  function reportAlbumAdd({ name, ok }: { name: string; ok: boolean }) {
    setAlbumMsg(
      ok
        ? { text: `Added ${selected.size} photo(s) to “${name}”.`, error: false }
        : { text: `Could not add to “${name}”.`, error: true }
    );
  }

  async function resetSelected(opts: BulkResetOptions) {
    if (selected.size === 0) return;
    await api.images.bulkReset(Array.from(selected), opts);
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["tags"] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  // Auto-develop every selected photo (each learns its own suggestion). Photos
  // with no embedding yet, or nothing similar to learn from, are skipped.
  async function autoDevelopSelected() {
    if (selected.size === 0) return;
    const editedCount = (images ?? []).filter(
      (im) => selected.has(im.id) && (im as ImageOut).edit_rev
    ).length;
    if (
      editedCount > 0 &&
      !(await dialogs.confirm({
        title: `Auto-develop ${selected.size} photo(s)?`,
        message: `This overwrites the develop settings of ${editedCount} already-edited photo(s).`,
        confirmLabel: "Auto-develop",
      }))
    )
      return;
    setDevelopBusy(true);
    setDevelopMsg(null);
    try {
      const result = await withWait(
        `Auto-developing ${selected.size} photo${selected.size === 1 ? "" : "s"}…`,
        () => api.images.bulkAutoDevelop(Array.from(selected))
      );
      setDevelopMsg(
        result.skipped > 0
          ? `Auto-developed ${result.applied} photo(s); skipped ${result.skipped} (no similar edits to learn from yet).`
          : `Auto-developed ${result.applied} photo(s).`
      );
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["tags"] });
    } catch (e) {
      setDevelopMsg((e as Error).message);
    } finally {
      setDevelopBusy(false);
    }
  }

  // Apply a saved editor preset (a full develop look) to the whole selection.
  async function applyPresetToSelected(name: string) {
    const preset = loadPresets()[name];
    if (selected.size === 0 || !preset) return;
    const editedCount = (images ?? []).filter(
      (im) => selected.has(im.id) && (im as ImageOut).edit_rev
    ).length;
    if (
      editedCount > 0 &&
      !(await dialogs.confirm({
        title: `Apply preset “${name}” to ${selected.size} photo(s)?`,
        message: `This overwrites the develop settings of ${editedCount} already-edited photo(s).`,
        confirmLabel: "Apply preset",
      }))
    )
      return;
    setDevelopBusy(true);
    setDevelopMsg(null);
    try {
      await withWait(`Applying preset to ${selected.size} photo${selected.size === 1 ? "" : "s"}…`, () =>
        api.images.bulkDevelop(Array.from(selected), preset.adjustments as Record<string, unknown>)
      );
      setDevelopMsg(`Applied preset “${name}” to ${selected.size} photo(s).`);
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["tags"] });
    } catch (e) {
      setDevelopMsg((e as Error).message);
    } finally {
      setDevelopBusy(false);
    }
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

  // Selective sync: the checkbox flags/unflags the whole selection - flagged
  // photos upload in the background and stay marked as synced; unflagging
  // stops syncing them but leaves what's already on Immich alone.
  async function toggleSelectedImmichSync(enabled: boolean) {
    if (selected.size === 0) return;
    setImmichBusy(true);
    setImmichMsg(null);
    try {
      const updated = await api.images.setImmichSync(Array.from(selected), enabled);
      setImmichMsg(
        enabled
          ? `Flagged ${updated.length} photo(s) for Immich sync — uploading in the background.`
          : `Stopped syncing ${updated.length} photo(s) to Immich.`
      );
      queryClient.invalidateQueries({ queryKey: ["images"] });
    } catch (e) {
      setImmichMsg((e as Error).message);
    } finally {
      setImmichBusy(false);
    }
  }

  // Checked when every selected photo is flagged - so ticking it flags the
  // rest, and unticking always unflags everything selected.
  const allSelectedSynced =
    selected.size > 0 && (images ?? []).filter((im) => selected.has(im.id)).every((im) => im.immich_sync);

  const sharedMeta = selectionSharedMeta(images ?? [], selected);

  return (
    <div className="page page-timeline">
      {pairDeleteDialog}
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
        cameras={facets?.cameras}
        camera={camera}
        onCamera={setCamera}
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
            <RatingStars rating={sharedMeta.rating} onChange={(r) => applyBulk({ rating: r })} />
            <ColorLabelPicker value={sharedMeta.colorLabel} onChange={(c) => applyBulk({ color_label: c })} />
          </div>
          <div className="control-group">
            <BulkTagInput onAdd={addTagToSelected} />
            <AlbumPicker onAdd={addSelectedToAlbum} onResult={reportAlbumAdd} />
          </div>
          {immichConfigured && (immich?.sync_mode === "selective" || immich?.sync_mode === "manual") && (
            <div className="control-group">
              {immich?.sync_mode === "selective" && (
                <label
                  className="filter-field filter-field-inline"
                  title="Sync the selected photos to Immich — JPEGs upload in the background (RAW files are skipped). Untick to stop syncing them."
                >
                  <input
                    type="checkbox"
                    checked={allSelectedSynced}
                    disabled={immichBusy}
                    onChange={(e) => toggleSelectedImmichSync(e.target.checked)}
                  />{" "}
                  Sync to Immich
                </label>
              )}
              {/* Manual mode only: selective shows the sync checkbox instead, and
                  in full mode everything uploads automatically anyway. */}
              {immich?.sync_mode === "manual" && (
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
          )}
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
            <button
              className="btn"
              onClick={() => {
                const count = selected.size;
                selects.add(Array.from(selected));
                setDevelopMsg(`Added ${count} photo(s) to selects.`);
              }}
            >
              Add to selects
            </button>
            <ResetMenu count={selected.size} onReset={resetSelected} />
          </div>
          <button
            className="btn quiet-danger btn-sm"
            style={{ marginLeft: "auto" }}
            onClick={deleteSelected}
            title="Delete the selected photos"
          >
            Delete
          </button>
          {(immichMsg || developMsg || albumMsg) && (
            <div className="action-bar-messages">
              {immichMsg && <span>{immichMsg}</span>}
              {developMsg && <span>{developMsg}</span>}
              {albumMsg && (
                <span className={albumMsg.error ? "action-bar-message--error" : undefined}>
                  {albumMsg.text}
                </span>
              )}
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
      ) : q ? (
        <ThumbnailGrid
          images={orderedImages as ImageOut[]}
          selectedIds={selected}
          onToggleSelect={toggleSelect}
          selectMode={selectMode}
          groupByDate={false}
        />
      ) : (
        <VirtualTimeline
          images={orderedImages as LibraryIndexImage[]}
          selectedIds={selected}
          onToggleSelect={toggleSelect}
          selectMode={selectMode}
          // Changing a FILTER jumps to the top of the (new) result set - the
          // old scroll position pointed into a different library and landed
          // somewhere arbitrary. view_mode is deliberately not part of the key:
          // switching combined/RAW/JPEG shows the same photos and keeps its
          // position via the timeline's re-anchoring.
          resetKey={JSON.stringify([
            ratingMin,
            colorLabel,
            albumId,
            selectedTags,
            camera,
            dateFrom,
            dateTo,
          ])}
        />
      )}
      </div>
    </div>
  );
}

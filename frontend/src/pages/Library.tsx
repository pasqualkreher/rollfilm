import { useEffect, useMemo, useRef, useState } from "react";
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
import { AddToPicker } from "../components/AddToPicker";
import { BulkTagInput } from "../components/BulkTagInput";
import { ResetMenu } from "../components/ResetMenu";
import { IconTrash } from "../components/Icons";
import { PhotoFilters } from "../components/PhotoFilters";
import { Dropdown } from "../components/Dropdown";
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
  const [searchParams, setSearchParams] = useSearchParams();

  // The filter set lives in the URL, not in component state. Opening a photo
  // navigates to /image/:id, which unmounts this page - anything held in
  // useState was gone by the time the user came back, so returning from the
  // lightbox dropped them into the UNFILTERED library. In the query string the
  // browser's own back navigation restores the exact filter set (and a
  // filtered view can be reloaded or linked). `q` already worked this way.
  //
  // Setters can fire several times in one handler (PhotoFilters' "Clear
  // filters" resets every field in a row), and each must build on what the
  // previous one wrote - the render's searchParams hasn't caught up yet - so
  // the pending params are tracked in a ref.
  const paramsRef = useRef(searchParams);
  paramsRef.current = searchParams;
  function setParams(patch: Record<string, string | string[] | null>) {
    const next = new URLSearchParams(paramsRef.current);
    for (const [key, value] of Object.entries(patch)) {
      next.delete(key);
      if (Array.isArray(value)) value.forEach((v) => v && next.append(key, v));
      else if (value) next.set(key, value);
    }
    paramsRef.current = next;
    // Replace, not push: refining a filter is not a new place to go back to.
    // Pushing would make the back arrow step through every filter tweak
    // instead of leaving the lightbox and landing on the grid.
    setSearchParams(next, { replace: true });
  }

  const viewMode = (searchParams.get("view") as ViewMode | null) ?? "combined";
  const setViewMode = (v: ViewMode) => setParams({ view: v === "combined" ? null : v });
  const ratingMin = Number(searchParams.get("rating")) || 0;
  const setRatingMin = (v: number) => setParams({ rating: v ? String(v) : null });
  const colorLabel = (searchParams.get("color") as ColorLabel | null) ?? "none";
  const setColorLabel = (v: ColorLabel) => setParams({ color: v === "none" ? null : v });
  const albumId = searchParams.get("album") ?? "";
  const setAlbumId = (v: string) => setParams({ album: v || null });
  const selectedTags = searchParams.getAll("tag");
  const setSelectedTags = (v: string[]) => setParams({ tag: v });
  const camera = searchParams.get("camera") ?? "";
  const setCamera = (v: string) => setParams({ camera: v || null });
  const lens = searchParams.get("lens") ?? "";
  const setLens = (v: string) => setParams({ lens: v || null });
  const focalMin = searchParams.get("focal_min") ?? "";
  const focalMax = searchParams.get("focal_max") ?? "";
  const setFocalRange = (min: string, max: string) =>
    setParams({ focal_min: min || null, focal_max: max || null });
  const dateFrom = searchParams.get("from");
  const setDateFrom = (v: string | null) => setParams({ from: v });
  const dateTo = searchParams.get("to");
  const setDateTo = (v: string | null) => setParams({ to: v });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const { withWait } = useWait();
  const selects = useSelects();
  const mergePairs = useMergePairs();
  const { dialog: pairDeleteDialog, confirmDelete } = usePairDeleteConfirm();
  const q = (searchParams.get("q") ?? "").trim();

  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });
  const { data: allTags } = useQuery({ queryKey: ["tags"], queryFn: () => api.tags.list() });

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
  // Read once per MOUNT rather than per render: this parses localStorage, and
  // the editor lives on its own route (/image/:id), so returning from it
  // remounts this page anyway - the dropdown still picks up presets saved
  // there, without paying for the parse on every unrelated re-render.
  const presetNames = useMemo(() => Object.keys(loadPresets()), []);

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
    lens_model: lens || undefined,
    focal_min: focalMin || undefined,
    focal_max: focalMax || undefined,
    // Capture-date range from the date pickers: include the whole "from" day
    // through the end of the "to" day.
    date_from: dateFrom ? `${dateFrom}T00:00:00` : undefined,
    date_to: dateTo ? `${dateTo}T23:59:59` : undefined,
  };

  // Camera/lens/focal/region dropdown options, cross-filtered against the
  // active filter set (each facet reflects what the other filters leave over)
  // and refreshed with the library so new imports show up. Key starts with
  // "facets" so invalidateQueries(["facets"]) still catches every variant.
  const { data: facets } = useQuery({
    queryKey: ["facets", filters],
    queryFn: () => api.images.facets(filters),
    // Keep the previous options while the cross-filtered refetch runs so the
    // open filter menu doesn't blank/jump.
    placeholderData: (prev) => prev,
  });

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
    // The index is the WHOLE filtered library in one response - on a big one
    // that is megabytes of JSON to build server-side and to parse (blocking) in
    // the renderer. At 15s that bill was paid again on virtually every return
    // from the lightbox and on every window-focus regain, for data that had not
    // changed: every mutation path already invalidates ["images"] explicitly.
    //
    // Deliberately NOT Infinity, though. Server-side background work can change
    // the library with no client-side signal at all - the startup maintenance
    // sync reconciles the DB against the library folder (see main.on_startup) -
    // and stale-forever would leave the grid wrong until a filter change or a
    // restart. A few minutes keeps that self-healing while removing the
    // per-navigation refetch.
    staleTime: 5 * 60_000,
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
  //
  // Memoised, and that is load-bearing rather than a micro-optimisation: this
  // array is what the virtual timeline lays out, and its IDENTITY is the
  // layout's memo key (see VirtualTimeline). Built inline it was a fresh array
  // on every render of this page - a selection click, a flash message, a facets
  // refetch - so buildJustifiedLayout re-ran over the WHOLE library each time,
  // which is a long frame on a big one. Now it only rebuilds when the photos or
  // the pairing mode actually change.
  const orderedImages: GridImage[] = useMemo(
    () =>
      viewMode === "combined"
        ? mergePairs
          ? collapsePairsBy(images ?? [], (img) => img.file_type, (img) => img.paired_image_id)
          : groupPairsAdjacent(images ?? [], (img) => img.file_type, (img) => img.paired_image_id)
        : images ?? [],
    [images, viewMode, mergePairs]
  );

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

  async function addSelectedToCanvas(canvasId: string) {
    if (selected.size === 0) return;
    // Same pair rule as albums: in merged view the RAW partner rides along,
    // so the canvas's filmstrip holds the whole shot.
    await api.canvases.addImages(canvasId, withPairedIds(Array.from(selected)));
    queryClient.invalidateQueries({ queryKey: ["canvas-list"] });
    queryClient.invalidateQueries({ queryKey: ["canvas-images", canvasId] });
  }

  function reportAddTo({ kind, name, ok }: { kind: "album" | "canvas"; name: string; ok: boolean }) {
    const what = kind === "canvas" ? `canvas “${name}”` : `“${name}”`;
    setAlbumMsg(
      ok
        ? { text: `Added ${selected.size} photo(s) to ${what}.`, error: false }
        : { text: `Could not add to ${what}.`, error: true }
    );
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

  // Scans the whole library to find what the selection has in common, so it is
  // memoised on the two things it actually reads - not re-run for every
  // unrelated render of this page.
  const sharedMeta = useMemo(() => selectionSharedMeta(images ?? [], selected), [images, selected]);

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
        lenses={facets?.lenses}
        lens={lens}
        onLens={setLens}
        focalLengths={facets?.focal_lengths}
        focalMin={focalMin}
        focalMax={focalMax}
        onFocalRange={setFocalRange}
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
            onClick={() => setParams({ q: null })}
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
            <AddToPicker
              onAddToAlbum={addSelectedToAlbum}
              onAddToCanvas={addSelectedToCanvas}
              onResult={reportAddTo}
            />
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
              <Dropdown
                value=""
                placeholder="Apply preset…"
                disabled={developBusy}
                title="Apply a saved editor preset to the whole selection"
                ariaLabel="Apply preset"
                onChange={(v) => {
                  if (v) applyPresetToSelected(v);
                }}
                options={presetNames.map((name) => ({ value: name, label: name }))}
              />
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
            className="btn btn-sm quiet-danger"
            style={{ marginLeft: "auto" }}
            onClick={deleteSelected}
            title="Delete the selected photos"
            aria-label="Delete the selected photos"
          >
            <IconTrash size={15} />
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
            lens,
            focalMin,
            focalMax,
            dateFrom,
            dateTo,
          ])}
        />
      )}
      </div>
    </div>
  );
}

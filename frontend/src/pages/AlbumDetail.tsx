import { useEffect, useState, useRef } from "react";
import { useSessionState } from "../utils/useSessionState";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { CANCELLED_NOTE, pairUnits } from "../utils/batchUnits";
import { withoutMembershipNames } from "../utils/autoTags";
import { useAppDialogs } from "../components/AppDialogs";
import type { BulkResetOptions, ColorLabel, ImageOut, LibraryFilters, ViewMode } from "../api/types";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ThumbnailGrid } from "../components/ThumbnailGrid";
import { RatingStars } from "../components/RatingStars";
import { ColorLabelPicker } from "../components/ColorLabelPicker";
import { AddToPicker, type AddToResult } from "../components/AddToPicker";
import { AlbumNameField } from "../components/AlbumNameField";
import { BulkTagInput } from "../components/BulkTagInput";
import { ResetMenu } from "../components/ResetMenu";
import { EditPicker } from "../components/EditPicker";
import { IconCloudUp, IconRename, IconTrash } from "../components/Icons";
import { ImmichSyncToggle } from "../components/ImmichSyncToggle";
import { PhotoFilters } from "../components/PhotoFilters";
import { loadPresets, presetAdjustments } from "../utils/presets";
import { useSelects } from "../state/selects";
import { useTasks } from "../state/tasks";
import { useWait } from "../state/wait";
import { usePairDeleteConfirm } from "../components/usePairDeleteConfirm";
import { collapsePairs } from "../state/viewPrefs";
import { modKeyLabel, useSelectionKeys } from "../utils/selection";
import { selectionSharedMeta } from "../utils/selectionMeta";
import { useTransientMessage, useTransientValue } from "../utils/transientMessage";
import { Presence } from "../components/Presence";
import { MOTION } from "../utils/usePresence";
import { LoadingState } from "../components/Spinner";
import { ActionBarMessages } from "../components/ActionBarMessages";
import { errorText } from "../utils/apiError";
import { isModalOpen } from "../utils/modalKeys";

export function AlbumDetail() {
  const { id } = useParams<{ id: string }>();
  // The filters outlive the page for the session (per album): opening a photo
  // unmounts this grid, and coming back used to find every filter reset.
  const [viewMode, setViewMode] = useSessionState<ViewMode>(`album:${id}:viewMode`, "combined");
  const [ratingMin, setRatingMin] = useSessionState<number>(`album:${id}:ratingMin`, 0);
  const [colorLabel, setColorLabel] = useSessionState<ColorLabel>(`album:${id}:colorLabel`, "none");
  const [selectedTags, setSelectedTags] = useSessionState<string[]>(`album:${id}:selectedTags`, []);
  const [dateFrom, setDateFrom] = useSessionState<string | null>(`album:${id}:dateFrom`, null);
  const [dateTo, setDateTo] = useSessionState<string | null>(`album:${id}:dateTo`, null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const { withBatches } = useWait();
  const navigate = useNavigate();
  const selects = useSelects();
  // The album always collapses each RAW+JPEG pair to one card (see
  // orderedImages), so in the combined view the pair-aware bulk/remove helpers
  // below must treat the shown JPEG as standing for its hidden RAW partner.
  const mergePairs = viewMode === "combined";
  const { dialog: pairDeleteDialog, confirmDelete } = usePairDeleteConfirm();
  const [renaming, setRenaming] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const q = (searchParams.get("q") ?? "").trim();

  const { data: album } = useQuery({
    queryKey: ["album", id],
    queryFn: () => api.albums.get(id!),
    enabled: !!id,
  });

  const { data: allTags } = useQuery({
    queryKey: ["tags"],
    queryFn: () => api.tags.list(),
    select: withoutMembershipNames,
  });

  // "Add to Immich" only appears when the integration is configured in Settings.
  const { data: immich } = useQuery({ queryKey: ["immich-settings"], queryFn: () => api.settings.getImmich() });
  const immichConfigured = Boolean(immich?.base_url && immich?.api_key_set && immich.enabled);
  const [immichBusy, setImmichBusy] = useState(false);
  // Both flash messages auto-dismiss after a moment.
  const [immichMsg, setImmichMsg] = useTransientMessage();
  const [developBusy, setDevelopBusy] = useState(false);
  const [developMsg, setDevelopMsg] = useTransientMessage();
  // Adding to another album is otherwise invisible (the dropdown just snaps back
  // to its placeholder), so confirm it in the action bar's message row - same
  // place the tag note appears. Carries its own error flag since a failed add
  // must not read like a success.
  const [albumMsg, setAlbumMsg] = useTransientValue<{ text: string; error: boolean }>();
  // A failed bulk action. Not transient like the notes above: it stays until
  // it is dismissed, the next action starts or the selection is dropped.
  const [barError, setBarError] = useState<string | null>(null);
  function dismissMessages() {
    setImmichMsg(null);
    setDevelopMsg(null);
    setAlbumMsg(null);
    setBarError(null);
  }

  // Lock the nav + show the top-bar spinner while uploading to Immich, same as
  // the Settings maintenance tasks.
  const { setBusyLabel, trackRenders } = useTasks();
  useEffect(() => {
    setBusyLabel(immichBusy ? "Uploading to Immich…" : null);
  }, [immichBusy, setBusyLabel]);
  useEffect(() => () => setBusyLabel(null), [setBusyLabel]);


  // Escape walks back to the albums, the same as it leaves the lightbox and
  // the editor - one key out of any view. While photos are selected the
  // first Escape only clears the selection (useSelectionKeys below takes that
  // press). A dialog on top captures Escape before this sees it.
  const hasSelection = selected.size > 0;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || hasSelection) return;
      // (...unless a menu inside that dialog took the press for itself.)
      if (isModalOpen()) return;
      const target = e.target as HTMLElement | null;
      // A text box keeps its own Escape (backing out of a rename or search).
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      navigate("/albums");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasSelection, navigate]);

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
      // Explicit big limit: the backend default is 100, which silently
      // truncated larger albums (and would cripple the scrubber).
      return api.images.list(filters, { limit: 5000, offset: 0 });
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
    // The bar goes with the selection - and must not come back later with
    // an old failure still written on it.
    dismissMessages();
  }

  // Cmd/Ctrl+A picks the whole album, Escape drops the selection, E opens a
  // single selected photo in the editor.
  useSelectionKeys({
    onSelectAll: selectAll,
    onClear: clearSelection,
    hasSelection,
    edit: { selected, order: orderedImages.map((img) => img.id) },
    onRate: (rating) => void applyBulk({ rating }),
    // The key of the colour the selection already has takes it off again.
    onColor: (label) =>
      void applyBulk({
        color_label: selectionSharedMeta(images ?? [], selected).colorLabel === label ? "none" : label,
      }),
    onDelete: () => void deleteSelected(),
  });

  async function applyBulk(patch: { rating?: number; color_label?: string }) {
    if (selected.size === 0) return;
    // With merged pairs only the JPEG is visible, so mirror the change to each
    // hidden RAW partner too.
    try {
      // One photo gets no wait popup: it holds every key while it is up, and
      // a star followed by the arrow to the next photo must not lose the arrow.
      if (selected.size === 1) await api.images.bulkUpdate(Array.from(selected), patch);
      else await withBatches("Updating photos…", Array.from(selected), (ids) => api.images.bulkUpdate(ids, patch));
    } finally {
      queryClient.invalidateQueries({ queryKey: ["images"] });
    }
  }

  // The arrow keys' target: this photo, and only it (see utils/gridKeys).
  function selectOnly(id: string, index: number) {
    setSelected(new Set([id]));
    setLastIndex(index);
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
    // Where a single deleted photo's selection goes: the next one in the grid,
    // or the one before at the end. Its index is the deleted photo's own slot.
    let nextAfterDelete: { id: string; index: number } | null = null;
    if (baseIds.length === 1) {
      const at = orderedImages.findIndex((im) => im.id === baseIds[0]);
      const gone = new Set(ids);
      const after = orderedImages.slice(at + 1).find((im) => !gone.has(im.id));
      const before = orderedImages.slice(0, Math.max(at, 0)).reverse().find((im) => !gone.has(im.id));
      if (at !== -1 && after) nextAfterDelete = { id: after.id, index: at };
      else if (at > 0 && before) nextAfterDelete = { id: before.id, index: at - 1 };
    }
    try {
      const { done, cancelled } = await withBatches(
        "Moving photos to trash…",
        pairUnits(ids, (x) => byId.get(x)?.paired_image_id),
        (slice) => api.images.bulkDelete(slice)
      );
      // Cancelled: what is still in the grid stays selected.
      if (cancelled) setSelected(new Set(baseIds.filter((x) => !done.includes(x))));
      // One photo deleted (culling from the keyboard): the selection moves on
      // to its neighbour instead of ending there.
      else if (nextAfterDelete) selectOnly(nextAfterDelete.id, nextAfterDelete.index);
      else clearSelection();
    } finally {
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["album", id] });
      queryClient.invalidateQueries({ queryKey: ["albums"] });
      queryClient.invalidateQueries({ queryKey: ["trash"] });
      // Trashing or restoring photos changes which tags live photos carry.
      queryClient.invalidateQueries({ queryKey: ["tags"] });
    }
  }

  async function removeSelectedFromAlbum() {
    if (!id || selected.size === 0) return;
    // Merged view hides the RAW behind its JPEG - remove both halves.
    const ids = withPairedIds(Array.from(selected));
    const byId = new Map((images ?? []).map((im) => [im.id, im]));
    try {
      const { done, cancelled } = await withBatches(
        "Removing photos from album…",
        pairUnits(ids, (x) => byId.get(x)?.paired_image_id),
        (slice) => Promise.all(slice.map((imageId) => api.albums.removeImage(id, imageId)))
      );
      // Cancelled: what is still in the album stays selected.
      if (cancelled) setSelected(new Set(Array.from(selected).filter((x) => !done.includes(x))));
      else clearSelection();
    } finally {
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["album", id] });
      queryClient.invalidateQueries({ queryKey: ["albums"] });
    }
  }

  async function addTagToSelected(name: string) {
    if (selected.size === 0 || !name.trim()) return;
    const tag = name.trim();
    try {
      const { done, cancelled } = await withBatches("Tagging photos…", Array.from(selected), (ids) =>
        api.images.bulkAddTags(ids, [tag])
      );
      setDevelopMsg(`Added tag “${tag}” to ${done.length} photo(s).${cancelled ? CANCELLED_NOTE : ""}`);
    } finally {
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["tags"] });
    }
  }

  async function addSelectedToCanvas(canvasId: string) {
    if (selected.size === 0) return;
    // Same pair rule as albums: in merged view the RAW partner rides along,
    // so the canvas's filmstrip holds the whole shot.
    await api.canvases.addImages(canvasId, withPairedIds(Array.from(selected)));
    queryClient.invalidateQueries({ queryKey: ["canvas-list"] });
    queryClient.invalidateQueries({ queryKey: ["canvas-images", canvasId] });
  }

  // How many shots the last album add really covered, when it was cancelled
  // part-way - read (and cleared) by the note that reports it.
  const partialAddRef = useRef<number | null>(null);
  function takeAddedCount(): number {
    const n = partialAddRef.current ?? selected.size;
    partialAddRef.current = null;
    return n;
  }

  function reportAddTo({ kind, name, ok }: AddToResult) {
    const cancelNote = partialAddRef.current !== null ? CANCELLED_NOTE : "";
    const what = kind === "canvas" ? `canvas “${name}”` : kind === "selects" ? "selects" : `“${name}”`;
    setAlbumMsg(
      ok
        ? { text: `Added ${takeAddedCount()} photo(s) to ${what}.${cancelNote}`, error: false }
        : { text: `Could not add to ${what}.`, error: true },
      // A failure stays until it is dismissed or the next action runs.
      { keep: !ok }
    );
  }

  async function addSelectedToAlbum(targetAlbumId: string) {
    if (selected.size === 0) return;
    // In merged view the RAW partner is hidden behind the JPEG card - add it
    // too, so the target album holds the whole shot.
    const byId = new Map((images ?? []).map((im) => [im.id, im]));
    const units = pairUnits(withPairedIds(Array.from(selected)), (x) => byId.get(x)?.paired_image_id);
    try {
      const { done, cancelled } = await withBatches("Adding photos to album…", units, (slice) =>
        api.albums.addImages(targetAlbumId, slice)
      );
      partialAddRef.current = cancelled ? done.filter((x) => selected.has(x)).length : null;
    } finally {
      queryClient.invalidateQueries({ queryKey: ["albums"] });
      queryClient.invalidateQueries({ queryKey: ["album", targetAlbumId] });
    }
  }

  // Counts the selection, not the ids actually sent: merged view silently adds
  // each shot's RAW partner too, and reporting that larger number would look
  // like a bug to someone who selected 3 photos. Mirrors the tag note's phrasing.
  function reportAlbumAdd({ name, ok }: { name: string; ok: boolean }) {
    const cancelNote = partialAddRef.current !== null ? CANCELLED_NOTE : "";
    setAlbumMsg(
      ok
        ? { text: `Added ${takeAddedCount()} photo(s) to “${name}”.${cancelNote}`, error: false }
        : { text: `Could not add to “${name}”.`, error: true },
      // A failure stays until it is dismissed or the next action runs.
      { keep: !ok }
    );
  }

  async function resetSelected(opts: BulkResetOptions) {
    if (selected.size === 0) return;
    try {
      const { done } = await withBatches("Resetting photos…", Array.from(selected), (ids) =>
        api.images.bulkReset(ids, opts)
      );
      trackRenders(done);
    } finally {
      await refreshAfterReset();
    }
  }

  async function refreshAfterReset() {
    // Awaited, like the library's - the popup stays up until the rows are back.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["images"] }),
      queryClient.invalidateQueries({ queryKey: ["tags"] }),
      queryClient.invalidateQueries({ queryKey: ["album", id] }),
      queryClient.invalidateQueries({ queryKey: ["albums"] }),
    ]);
  }

  async function autoDevelopSelected() {
    if (selected.size === 0) return;
    const editedCount = (images ?? []).filter((im) => selected.has(im.id) && im.edit_rev).length;
    if (
      editedCount > 0 &&
      !(await dialogs.confirm({
        title: `Auto-develop ${selected.size} photo(s)?`,
        message: `This replaces the existing edits of ${editedCount} photo(s).`,
        confirmLabel: "Auto-develop",
      }))
    )
      return;
    setDevelopBusy(true);
    setDevelopMsg(null);
    setBarError(null);
    try {
      const { done, results, cancelled } = await withBatches(
        "Auto-developing photos…",
        Array.from(selected),
        (ids) => api.images.bulkAutoDevelop(ids)
      );
      const applied = results.reduce((n, r) => n + r.applied, 0);
      const skipped = results.reduce((n, r) => n + r.skipped, 0);
      setDevelopMsg(
        (skipped > 0
          ? `Auto-developed ${applied} photo(s). Skipped ${skipped} with no similar edits to learn from.`
          : `Auto-developed ${applied} photo(s).`) + (cancelled ? CANCELLED_NOTE : "")
      );
      trackRenders(done);
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["album", id] });
    } catch (e) {
      setBarError(errorText(e));
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
      !(await dialogs.confirm({
        title: `Apply preset “${name}” to ${selected.size} photo(s)?`,
        message: `This replaces the existing edits of ${editedCount} photo(s).`,
        confirmLabel: "Apply preset",
      }))
    )
      return;
    setDevelopBusy(true);
    setDevelopMsg(null);
    setBarError(null);
    const look = presetAdjustments(preset) as unknown as Record<string, unknown>;
    try {
      const { done, cancelled } = await withBatches("Applying preset…", Array.from(selected), (ids) =>
        api.images.bulkDevelop(ids, look)
      );
      setDevelopMsg(`Applied preset “${name}” to ${done.length} photo(s).${cancelled ? CANCELLED_NOTE : ""}`);
      // The pictures render in the background: the title bar counts them down.
      trackRenders(done);
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["album", id] });
    } catch (e) {
      setBarError(errorText(e));
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
    setBarError(null);
    try {
      const result = await api.images.pushToImmich(Array.from(selected));
      setImmichMsg(result.message);
    } catch (e) {
      setBarError(errorText(e));
    } finally {
      setImmichBusy(false);
    }
  }

  /* The album's own row - Back, name, delete - lives UNDER the content in
     both modes, the same as the editor's and the photo view's stage rows: the
     name centred, Back flush left and the destructive action flush right,
     both out of the row's flow so the centre stays centred. */
  const albumBar = (
    <h2 className="section-title album-bottom-bar">
      {/* No Back of its own: the top bar's Back leads to wherever the album
          was opened from. */}
      {album ? (
        /* The album's name is the user's own - the pencil next to it renames
           it right here. */
        <>
          <AlbumNameField
            albumId={album.id}
            name={album.name}
            editing={renaming}
            onEditingChange={setRenaming}
            inputClassName="album-title-input"
          />
          {!renaming && (
            <button
              className="btn btn-sm ghost album-rename-btn"
              title="Rename this album"
              aria-label="Rename this album"
              onClick={() => setRenaming(true)}
            >
              <IconRename size={14} />
            </button>
          )}
        </>
      ) : (
        "Album"
      )}
      {album && <span className="count-pill">{album.image_count} photos</span>}
      {album && immichConfigured && immich?.sync_mode === "selective" && (
        <ImmichSyncToggle
          small
          on={album.immich_sync}
          onToggle={toggleAlbumImmichSync}
          title="Keep this album in sync with Immich. RAW files only when “Also upload RAW files” is on in Settings."
        />
      )}
      {album && (
        <button
          className="btn btn-sm quiet-danger album-bottom-delete"
          title="Delete this album. Its photos stay in the library."
          aria-label="Delete this album"
          onClick={async () => {
            if (
              !(await dialogs.confirm({
                title: `Delete album “${album.name}”?`,
                message: `Its ${album.image_count} photo(s) stay in your library.`,
                confirmLabel: "Delete album",
                danger: true,
              }))
            ) {
              return;
            }
            await api.albums.remove(album.id);
            queryClient.invalidateQueries({ queryKey: ["albums"] });
            navigate("/albums");
          }}
        >
          <IconTrash size={14} />
        </button>
      )}
    </h2>
  );

  return (
    <div className="page page-timeline">
      {pairDeleteDialog}
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
        {/* Both only once a photo is picked (Cmd/Ctrl-click) - the toolbar
            stays clean while nothing is selected; Cmd/Ctrl+A works anytime. */}
        {hasSelection && (
          <>
            <button className="btn" onClick={selectAll} title={`Select every photo shown (${modKeyLabel}+A)`}>
              Select all
            </button>
            <button className="btn" onClick={clearSelection} title="Clear the selection (Esc)">
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
      <Presence open={selected.size > 0} ms={MOTION.bar}>
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
              <AddToPicker
                onAddToAlbum={addSelectedToAlbum}
                onAddToCanvas={addSelectedToCanvas}
                onAddToSelects={() => selects.add(Array.from(selected))}
                onResult={reportAddTo}
              />
            </div>
            {/* Hidden in full sync mode - everything uploads automatically there.
                The whole group goes, not just the button, so no empty gap is
                left now that "Add to selects" lives in the picker above. */}
            {immichConfigured && immich?.sync_mode !== "full" && (
              <div className="control-group">
                <button
                  className="btn"
                  onClick={addSelectedToImmich}
                  disabled={immichBusy}
                  title="Upload the selected photos to your Immich server. RAW files only when “Also upload RAW files” is on in Settings."
                >
                  <IconCloudUp size={13} /> {immichBusy ? "Uploading to Immich…" : "Add to Immich"}
                </button>
              </div>
            )}
            <div className="control-group">
              <EditPicker
                onAutoEdit={autoDevelopSelected}
                onApplyPreset={applyPresetToSelected}
                busy={developBusy}
              />
              <ResetMenu count={selected.size} onReset={resetSelected} />
              <button className="btn" onClick={removeSelectedFromAlbum}>
                Remove from this album
              </button>
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
            <ActionBarMessages
              messages={[
                immichMsg ? { text: immichMsg } : null,
                developMsg ? { text: developMsg } : null,
                albumMsg,
                barError ? { text: barError, error: true } : null,
              ]}
              onDismiss={dismissMessages}
            />
          </div>
        )}
      </Presence>
      {isLoading ? (
        <LoadingState />
      ) : (
        <ThumbnailGrid
          images={orderedImages}
          selectedIds={selected}
          onToggleSelect={toggleSelect}
          onSelectOnly={selectOnly}
          groupByDate={!q}
          onRemove={removeFromAlbum}
          removeTitle="Remove from this album"
        />
      )}
      </div>
      {albumBar}
    </div>
  );
}

import { useEffect, useMemo, useState, useRef } from "react";
import { useSessionState } from "../utils/useSessionState";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { CANCELLED_NOTE, pairUnits } from "../utils/batchUnits";
import { withoutMembershipNames } from "../utils/autoTags";
import { useAppDialogs } from "../components/AppDialogs";
import type { BulkResetOptions, ColorLabel, ImageOut, LibraryFilters, ViewMode, Flag } from "../api/types";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ThumbnailGrid } from "../components/ThumbnailGrid";
import { RatingStars } from "../components/RatingStars";
import { ColorLabelPicker } from "../components/ColorLabelPicker";
import { FlagPicker } from "../components/FlagPicker";
import { useSelectionExport } from "../components/SelectionExport";
import { AddToPicker, useAddToNotice, type AddToResult } from "../components/AddToPicker";
import { AlbumNameField } from "../components/AlbumNameField";
import { TagFilter } from "../components/TagFilter";
import { BulkTagInput } from "../components/BulkTagInput";
import { ResetMenu } from "../components/ResetMenu";
import { EditPicker } from "../components/EditPicker";
import { IconCheck, IconCloudUp, IconExport, IconMinus, IconRename, IconSort, IconSparkle, IconTrash, IconX, IconTag } from "../components/Icons";
import { AutoPickDialog } from "../components/AutoPickDialog";
import { ExportDialog } from "../components/ExportDialog";
import { ImmichSyncToggle } from "../components/ImmichSyncToggle";
import { PhotoFilters } from "../components/PhotoFilters";
import { Dropdown } from "../components/Dropdown";
import { SORT_OPTIONS, sortImages, type SortKey } from "../utils/sortOrder";
import { loadPresets, presetAdjustments } from "../utils/presets";
import { useTasks, type BatchItem } from "../state/tasks";
import { usePairDeleteConfirm } from "../components/usePairDeleteConfirm";
import { collapsePairs, useAskSaveCopyOptions } from "../state/viewPrefs";
import { FULL_COPY_QUALITY, SaveCopyDialog, type SaveCopyRequest } from "../components/SaveCopyDialog";
import { useEditCopies } from "../utils/useEditCopies";
import { modKeyLabel, useSelectionKeys } from "../utils/selection";
import { useBarHeight } from "../utils/useBarHeight";
import { selectionSharedMeta } from "../utils/selectionMeta";
import type { ContextActions } from "../components/PhotoContextMenu";
import { Presence } from "../components/Presence";
import { MOTION } from "../utils/usePresence";
import { LoadingState } from "../components/Spinner";
// The JPEG options of "Apply ... and save copy".
type CopyOpts = { quality: number; maxSize: number | null };

import { errorText } from "../utils/apiError";
import { isModalOpen } from "../utils/modalKeys";
import { plural } from "../utils/plural";

// The one bulk task this page runs at a time (state/tasks).
const ALBUM_BATCH = "batch:album";

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
  // The same gear filters and orders as the Library, so an album can be
  // narrowed and ordered the way the whole library can. Only the album/canvas
  // picker is left out: this page is one album already.
  const [camera, setCamera] = useSessionState<string>(`album:${id}:camera`, "");
  const [lens, setLens] = useSessionState<string>(`album:${id}:lens`, "");
  const [focalMin, setFocalMin] = useSessionState<string>(`album:${id}:focalMin`, "");
  const [focalMax, setFocalMax] = useSessionState<string>(`album:${id}:focalMax`, "");
  const setFocalRange = (min: string, max: string) => {
    setFocalMin(min);
    setFocalMax(max);
  };
  const [cameraMake, setCameraMake] = useSessionState<string>(`album:${id}:cameraMake`, "");
  const [isoMin, setIsoMin] = useSessionState<string>(`album:${id}:isoMin`, "");
  const [isoMax, setIsoMax] = useSessionState<string>(`album:${id}:isoMax`, "");
  const setIsoRange = (min: string, max: string) => {
    setIsoMin(min);
    setIsoMax(max);
  };
  const [apertureMin, setApertureMin] = useSessionState<string>(`album:${id}:apertureMin`, "");
  const [apertureMax, setApertureMax] = useSessionState<string>(`album:${id}:apertureMax`, "");
  const setApertureRange = (min: string, max: string) => {
    setApertureMin(min);
    setApertureMax(max);
  };
  const [shutterMin, setShutterMin] = useSessionState<string>(`album:${id}:shutterMin`, "");
  const [shutterMax, setShutterMax] = useSessionState<string>(`album:${id}:shutterMax`, "");
  const setShutterRange = (min: string, max: string) => {
    setShutterMin(min);
    setShutterMax(max);
  };
  const [sort, setSort] = useSessionState<SortKey>(`album:${id}:sort`, "newest");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const barRef = useBarHeight();
  // Export for the selection: the bar's button, the dialog, ⇧⌘E.
  const selectionExport = useSelectionExport(Array.from(selected));
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const navigate = useNavigate();
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
  const [developBusy, setDevelopBusy] = useState(false);

  const { runTask, trackRenders, trackCopyJob, runBatches, hasTask, pushUndo, notify } = useTasks();
  // The outcome of a bulk action stands in the title bar's task dock (see
  // Library); a failure stays until dismissed or the next outcome replaces it.
  const report = (text: string) => notify({ label: text });
  const reportError = (text: string) => notify({ label: text, error: true });
  const addToNotice = useAddToNotice();
  // Every bulk action of this page runs as one task in the title bar, counted
  // down there with a Stop, and one at a time (see Library).
  const batchBusy = hasTask(ALBUM_BATCH);
  // quiet: stars, flags and tags - out of the dock unless they take a while.
  const batch = <R,>(label: string, items: BatchItem[], run: (ids: string[]) => Promise<R>, quiet = false) =>
    runBatches({ id: ALBUM_BATCH, kind: "batch", label, quiet }, items, run);
  const askSaveCopyOptions = useAskSaveCopyOptions();
  // The options dialog of "Apply ... and save copy", resolved by its answer.
  // The Save-copy dialog asked before a bulk copy: "Apply … and save copy"
  // (a file by definition, only the options) and "Edit a copy" (which kind).
  const [copyPrompt, setCopyPrompt] = useState<{
    resolve: (req: SaveCopyRequest | null) => void;
    physicalOnly: boolean;
    title: string;
  } | null>(null);
  const editCopies = useEditCopies();


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
    camera_model: camera || undefined,
    lens_model: lens || undefined,
    focal_min: focalMin || undefined,
    focal_max: focalMax || undefined,
    camera_make: cameraMake || undefined,
    iso_min: isoMin || undefined,
    iso_max: isoMax || undefined,
    aperture_min: apertureMin || undefined,
    aperture_max: apertureMax || undefined,
    shutter_min: shutterMin || undefined,
    shutter_max: shutterMax || undefined,
  };

  // Camera/lens/focal dropdown options, cross-filtered against the album and
  // the other filters, like the Library's. Keyed under "facets" so
  // invalidateQueries(["facets"]) catches this variant too.
  const { data: facets } = useQuery({
    queryKey: ["facets", filters],
    queryFn: () => api.images.facets(filters),
    enabled: !!id,
  });

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
  // The chosen order is made before the pairs are collapsed, so a pair's
  // shown card lands where its JPEG sorts. Search results keep their ranking.
  const sortedImages = useMemo(() => {
    const list = images ?? [];
    return q ? list : sortImages(list, sort);
  }, [images, q, sort]);
  const orderedImages = viewMode === "combined" ? collapsePairs(sortedImages) : sortedImages;

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
    const albumId = id;
    // In merged view the card stands for the whole RAW+JPEG shot - remove the
    // hidden partner too, or it would linger in the album as an orphan.
    const removed = withPairedIds([imageId]);
    await Promise.all(removed.map((x) => api.albums.removeImage(albumId, x)));
    const refresh = () => {
      // Refresh both the album's photo list and its header count.
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["album", albumId] });
      queryClient.invalidateQueries({ queryKey: ["albums"] });
    };
    refresh();
    pushUndo({
      label: "Removed from the album",
      undo: async () => {
        await api.albums.addImages(albumId, removed);
        refresh();
      },
    });
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
    onFlag: (flag) =>
      void applyBulk({ flag: flag && selectionSharedMeta(images ?? [], selected).flag === flag ? "" : flag }),
    onDelete: () => void deleteSelected(),
    onExport: () => selectionExport.open(),
  });

  async function applyBulk(
    patch: { rating?: number; color_label?: string; flag?: Flag | "" },
    target: Iterable<string> = selected
  ) {
    const ids = Array.from(target);
    if (ids.length === 0) return;
    const { flag: flagPatch, ...restPatch } = patch;
    const tilePatch = flagPatch === undefined ? restPatch : { ...restPatch, flag: (flagPatch || null) as Flag | null };
    // With merged pairs only the JPEG is visible, so mirror the change to each
    // hidden RAW partner too.
    // Onto the tiles slice by slice; the refetch below then finds what it
    // expected and changes nothing.
    const show = (changed: string[]) => {
      const set = new Set(changed);
      queryClient.setQueriesData<ImageOut[]>({ queryKey: ["images"] }, (old) =>
        Array.isArray(old) ? old.map((im) => (set.has(im.id) ? ({ ...im, ...tilePatch } as ImageOut) : im)) : old
      );
    };
    try {
      // One photo is one quick request and no task: a star followed by the
      // arrow to the next photo must not wait on it.
      if (ids.length === 1) {
        await api.images.bulkUpdate(ids, patch);
        show(ids);
      } else {
        await batch("Updating photos…", ids, async (slice) => {
          await api.images.bulkUpdate(slice, patch);
          show(slice);
        }, true);
      }
    } finally {
      queryClient.invalidateQueries({ queryKey: ["images"] });
    }
  }

  // The arrow keys' target: this photo, and only it (see utils/gridKeys).
  function selectOnly(id: string, index: number) {
    setSelected(new Set([id]));
    setLastIndex(index);
  }

  async function deleteSelected(target: string[] = Array.from(selected)) {
    if (target.length === 0) return;
    // Merged view hides the RAW behind its JPEG, so both halves of the shot go
    // together by default. The "ask what to delete" setting lets the user keep
    // the partners.
    const baseIds = target;
    const baseSet = new Set(baseIds);
    const partnerIds = withPairedIds(baseIds).filter((x) => !baseSet.has(x));
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
      const { done, cancelled } = await batch(
        "Moving photos to trash…",
        pairUnits(ids, (x) => byId.get(x)?.paired_image_id),
        async (slice) => {
          await api.images.bulkDelete(slice);
          // Out of the grid slice by slice: a photo already in the trash
          // cannot be picked and sent again while the rest still go.
          const gone = new Set(slice);
          queryClient.setQueriesData<ImageOut[]>({ queryKey: ["images"] }, (old) =>
            Array.isArray(old) ? old.filter((im) => !gone.has(im.id)) : old
          );
        }
      );
      const gone = new Set(cancelled ? done : ids);
      if (!cancelled) {
        pushUndo({
          label: `${ids.length === 1 ? "1 photo" : `${ids.length} photos`} moved to Trash`,
          undo: async () => {
            await api.images.restoreFromTrash(ids);
            queryClient.invalidateQueries({ queryKey: ["images"] });
            queryClient.invalidateQueries({ queryKey: ["trash"] });
            queryClient.invalidateQueries({ queryKey: ["tags"] });
          },
        });
      }
      // One photo deleted (culling from the keyboard): the selection moves on
      // to its neighbour instead of ending there.
      if (!cancelled && nextAfterDelete) selectOnly(nextAfterDelete.id, nextAfterDelete.index);
      // Otherwise the deleted photos leave the selection as it is now, not as
      // it was when this started. Nothing left: the bar goes too.
      else
        setSelected((prev) => {
          const next = new Set(Array.from(prev).filter((x) => !gone.has(x)));
          if (next.size === 0 && prev.size > 0) {
            setLastIndex(null);
          }
          return next;
        });
    } finally {
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["album", id] });
      queryClient.invalidateQueries({ queryKey: ["albums"] });
      queryClient.invalidateQueries({ queryKey: ["trash"] });
      // Trashing or restoring photos changes which tags live photos carry.
      queryClient.invalidateQueries({ queryKey: ["tags"] });
    }
  }

  async function removeSelectedFromAlbum(target: string[] = Array.from(selected)) {
    if (!id || target.length === 0) return;
    // Merged view hides the RAW behind its JPEG - remove both halves.
    const ids = withPairedIds(target);
    const byId = new Map((images ?? []).map((im) => [im.id, im]));
    try {
      const { done, cancelled } = await batch(
        "Removing photos from album…",
        pairUnits(ids, (x) => byId.get(x)?.paired_image_id),
        async (slice) => {
          await Promise.all(slice.map((imageId) => api.albums.removeImage(id, imageId)));
          const gone = new Set(slice);
          queryClient.setQueriesData<ImageOut[]>({ queryKey: ["images"] }, (old) =>
            Array.isArray(old) ? old.filter((im) => !gone.has(im.id)) : old
          );
        }
      );
      // The removed photos leave the selection as it is now; what is still in
      // the album (after a Stop) stays selected.
      const gone = new Set(cancelled ? done : ids);
      setSelected((prev) => {
        const next = new Set(Array.from(prev).filter((x) => !gone.has(x)));
        if (next.size === 0 && prev.size > 0) {
          setLastIndex(null);
        }
        return next;
      });
    } finally {
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["album", id] });
      queryClient.invalidateQueries({ queryKey: ["albums"] });
    }
  }

  async function addTagToSelected(name: string, target: string[] = Array.from(selected)) {
    if (target.length === 0 || !name.trim()) return;
    const tag = name.trim();
    try {
      const { done, cancelled } = await batch(
        "Tagging photos…",
        target,
        (ids) => api.images.bulkAddTags(ids, [tag]),
        true
      );
      report(`Added tag “${tag}” to ${plural(done.length, "photo")}.${cancelled ? CANCELLED_NOTE : ""}`);
    } finally {
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["tags"] });
    }
  }

  async function addSelectedToCanvas(canvasId: string, target: string[] = Array.from(selected)) {
    if (target.length === 0) return;
    // Same pair rule as albums: in merged view the RAW partner rides along,
    // so the canvas's filmstrip holds the whole shot.
    await api.canvases.addImages(canvasId, withPairedIds(target));
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

  function reportAddTo(result: AddToResult, count = takeAddedCount()) {
    const cancelNote = partialAddRef.current !== null ? CANCELLED_NOTE : "";
    partialAddRef.current = null;
    addToNotice(result, count, cancelNote);
  }

  // The right-click menu's add: the same report as the bar's picker (see
  // Library).
  async function addFromMenu(kind: AddToResult["kind"], id: string, name: string, ids: string[]) {
    try {
      await (kind === "canvas" ? addSelectedToCanvas(id, ids) : addSelectedToAlbum(id, ids));
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      reportAddTo({ kind, id, name, ok: true }, partialAddRef.current ?? ids.length);
    } catch {
      reportAddTo({ kind, id, name, ok: false });
    }
  }

  // The Find similar dialog's add closes the dialog on success so the dock's
  // line (and its Open link) is in reach - the modal covers the title bar.
  function reportPickAddTo(result: AddToResult, count: number, close: () => void, note: (text: string, error: boolean) => void) {
    if (result.ok) {
      reportAddTo(result, count);
      close();
    } else note(`Could not add to ${result.kind === "canvas" ? "canvas " : ""}“${result.name}”.`, true);
  }

  async function addSelectedToAlbum(targetAlbumId: string, target: string[] = Array.from(selected)) {
    if (target.length === 0) return;
    const targetSet = new Set(target);
    // In merged view the RAW partner is hidden behind the JPEG card - add it
    // too, so the target album holds the whole shot.
    const byId = new Map((images ?? []).map((im) => [im.id, im]));
    const units = pairUnits(withPairedIds(target), (x) => byId.get(x)?.paired_image_id);
    try {
      const { done, cancelled } = await batch("Adding photos to album…", units, (slice) =>
        api.albums.addImages(targetAlbumId, slice)
      );
      partialAddRef.current = cancelled ? done.filter((x) => targetSet.has(x)).length : null;
    } finally {
      queryClient.invalidateQueries({ queryKey: ["albums"] });
      queryClient.invalidateQueries({ queryKey: ["album", targetAlbumId] });
    }
  }

  // The right-click menu's hands on the photos under the pointer (or the
  // selection they belong to): the same actions as the bulk bar, by id.
  const [autoPick, setAutoPick] = useState<string[] | null>(null);
  const [pickExport, setPickExport] = useState<string[] | null>(null);
  const contextActions: ContextActions = {
    onAutoPick: (ids) => setAutoPick(ids),
    onRate: (ids, rating) => applyBulk({ rating }, ids),
    onColor: (ids, label) => applyBulk({ color_label: label }, ids),
    onFlag: (ids, flag) => applyBulk({ flag }, ids),
    onAddToAlbum: (ids, albumId, name) => addFromMenu("album", albumId, name, ids),
    onAddToCanvas: (ids, canvasId, name) => addFromMenu("canvas", canvasId, name, ids),
    onAddTag: (ids, name) => addTagToSelected(name, ids),
    onAutoEdit: (ids, mode) =>
      mode === "on-copy" ? autoDevelopOnCopy(ids) : mode === "copy" ? autoDevelopAndCopy(ids) : autoDevelopSelected(undefined, ids),
    onApplyPreset: (ids, name, mode) =>
      mode === "on-copy"
        ? applyPresetOnCopy(name, ids)
        : mode === "copy"
          ? applyPresetAndCopy(name, ids)
          : applyPresetToSelected(name, undefined, ids),
    presets: () => Object.keys(loadPresets()),
    onReset: (ids, opts) => resetSelected(opts, ids),
    // The bar's "Add to Immich": not in full mode (everything uploads anyway)
    // and not while an upload runs.
    immich: (ids) =>
      immichConfigured && immich?.sync_mode !== "full" && !immichBusy
        ? { label: "Add to Immich", run: () => addSelectedToImmich(ids) }
        : null,
    onRemoveFromAlbum: (ids) => removeSelectedFromAlbum(ids),
    onDelete: (ids) => deleteSelected(ids),
    meta: (ids) => selectionSharedMeta(images ?? [], new Set(ids)),
  };

  async function resetSelected(opts: BulkResetOptions, target: string[] = Array.from(selected)) {
    if (target.length === 0) return;
    try {
      const { done } = await batch("Resetting photos…", target, (ids) =>
        api.images.bulkReset(ids, opts)
      );
      trackRenders(done);
    } finally {
      await refreshAfterReset();
    }
  }

  async function refreshAfterReset() {
    // Awaited, like the library's - reported only once the rows are back.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["images"] }),
      queryClient.invalidateQueries({ queryKey: ["tags"] }),
      queryClient.invalidateQueries({ queryKey: ["album", id] }),
      queryClient.invalidateQueries({ queryKey: ["albums"] }),
    ]);
  }

  async function autoDevelopSelected(copyOpts?: CopyOpts, target: string[] = Array.from(selected)) {
    if (target.length === 0) return;
    const targetSet = new Set(target);
    const editedCount = (images ?? []).filter((im) => targetSet.has(im.id) && im.edit_rev).length;
    if (
      editedCount > 0 &&
      !(await dialogs.confirm({
        title: `Auto-develop ${plural(target.length, "photo")}?`,
        message: `This replaces the existing edits of ${plural(editedCount, "photo")}.`,
        confirmLabel: "Auto-develop",
      }))
    )
      return;
    setDevelopBusy(true);
    try {
      const { done, results, cancelled } = await batch(
        "Auto-developing photos…",
        target,
        (ids) => api.images.bulkAutoDevelop(ids)
      );
      const applied = results.reduce((n, r) => n + r.applied, 0);
      const skipped = results.reduce((n, r) => n + r.skipped, 0);
      report(
        (skipped > 0
          ? `Auto-developed ${plural(applied, "photo")}. Skipped ${skipped} with no similar edits to learn from.`
          : `Auto-developed ${plural(applied, "photo")}.`) + (cancelled ? CANCELLED_NOTE : "")
      );
      trackRenders(done);
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["album", id] });
      if (copyOpts) await startCopies(results.flatMap((r) => r.applied_ids), copyOpts);
    } catch (e) {
      reportError(errorText(e));
    } finally {
      setDevelopBusy(false);
    }
  }

  // Apply a saved editor preset (a full develop look) to the whole selection.
  async function applyPresetToSelected(name: string, copyOpts?: CopyOpts, target: string[] = Array.from(selected)) {
    const preset = loadPresets()[name];
    if (target.length === 0 || !preset) return;
    const targetSet = new Set(target);
    const editedCount = (images ?? []).filter((im) => targetSet.has(im.id) && im.edit_rev).length;
    if (
      editedCount > 0 &&
      !(await dialogs.confirm({
        title: `Apply preset “${name}” to ${plural(target.length, "photo")}?`,
        message: `This replaces the existing edits of ${plural(editedCount, "photo")}.`,
        confirmLabel: "Apply preset",
      }))
    )
      return;
    setDevelopBusy(true);
    const look = presetAdjustments(preset) as unknown as Record<string, unknown>;
    try {
      const { done, cancelled } = await batch("Applying preset…", target, (ids) =>
        api.images.bulkDevelop(ids, look)
      );
      report(`Applied preset “${name}” to ${plural(done.length, "photo")}.${cancelled ? CANCELLED_NOTE : ""}`);
      // The pictures render in the background: the title bar counts them down.
      trackRenders(done);
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["album", id] });
      if (copyOpts) await startCopies(done, copyOpts);
    } catch (e) {
      reportError(errorText(e));
    } finally {
      setDevelopBusy(false);
    }
  }

  // "Apply ... and save copy": the edit as above, then one JPEG copy of every
  // photo it was applied to, written in the background (the title bar counts
  // them down). The options - quality, size - are asked once for the whole
  // batch when Settings says to ask, before anything is applied.
  async function startCopies(ids: string[], opts: CopyOpts) {
    if (ids.length === 0) return;
    const { job_id, total } = await api.images.copyJobStart(ids, { quality: opts.quality, max_size: opts.maxSize });
    trackCopyJob(job_id, total);
    report(`Edit applied — saving ${total} ${total === 1 ? "copy" : "copies"} in the background.`);
  }

  async function askCopyOptions(count: number): Promise<CopyOpts | null> {
    if (!askSaveCopyOptions) return { quality: FULL_COPY_QUALITY, maxSize: null };
    return new Promise((resolve) =>
      setCopyPrompt({
        physicalOnly: true,
        title: `Apply and save copy of ${plural(count, "photo")}`,
        resolve: (req) => resolve(req && req.kind === "physical" ? { quality: req.quality, maxSize: req.maxSize } : null),
      })
    );
  }

  async function autoDevelopAndCopy(target: string[] = Array.from(selected)) {
    const opts = await askCopyOptions(target.length);
    if (opts) await autoDevelopSelected(opts, target);
  }

  async function applyPresetAndCopy(name: string, target: string[] = Array.from(selected)) {
    const opts = await askCopyOptions(target.length);
    if (opts) await applyPresetToSelected(name, opts, target);
  }

  // "Edit a copy": the edit goes on a copy of each photo, the photos stay as
  // they are. Which kind of copy is asked first (utils/useEditCopies).
  function askCopyKind(count: number): Promise<SaveCopyRequest | null> {
    return new Promise((resolve) =>
      setCopyPrompt({ physicalOnly: false, title: `Edit a copy of ${plural(count, "photo")}`, resolve })
    );
  }

  async function autoDevelopOnCopy(target: string[] = Array.from(selected)) {
    if (target.length === 0) return;
    const req = await askCopyKind(target.length);
    if (req) await editCopies(target, { kind: "auto" }, req);
  }

  async function applyPresetOnCopy(name: string, target: string[] = Array.from(selected)) {
    const preset = loadPresets()[name];
    if (target.length === 0 || !preset) return;
    const req = await askCopyKind(target.length);
    if (req) {
      await editCopies(target, { kind: "preset", name, look: presetAdjustments(preset) as unknown as Record<string, unknown> }, req);
    }
  }

  async function toggleAlbumImmichSync(enabled: boolean) {
    await api.albums.setImmichSync(id!, enabled);
    queryClient.invalidateQueries({ queryKey: ["album", id] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  async function addSelectedToImmich(target: string[] = Array.from(selected)) {
    if (target.length === 0) return;
    setImmichBusy(true);
    try {
      // Shown in the title bar while the photos are handed over; the uploads
      // themselves then show as the Immich sync task.
      const result = await runTask(
        { id: "immich:push", kind: "plain", label: "Adding to Immich…" },
        () => api.images.pushToImmich(target)
      );
      report(result.message);
    } catch (e) {
      reportError(errorText(e));
    } finally {
      setImmichBusy(false);
    }
  }

  /* The album's name heads the bar, like a canvas's name heads its bar; the
     count sits next to it and the pencil renames in place. Immich sync and
     Delete go in the bar's action group at the right. */
  const albumTitle = album ? (
    <>
      <AlbumNameField
        albumId={album.id}
        name={album.name}
        editing={renaming}
        onEditingChange={setRenaming}
        className="bar-title-name"
        inputClassName="album-title-input"
      />
      {!renaming && (
        <button
          className="btn btn-sm ghost album-rename-btn"
          title="Rename this album"
          aria-label="Rename this album"
          onClick={() => setRenaming(true)}
        >
          <IconRename size={12} />
        </button>
      )}
      <span className="count-pill">{album.image_count} photos</span>
    </>
  ) : (
    "Album"
  );

  // An older album's tag rule: every photo carrying one of these tags belongs
  // to the album too. New albums don't get one (the filter has tags), so the
  // control only shows where a rule exists - to change it or take it off.
  async function setTagRule(tags: string[]) {
    if (!album) return;
    await api.albums.update(album.id, { tag_filter: tags });
    queryClient.invalidateQueries({ queryKey: ["album", album.id] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  const hasTagRule = (album?.tag_filter?.length ?? 0) > 0;
  const showImmichToggle = immichConfigured && immich?.sync_mode === "selective";
  const albumActions = album && (hasTagRule || showImmichToggle) && (
    <>
      {hasTagRule && (
        <TagFilter
          icon={<IconTag size={13} />}
          options={allTags ?? []}
          value={album.tag_filter ?? []}
          onChange={(tags) => void setTagRule(tags)}
          emptyLabel="No tag rule"
          title="Photos with any of these tags belong to this album as well"
        />
      )}
      {showImmichToggle && (
        <ImmichSyncToggle
          small
          on={album.immich_sync}
          onToggle={toggleAlbumImmichSync}
          title="Keep this album in sync with Immich. RAW files only if enabled in Settings."
        />
      )}
    </>
  );

  /* Delete stands alone at the far right of the bar, away from the
     everyday controls. */
  const albumDelete = album && (
    <button
      className="btn btn-sm quiet-danger"
      title="Delete this album. Its photos stay in the library."
      aria-label="Delete this album"
      onClick={async () => {
        if (
          !(await dialogs.confirm({
            title: `Delete album “${album.name}”?`,
            message: `Its ${plural(album.image_count, "photo")} stay in your library.`,
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
  );

  return (
    <div className="page page-timeline">
      {pairDeleteDialog}
      {selectionExport.dialog}
      <Presence open={autoPick !== null} ms={MOTION.modal}>
        {autoPick && (
          <AutoPickDialog
            references={autoPick.map((id) => (images ?? []).find((im) => im.id === id)).filter((im): im is ImageOut => !!im)}
            initialReference={autoPick[0] ?? null}
            onClose={() => setAutoPick(null)}
            renderActions={(chosen, close, note) => (
              <>
                <button
                  className="btn"
                  disabled={chosen.length === 0}
                  onClick={() => {
                    close();
                    setPickExport(chosen);
                  }}
                >
                  <IconExport size={13} /> Export…
                </button>
                <AddToPicker
                  disabled={chosen.length === 0}
                  onAddToAlbum={(albumId) => addSelectedToAlbum(albumId, chosen)}
                  onAddToCanvas={(canvasId) => addSelectedToCanvas(canvasId, chosen)}
                  onResult={(result) => reportPickAddTo(result, chosen.length, close, note)}
                />
                <button
                  className="btn primary"
                  disabled={chosen.length === 0}
                  onClick={() => {
                    if (id) void addFromMenu("album", id, album?.name ?? "album", chosen);
                    close();
                  }}
                >
                  Add {chosen.length > 0 ? chosen.length : ""} to this album
                </button>
              </>
            )}
          />
        )}
      </Presence>
      <Presence open={pickExport !== null} ms={MOTION.modal}>
        {pickExport && <ExportDialog imageIds={pickExport} onClose={() => setPickExport(null)} />}
      </Presence>
      <Presence open={copyPrompt !== null} ms={MOTION.modal}>
        {copyPrompt && (
          <SaveCopyDialog
            physicalOnly={copyPrompt.physicalOnly}
            askOptions={askSaveCopyOptions || copyPrompt.physicalOnly}
            count={selected.size}
            title={copyPrompt.title}
            onClose={() => {
              copyPrompt.resolve(null);
              setCopyPrompt(null);
            }}
            onSave={(req) => {
              copyPrompt.resolve(req);
              setCopyPrompt(null);
            }}
          />
        )}
      </Presence>
      <PhotoFilters
        title={albumTitle}
        trailing={albumDelete}
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
        makes={facets?.makes}
        cameraMake={cameraMake}
        onCameraMake={setCameraMake}
        isos={facets?.isos}
        isoMin={isoMin}
        isoMax={isoMax}
        onIsoRange={setIsoRange}
        apertures={facets?.apertures}
        apertureMin={apertureMin}
        apertureMax={apertureMax}
        onApertureRange={setApertureRange}
        shutters={facets?.shutters}
        shutterMin={shutterMin}
        shutterMax={shutterMax}
        onShutterRange={setShutterRange}
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFrom={setDateFrom}
        onDateTo={setDateTo}
        sort={
          <Dropdown
            value={q ? "relevance" : sort}
            onChange={(v) => setSort(v as SortKey)}
            disabled={Boolean(q)}
            title={q ? "Search results are ordered by how well they match" : "The order the photos are shown in"}
            ariaLabel="Sort order"
            icon={<IconSort size={13} />}
            options={q ? [{ value: "relevance", label: "Best match", short: "Relevance" }] : SORT_OPTIONS}
          />
        }
      >
        {albumActions}
      </PhotoFilters>
            <div className="page-scroll">
      {q && (
        <div className="search-scope-banner">
          <span>
            Results for <strong>"{q}"</strong> in this album
            {!isLoading && images ? ` (${images.length})` : ""}
          </span>
          <button
            className="btn btn-sm ghost"
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
          <div className="filter-bar action-bar--bottom" ref={barRef}>
            <div className="control-group">
              <span>{selected.size} selected</span>
            </div>
            {/* The selection itself on the left, what is done to it on the
                right of the line. */}
            <span className="bar-sep" aria-hidden />
            <div className="control-group">
              <FlagPicker value={sharedMeta.flag} onChange={(f) => applyBulk({ flag: f })} />
              <RatingStars rating={sharedMeta.rating} onChange={(r) => applyBulk({ rating: r })} />
              <ColorLabelPicker value={sharedMeta.colorLabel} onChange={(c) => applyBulk({ color_label: c })} />
              <BulkTagInput onAdd={addTagToSelected} />
            </div>
            <div className="control-group">
              {selectionExport.button}
              <button
                className="btn"
                onClick={() => setAutoPick(Array.from(selected))}
                title="Find photos in your library that go with the selected one - by look, narrowed by tags or place"
              >
                <span className="btn-label">
                  <IconSparkle size={13} /> Find similar…
                </span>
              </button>
            </div>
            <div className="control-group">
              <AddToPicker
                onAddToAlbum={addSelectedToAlbum}
                onAddToCanvas={addSelectedToCanvas}
                onResult={reportAddTo}
              />
            </div>
            {/* Hidden in full sync mode - everything uploads automatically there.
                The whole group goes, not just the button, so no empty gap is
                left. */}
            {immichConfigured && immich?.sync_mode !== "full" && (
              <div className="control-group">
                <button
                  className="btn"
                  onClick={() => void addSelectedToImmich()}
                  disabled={immichBusy}
                  title="Upload the selected photos to your Immich server. RAW files only if enabled in Settings."
                >
                  <IconCloudUp size={13} /> {immichBusy ? "Uploading to Immich…" : "Add to Immich"}
                </button>
              </div>
            )}
            <div className="control-group">
              <EditPicker
                onAutoEdit={() => autoDevelopSelected()}
                onApplyPreset={(name) => applyPresetToSelected(name)}
                onAutoEditAndCopy={() => autoDevelopAndCopy()}
                onApplyPresetAndCopy={(name) => applyPresetAndCopy(name)}
                onAutoEditOnCopy={() => autoDevelopOnCopy()}
                onApplyPresetOnCopy={(name) => applyPresetOnCopy(name)}
                busy={developBusy}
              />
              <ResetMenu count={selected.size} onReset={resetSelected} />
              <button className="btn" onClick={() => void removeSelectedFromAlbum()}>
                <span className="btn-label"><IconMinus size={13} /> Remove from this album</span>
              </button>
            </div>
            <button
              className="btn btn-sm quiet-danger"
              style={{ marginLeft: "auto" }}
              onClick={() => void deleteSelected()}
              title="Delete the selected photos"
              aria-label="Delete the selected photos"
            >
              <IconTrash size={15} />
            </button>
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
          onSetSelection={(ids) => setSelected(new Set(ids))}
          contextActions={contextActions}
          groupByDate={!q && (sort === "newest" || sort === "oldest")}
          onRemove={removeFromAlbum}
          removeTitle="Remove from this album"
        />
      )}
      </div>
    </div>
  );
}

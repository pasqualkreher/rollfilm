import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { rememberLibraryFilters, rememberedLibraryFilters } from "../utils/libraryFilterMemory";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { CANCELLED_NOTE, pairUnits } from "../utils/batchUnits";
import { withoutMembershipNames } from "../utils/autoTags";
import { useAppDialogs } from "../components/AppDialogs";
import type {
  BulkResetOptions,
  Flag,
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
import { FlagPicker } from "../components/FlagPicker";
import { useSelectionExport } from "../components/SelectionExport";
import { AddToPicker, useAddToNotice, type AddToResult } from "../components/AddToPicker";
import { BulkTagInput } from "../components/BulkTagInput";
import { ResetMenu } from "../components/ResetMenu";
import { Dropdown } from "../components/Dropdown";
import { SORT_OPTIONS, isSortKey, rollOf, sortImages, type SortKey } from "../utils/sortOrder";
import { EditPicker } from "../components/EditPicker";
import { IconCheck, IconCloudUp, IconExport, IconImport, IconSort, IconSparkle, IconTrash, IconX } from "../components/Icons";
import { AutoPickDialog } from "../components/AutoPickDialog";
import { ExportDialog } from "../components/ExportDialog";
import { ReportProblem } from "../components/ReportProblem";
import { ImmichSyncToggle } from "../components/ImmichSyncToggle";
import { PhotoFilters } from "../components/PhotoFilters";
import { leaveSearch } from "../components/SearchBar";
import { loadPresets, presetAdjustments } from "../utils/presets";
import { useTasks, type BatchItem } from "../state/tasks";
import { collapsePairsBy, groupPairsAdjacent } from "../utils/pairing";
import { usePairDeleteConfirm } from "../components/usePairDeleteConfirm";
import { useAskSaveCopyOptions, useMergePairs } from "../state/viewPrefs";
import { FULL_COPY_QUALITY, SaveCopyDialog } from "../components/SaveCopyDialog";
import { shortcutLabel, surveyState, useSelectionKeys } from "../utils/selection";
import { useBarHeight } from "../utils/useBarHeight";
import { selectionSharedMeta } from "../utils/selectionMeta";
import type { ContextActions } from "../components/PhotoContextMenu";
import { Presence } from "../components/Presence";
import { MOTION } from "../utils/usePresence";
import { LoadingState } from "../components/Spinner";
// The JPEG options of "Apply ... and save copy".
type CopyOpts = { quality: number; maxSize: number | null };

import { errorText, failureReason } from "../utils/apiError";
import { plural } from "../utils/plural";


// The section headings of the orders that are not by date: the name's first
// character, or the stars. Module-level, so their identity is stable - the
// timeline's layout is memoised on it.
function nameSection(image: LibraryIndexImage): string {
  const first = image.original_filename.charAt(0).toUpperCase();
  return /[A-Z0-9]/.test(first) ? first : "#";
}
function ratingSection(image: LibraryIndexImage): string {
  return image.rating > 0 ? `${image.rating} ${image.rating === 1 ? "star" : "stars"}` : "No rating";
}

// Browse mode works on slim index entries (the whole library in one query),
// search mode on full rows - the shared selection/bulk handlers only touch
// the fields both carry.
type GridImage = LibraryIndexImage | ImageOut;

// Opened without a filter set (the sidebar's link, a fresh visit) while one is
// remembered from earlier in the session: go to that instead, before the page
// below mounts - so the unfiltered grid never flashes up or gets fetched.
// The one bulk task this page runs at a time (state/tasks).
const LIBRARY_BATCH = "batch:library";

export function Library() {
  const [searchParams] = useSearchParams();
  const remembered = rememberedLibraryFilters();
  if (searchParams.toString() === "" && remembered) {
    return <Navigate to={`/?${remembered}`} replace />;
  }
  return <LibraryPage />;
}

function LibraryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  // Keep the session's memory of the filter set in step with the URL (see
  // utils/libraryFilterMemory.ts) - clearing the filters clears it too.
  useEffect(() => {
    rememberLibraryFilters(searchParams);
  }, [searchParams]);

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
    // The memory has to follow in the same breath: the wrapper above reads it
    // during the very render this triggers, before the effect above has run -
    // emptying the URL (back to "RAW + JPEG", the last filter reset) would
    // otherwise be answered with a redirect to the set just left.
    rememberLibraryFilters(next);
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
  const canvasId = searchParams.get("canvas") ?? "";
  const setCanvasId = (v: string) => setParams({ canvas: v || null });
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
  const cameraMake = searchParams.get("make") ?? "";
  const setCameraMake = (v: string) => setParams({ make: v || null });
  const isoMin = searchParams.get("iso_min") ?? "";
  const isoMax = searchParams.get("iso_max") ?? "";
  const setIsoRange = (min: string, max: string) => setParams({ iso_min: min || null, iso_max: max || null });
  const apertureMin = searchParams.get("aperture_min") ?? "";
  const apertureMax = searchParams.get("aperture_max") ?? "";
  const setApertureRange = (min: string, max: string) =>
    setParams({ aperture_min: min || null, aperture_max: max || null });
  const shutterMin = searchParams.get("shutter_min") ?? "";
  const shutterMax = searchParams.get("shutter_max") ?? "";
  const setShutterRange = (min: string, max: string) =>
    setParams({ shutter_min: min || null, shutter_max: max || null });
  const dateFrom = searchParams.get("from");
  const setDateFrom = (v: string | null) => setParams({ from: v });
  const dateTo = searchParams.get("to");
  const setDateTo = (v: string | null) => setParams({ to: v });
  // Only the photos whose file the sync could not find (Settings → Library →
  // Missing files → Show in Library). Cleared from its own chip in the bar.
  const missingOnly = searchParams.get("missing") === "1";
  const setMissingOnly = (v: boolean) => setParams({ missing: v ? "1" : null });
  // The culling flag filter: "pick", "reject", "unflagged" or "" for any.
  const flagFilter = searchParams.get("flag") ?? "";
  const setFlagFilter = (v: string) => setParams({ flag: v || null });
  // One day of imports ("YYYY-MM-DD"): the Import page's "Show in Library".
  const importedDay = searchParams.get("imported") ?? "";
  const setImportedDay = (v: string) => setParams({ imported: v || null });
  // One roll (import session): the contact sheet's "Open in Library".
  const rollId = searchParams.get("roll") ?? "";
  const setRollId = (v: string) => setParams({ roll: v || null });
  // A country (reverse-geocoded), or "__none__" for photos without a place:
  // Statistics' "Show in library" and the map land here.
  const country = searchParams.get("country") ?? "";
  const setCountry = (v: string) => setParams({ country: v || null });
  const photoState = searchParams.get("state") ?? "";
  const setPhotoState = (v: string) => setParams({ state: v || null });
  // In the URL like the filters, so it survives the trip into a photo and back.
  const sortParam = searchParams.get("sort");
  const sort: SortKey = isSortKey(sortParam) ? sortParam : "newest";
  const setSort = (v: SortKey) => setParams({ sort: v === "newest" ? null : v });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const barRef = useBarHeight();
  // Back from the survey: its photos are the selection again.
  const location = useLocation();
  useEffect(() => {
    const reselect = (location.state as { reselect?: string[] } | null)?.reselect;
    if (!reselect) return;
    setSelected(new Set(reselect));
    navigate(location.pathname + location.search, { replace: true, state: null });
  }, [location.state]); // eslint-disable-line react-hooks/exhaustive-deps
  // Export for the selection: the bar's button, the dialog, ⇧⌘E.
  const selectionExport = useSelectionExport(Array.from(selected));
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const mergePairs = useMergePairs();
  const { dialog: pairDeleteDialog, confirmDelete } = usePairDeleteConfirm();
  const q = (searchParams.get("q") ?? "").trim();

  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });
  const { data: canvases } = useQuery({ queryKey: ["canvas-list"], queryFn: () => api.canvases.list() });
  const { data: allTags } = useQuery({
    queryKey: ["tags"],
    queryFn: () => api.tags.list(),
    // Album / canvas membership has its own filter above; the name tags
    // behind it stay out of the tag list.
    select: withoutMembershipNames,
  });

  // "Add to Immich" only appears when the integration is configured in Settings.
  const { data: immich } = useQuery({ queryKey: ["immich-settings"], queryFn: () => api.settings.getImmich() });
  const immichConfigured = Boolean(immich?.base_url && immich?.api_key_set && immich.enabled);
  const [immichBusy, setImmichBusy] = useState(false);
  const [developBusy, setDevelopBusy] = useState(false);

  const { runTask, trackRenders, trackCopyJob, runBatches, hasTask, pushUndo, notify } = useTasks();
  // What a bulk action leaves behind - "Added tag “x” to 12 photos.", an
  // Immich reply, a failure - stands in the title bar's task dock for a
  // moment; a failure stays until dismissed or the next outcome replaces it.
  const report = (text: string) => notify({ label: text });
  const reportError = (text: string) => notify({ label: text, error: true });
  const addToNotice = useAddToNotice();
  // Every bulk action of this page runs as one task in the title bar, counted
  // down there with a Stop, and one at a time: the develop picker is off while
  // one runs, and a second one started regardless is refused (TaskBusyError).
  // The grid stays usable meanwhile - selection is by id, so what the user
  // picks while a batch runs is never confused with what the batch handles.
  const batchBusy = hasTask(LIBRARY_BATCH);
  // quiet: stars, flags and tags - out of the dock unless they take a while.
  const batch = <R,>(label: string, items: BatchItem[], run: (ids: string[]) => Promise<R>, quiet = false) =>
    runBatches({ id: LIBRARY_BATCH, kind: "batch", label, quiet }, items, run);
  const askSaveCopyOptions = useAskSaveCopyOptions();
  // The options dialog of "Apply ... and save copy", resolved by its answer.
  const [copyPrompt, setCopyPrompt] = useState<{ resolve: (opts: CopyOpts | null) => void } | null>(null);

  const filters: LibraryFilters = {
    view_mode: viewMode,
    rating_min: ratingMin || undefined,
    color_label: colorLabel !== "none" ? colorLabel : undefined,
    album_id: albumId || undefined,
    canvas_id: canvasId || undefined,
    tags: selectedTags.length ? selectedTags : undefined,
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
    // Capture-date range from the date pickers: include the whole "from" day
    // through the end of the "to" day.
    date_from: dateFrom ? `${dateFrom}T00:00:00` : undefined,
    date_to: dateTo ? `${dateTo}T23:59:59` : undefined,
    missing: missingOnly || undefined,
    flag: flagFilter || undefined,
    imported: importedDay || undefined,
    roll: rollId || undefined,
    country: country || undefined,
    state: photoState || undefined,
  };

  // The rolls' names, for the "By roll" sections and the roll chip.
  const { data: rolls } = useQuery({
    queryKey: ["import-sessions", "committed"],
    queryFn: () => api.import.sessions("committed"),
    enabled: sort === "roll" || !!rollId,
  });
  const rollNames = useMemo(() => new Map((rolls ?? []).map((s) => [s.id, s.source_path])), [rolls]);
  // Memoised like nameSection: the timeline's layout is keyed on its identity.
  const rollSection = useMemo(
    () => (image: LibraryIndexImage) => {
      const roll = rollOf(image);
      return roll ? rollNames.get(roll) ?? "Roll" : "No roll";
    },
    [rollNames]
  );

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
  // A load that failed is not an empty library, and must not be shown as one.
  // (A failed REFETCH keeps the grid it already had - that is not this.)
  const activeQuery = q ? searchQuery : indexQuery;
  const loadFailed = activeQuery.isError && !images;
  // Anything narrowing the view, so "nothing here" can say why and offer the
  // way out.
  const isFiltering =
    viewMode !== "combined" ||
    ratingMin > 0 ||
    colorLabel !== "none" ||
    Boolean(albumId || canvasId || camera || lens || focalMin || focalMax || dateFrom || dateTo) ||
    Boolean(cameraMake || isoMin || isoMax || apertureMin || apertureMax || shutterMin || shutterMax) ||
    selectedTags.length > 0;
  function clearFilters() {
    setParams({
      view: null,
      rating: null,
      color: null,
      album: null,
      canvas: null,
      tag: null,
      camera: null,
      lens: null,
      focal_min: null,
      focal_max: null,
      make: null,
      iso_min: null,
      iso_max: null,
      aperture_min: null,
      aperture_max: null,
      shutter_min: null,
      shutter_max: null,
      from: null,
      to: null,
    });
  }

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
  // The chosen order, made before the pairs are put together so a pair still
  // ends up side by side. Search results keep their ranking.
  const sortedImages: GridImage[] = useMemo(() => {
    const list = images ?? [];
    return q ? list : sortImages(list, sort);
  }, [images, q, sort]);
  const orderedImages: GridImage[] = useMemo(
    () =>
      viewMode === "combined"
        ? mergePairs
          ? collapsePairsBy(sortedImages, (img) => img.file_type, (img) => img.paired_image_id)
          : groupPairsAdjacent(sortedImages, (img) => img.file_type, (img) => img.paired_image_id)
        : sortedImages,
    [sortedImages, viewMode, mergePairs]
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

  // Click = toggle; shift-click = apply the toggle to the whole range since
  // the last click, like Finder/Photos - selects a long run of photos fast,
  // and deselects the run again when the clicked photo is already selected.
  function toggleSelect(id: string, index: number, shiftKey: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastIndex !== null) {
        const deselect = next.has(id);
        const [start, end] = lastIndex < index ? [lastIndex, index] : [index, lastIndex];
        for (let i = start; i <= end; i++) {
          if (deselect) next.delete(orderedImages[i].id);
          else next.add(orderedImages[i].id);
        }
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

  // A rubber band's result (utils/useMarquee): the whole selection at once.
  function setSelection(ids: string[]) {
    if (ids.length === 0) {
      clearSelection();
      return;
    }
    setSelected(new Set(ids));
  }

  // Cmd/Ctrl+A picks the whole (filtered) grid, Escape drops the selection,
  // E opens a single selected photo in the editor.
  useSelectionKeys({
    onSelectAll: selectAll,
    onClear: clearSelection,
    hasSelection: selected.size > 0,
    edit: { selected, order: orderedImages.map((img) => img.id) },
    survey: { selected, order: orderedImages.map((img) => img.id), returnTo: location.pathname + location.search },
    onRate: (rating) => void applyBulk({ rating }),
    // The key of the colour the selection already has takes it off again.
    onColor: (label) =>
      void applyBulk({
        color_label: selectionSharedMeta(images ?? [], selected).colorLabel === label ? "none" : label,
      }),
    // A / X set the flag, U takes it off; the key of the flag the selection
    // already has takes it off too.
    onFlag: (flag) =>
      void applyBulk({ flag: flag && selectionSharedMeta(images ?? [], selected).flag === flag ? "" : flag }),
    onDelete: () => void deleteSelected(),
    onExport: () => selectionExport.open(),
  });

  async function applyBulk(
    patch: { rating?: number; color_label?: ColorLabel; flag?: Flag | "" },
    target: Iterable<string> = selected
  ) {
    const ids = new Set(target);
    if (ids.size === 0) return;
    // What the tiles get: the flag "" (taken off) is null on a tile.
    const { flag: flagPatch, ...restPatch } = patch;
    const tilePatch = flagPatch === undefined ? restPatch : { ...restPatch, flag: (flagPatch || null) as Flag | null };
    // When pairs are merged the grid only shows the JPEG, so fan the change out
    // to each hidden RAW partner too.
    // Onto the tiles slice by slice, without waiting for the whole index to
    // come back (megabytes on a big library). The refetch below then finds
    // what it expected and changes nothing.
    const show = (changed: Iterable<string>) => {
      const set = new Set(changed);
      queryClient.setQueriesData<{ images: LibraryIndexImage[] }>({ queryKey: ["images", "index"] }, (old) =>
        old ? { ...old, images: old.images.map((im) => (set.has(im.id) ? { ...im, ...tilePatch } : im)) } : old
      );
    };
    try {
      // One photo is one quick request and no task: culling from the keyboard
      // - a star, then the arrow to the next photo - must not wait on it.
      if (ids.size === 1) {
        await api.images.bulkUpdate(Array.from(ids), patch);
        show(ids);
      } else {
        await batch("Updating photos…", Array.from(ids), async (slice) => {
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
    // In merged view only the JPEG is shown, so a delete takes the hidden RAW
    // partner with it by default - a pair is one shot. The "ask what to delete"
    // setting lets the user keep the partners.
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
          queryClient.setQueriesData<{ images: LibraryIndexImage[] }>({ queryKey: ["images", "index"] }, (old) =>
            old ? { ...old, images: old.images.filter((im) => !gone.has(im.id)) } : old
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
      // Otherwise the deleted photos leave the selection - read as it is now,
      // not as it was when this started: the user may have picked more
      // meanwhile. Nothing left: the bar goes too.
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
      queryClient.invalidateQueries({ queryKey: ["trash"] });
      // Trashing or restoring photos changes which tags live photos carry.
      queryClient.invalidateQueries({ queryKey: ["tags"] });
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

  // The right-click menu's add: the same report as the bar's picker, which
  // the menu has no part in.
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

  // The Find similar dialog's add: the dialog closes on success so the dock's
  // line (and its Open link) is in reach - the modal covers the title bar.
  // A failure keeps the dialog open and says so in its footer.
  function reportPickAddTo(result: AddToResult, count: number, close: () => void, note: (text: string, error: boolean) => void) {
    if (result.ok) {
      reportAddTo(result, count);
      close();
    } else note(`Could not add to ${result.kind === "canvas" ? "canvas " : ""}“${result.name}”.`, true);
  }

  async function addSelectedToAlbum(albumId: string, target: string[] = Array.from(selected)) {
    if (target.length === 0) return;
    const targetSet = new Set(target);
    // In merged view the RAW partner is hidden behind the JPEG card - add it
    // too, so the album holds the whole shot and its own merge toggle works.
    const byId = new Map((images ?? []).map((im) => [im.id, im]));
    const units = pairUnits(withPairedIds(target), (x) => byId.get(x)?.paired_image_id);
    try {
      const { done, cancelled } = await batch("Adding photos to album…", units, (slice) =>
        api.albums.addImages(albumId, slice)
      );
      partialAddRef.current = cancelled ? done.filter((x) => targetSet.has(x)).length : null;
    } finally {
      queryClient.invalidateQueries({ queryKey: ["albums"] });
    }
  }

  // The right-click menu's hands on the photos under the pointer (or the
  // selection they belong to): the same actions as the bulk bar, by id.
  // Auto pick: the dialog's reference set (ids of this page's photos), and the
  // export it may end in.
  const [autoPick, setAutoPick] = useState<string[] | null>(null);
  const [pickExport, setPickExport] = useState<string[] | null>(null);
  const contextActions: ContextActions = {
    onAutoPick: (ids) => setAutoPick(ids),
    onSurvey: (ids) =>
      navigate("/survey", {
        state: surveyState(ids, orderedImages.map((img) => img.id), location.pathname + location.search),
      }),
    onRate: (ids, rating) => applyBulk({ rating }, ids),
    onColor: (ids, label) => applyBulk({ color_label: label }, ids),
    onFlag: (ids, flag) => applyBulk({ flag }, ids),
    onAddToAlbum: (ids, albumId, name) => addFromMenu("album", albumId, name, ids),
    onAddToCanvas: (ids, canvasId, name) => addFromMenu("canvas", canvasId, name, ids),
    onAddTag: (ids, name) => addTagToSelected(name, ids),
    onAutoEdit: (ids, copy) => (copy ? autoDevelopAndCopy(ids) : autoDevelopSelected(undefined, ids)),
    onApplyPreset: (ids, name, copy) => (copy ? applyPresetAndCopy(name, ids) : applyPresetToSelected(name, undefined, ids)),
    presets: () => Object.keys(loadPresets()),
    onReset: (ids, opts) => resetSelected(opts, ids),
    // The same row the bar shows: the sync tick in selective mode, "Add to
    // Immich" in manual mode, nothing in full mode or while an upload runs.
    immich: (ids) => {
      if (!immichConfigured || immichBusy) return null;
      if (immich?.sync_mode === "selective") {
        const on = allSynced(new Set(ids));
        return { label: "Sync to Immich", checked: on, run: () => toggleSelectedImmichSync(!on, ids) };
      }
      if (immich?.sync_mode === "manual") return { label: "Add to Immich", run: () => addSelectedToImmich(ids) };
      return null;
    },
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
    // Awaited: the reset is only reported once the grid actually holds the
    // reset rows. The re-rendered pictures don't hold it up - the backend
    // renders those in the background and their tiles shimmer until they land.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["images"] }),
      queryClient.invalidateQueries({ queryKey: ["tags"] }),
      queryClient.invalidateQueries({ queryKey: ["albums"] }),
    ]);
  }

  // Auto-develop every selected photo (each learns its own suggestion). Photos
  // with no embedding yet, or nothing similar to learn from, are skipped.
  async function autoDevelopSelected(copyOpts?: CopyOpts, target: string[] = Array.from(selected)) {
    if (target.length === 0) return;
    const targetSet = new Set(target);
    const editedCount = (images ?? []).filter(
      (im) => targetSet.has(im.id) && (im as ImageOut).edit_rev
    ).length;
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
      queryClient.invalidateQueries({ queryKey: ["tags"] });
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
    const editedCount = (images ?? []).filter(
      (im) => targetSet.has(im.id) && (im as ImageOut).edit_rev
    ).length;
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
      queryClient.invalidateQueries({ queryKey: ["tags"] });
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

  async function askCopyOptions(): Promise<CopyOpts | null> {
    if (!askSaveCopyOptions) return { quality: FULL_COPY_QUALITY, maxSize: null };
    return new Promise((resolve) => setCopyPrompt({ resolve }));
  }

  async function autoDevelopAndCopy(target?: string[]) {
    const opts = await askCopyOptions();
    if (opts) await autoDevelopSelected(opts, target);
  }

  async function applyPresetAndCopy(name: string, target?: string[]) {
    const opts = await askCopyOptions();
    if (opts) await applyPresetToSelected(name, opts, target);
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

  // Selective sync: the checkbox flags/unflags the whole selection - flagged
  // photos upload in the background and stay marked as synced; unflagging
  // stops syncing them but leaves what's already on Immich alone.
  async function toggleSelectedImmichSync(enabled: boolean, target: string[] = Array.from(selected)) {
    if (target.length === 0) return;
    setImmichBusy(true);
    try {
      const updated = await api.images.setImmichSync(target, enabled);
      report(
        enabled
          ? `${plural(updated.length, "photo")} marked for Immich sync. Uploading in the background.`
          : `Stopped syncing ${plural(updated.length, "photo")} to Immich.`
      );
      queryClient.invalidateQueries({ queryKey: ["images"] });
    } catch (e) {
      reportError(errorText(e));
    } finally {
      setImmichBusy(false);
    }
  }

  // Checked when every selected photo is flagged - so ticking it flags the
  // rest, and unticking always unflags everything selected.
  function allSynced(ids: Set<string>): boolean {
    return ids.size > 0 && (images ?? []).filter((im) => ids.has(im.id)).every((im) => im.immich_sync);
  }
  const allSelectedSynced = allSynced(selected);

  // Scans the whole library to find what the selection has in common, so it is
  // memoised on the two things it actually reads - not re-run for every
  // unrelated render of this page.
  const sharedMeta = useMemo(() => selectionSharedMeta(images ?? [], selected), [images, selected]);

  return (
    <div className="page page-timeline">
      {pairDeleteDialog}
      {selectionExport.dialog}
      <Presence open={autoPick !== null} ms={MOTION.modal}>
        {autoPick && (
          <AutoPickDialog
            references={autoPick
              .map((id) => (images ?? []).find((im) => im.id === id))
              .filter((im): im is LibraryIndexImage => !!im)}
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
                    setSelected(new Set(chosen));
                    close();
                  }}
                  title="Select these photos in the library; every action of the bar then works on them"
                >
                  Select {chosen.length > 0 ? chosen.length : ""} in library
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
            physicalOnly
            askOptions
            count={selected.size}
            title={`Apply and save copy of ${selected.size} ${selected.size === 1 ? "photo" : "photos"}`}
            onClose={() => {
              copyPrompt.resolve(null);
              setCopyPrompt(null);
            }}
            onSave={(req) => {
              copyPrompt.resolve(req.kind === "physical" ? { quality: req.quality, maxSize: req.maxSize } : null);
              setCopyPrompt(null);
            }}
          />
        )}
      </Presence>
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
        canvases={canvases}
        canvasId={canvasId}
        onCanvasId={setCanvasId}
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
        flag={flagFilter}
        onFlag={setFlagFilter}
        photoState={photoState}
        onPhotoState={setPhotoState}
        extra={
          <>
            {missingOnly && (
              <button
                type="button"
                className="tag-filter-btn active"
                onClick={() => setMissingOnly(false)}
                title="Showing only the photos whose file was not found. Click to show the whole library again."
              >
                <span className="tag-filter-btn-label">Missing files</span>
                <span className="tag-filter-caret">
                  <IconX size={11} />
                </span>
              </button>
            )}
            {country && (
              <button
                type="button"
                className="tag-filter-btn active"
                onClick={() => setCountry("")}
                title="Showing only the photos from this country. Click to show the whole library again."
              >
                <span className="tag-filter-btn-label">{country === "__none__" ? "No location" : country}</span>
                <span className="tag-filter-caret">
                  <IconX size={11} />
                </span>
              </button>
            )}
            {importedDay && (
              <button
                type="button"
                className="tag-filter-btn active"
                onClick={() => setImportedDay("")}
                title="Showing only the photos imported on this day. Click to show the whole library again."
              >
                <span className="tag-filter-btn-label">Imported {importedDay}</span>
                <span className="tag-filter-caret">
                  <IconX size={11} />
                </span>
              </button>
            )}
            {rollId && (
              <button
                type="button"
                className="tag-filter-btn active"
                onClick={() => setRollId("")}
                title="Showing only the photos of this roll. Click to show the whole library again."
              >
                <span className="tag-filter-btn-label">Roll: {rollNames.get(rollId) ?? "…"}</span>
                <span className="tag-filter-caret">
                  <IconX size={11} />
                </span>
              </button>
            )}
            {/* The rejects on screen, to the Trash in one go: what the reject
                flag is for. The same confirmation as any delete. */}
            {flagFilter === "reject" && orderedImages.length > 0 && !q && (
              <button
                type="button"
                className="btn btn-sm quiet-danger"
                onClick={() => void deleteSelected(orderedImages.map((im) => im.id))}
                title="Move every rejected photo shown here to the Trash"
              >
                Trash {orderedImages.length} rejected
              </button>
            )}
          </>
        }
        sort={
          // Search results are ranked by how well they match, so there the
          // control says so and rests - in place, rather than disappearing.
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
      </PhotoFilters>
      <div className="page-scroll">
      {q && (
        <div className="search-scope-banner">
          <span>
            Results for <strong>"{q}"</strong> in this view
            {!isLoading && images ? ` (${images.length})` : ""}
          </span>
          <button
            className="btn btn-sm ghost"
            onClick={() => leaveSearch(navigate, () => setParams({ q: null }))}
          >
            Clear search
          </button>
        </div>
      )}
      <Presence open={selected.size > 0} ms={MOTION.bar}>
        {selected.size > 0 && (
          // Related controls are grouped so a narrow window wraps whole groups
          // to the next line instead of splitting them mid-cluster. The bar's
          // height feeds the grid's foot room (useBarHeight).
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
            {immichConfigured && (immich?.sync_mode === "selective" || immich?.sync_mode === "manual") && (
              <div className="control-group">
                {immich?.sync_mode === "selective" && (
                  <ImmichSyncToggle
                    on={allSelectedSynced}
                    disabled={immichBusy}
                    onToggle={toggleSelectedImmichSync}
                    title="Upload the selected photos to Immich in the background. RAW files only if enabled in Settings. Press again to stop."
                  />
                )}
                {/* Manual mode only: selective shows the sync checkbox instead, and
                    in full mode everything uploads automatically anyway. */}
                {immich?.sync_mode === "manual" && (
                  <button
                    className="btn"
                    onClick={() => void addSelectedToImmich()}
                    disabled={immichBusy}
                    title="Upload the selected photos to your Immich server. RAW files only if enabled in Settings."
                  >
                    <IconCloudUp size={13} /> {immichBusy ? "Uploading to Immich…" : "Add to Immich"}
                  </button>
                )}
              </div>
            )}
            <div className="control-group">
              <EditPicker
                onAutoEdit={() => autoDevelopSelected()}
                onApplyPreset={(name) => applyPresetToSelected(name)}
                onAutoEditAndCopy={autoDevelopAndCopy}
                onApplyPresetAndCopy={applyPresetAndCopy}
                busy={developBusy || batchBusy}
              />
              <ResetMenu count={selected.size} onReset={resetSelected} />
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
      ) : loadFailed ? (
        <div className="empty-state" role="alert">
          <div>The photos could not be loaded.</div>
          <div className="empty-state-detail">{failureReason(activeQuery.error)}</div>
          <button className="btn empty-state-action" onClick={() => void activeQuery.refetch()}>
            Try again
          </button>
          {/* Still failing: say so where it can be read, with the log at hand. */}
          <div className="empty-state-report">
            <ReportProblem title="Photos could not be loaded" compact />
          </div>
        </div>
      ) : orderedImages.length === 0 && !q && !isFiltering ? (
        /* A library with nothing in it: the next step, not a shrug. */
        <div className="empty-state empty-state--welcome">
          <IconImport size={28} />
          <div className="empty-state-title">Your library is empty</div>
          <button className="btn primary" onClick={() => navigate("/import")}>
            <IconImport size={13} /> Import photos
          </button>
          <div className="empty-state-detail">…or drop a card or folder anywhere on this window.</div>
        </div>
      ) : orderedImages.length === 0 && (q || isFiltering) ? (
        <div className="empty-state">
          <div>{q ? `No photos match “${q}” in this view.` : "No photos match these filters."}</div>
          {isFiltering && (
            <button className="btn empty-state-action" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      ) : q ? (
        <ThumbnailGrid
          images={orderedImages as ImageOut[]}
          selectedIds={selected}
          onToggleSelect={toggleSelect}
          onSelectOnly={selectOnly}
          onSetSelection={setSelection}
          contextActions={contextActions}
          groupByDate={false}
        />
      ) : (
        <VirtualTimeline
          images={orderedImages as LibraryIndexImage[]}
          selectedIds={selected}
          onToggleSelect={toggleSelect}
          onSelectOnly={selectOnly}
          onSetSelection={setSelection}
          contextActions={contextActions}
          // Changing a FILTER jumps to the top of the (new) result set - the
          // old scroll position pointed into a different library and landed
          // somewhere arbitrary. view_mode is deliberately not part of the key:
          // switching combined/RAW/JPEG shows the same photos and keeps its
          // position via the timeline's re-anchoring.
          sectionLabel={
            sort === "name" ? nameSection : sort === "rating" ? ratingSection : sort === "roll" ? rollSection : undefined
          }
          resetKey={JSON.stringify([
            sort,
            ratingMin,
            colorLabel,
            albumId,
            canvasId,
            selectedTags,
            camera,
            lens,
            focalMin,
            focalMax,
            cameraMake,
            isoMin,
            isoMax,
            apertureMin,
            apertureMax,
            shutterMin,
            shutterMax,
            dateFrom,
            dateTo,
          ])}
        />
      )}
      </div>
    </div>
  );
}

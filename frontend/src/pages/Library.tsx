import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { rememberLibraryFilters, rememberedLibraryFilters } from "../utils/libraryFilterMemory";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { CANCELLED_NOTE, pairUnits } from "../utils/batchUnits";
import { withoutMembershipNames } from "../utils/autoTags";
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
import { AddToPicker, type AddToResult } from "../components/AddToPicker";
import { BulkTagInput } from "../components/BulkTagInput";
import { ResetMenu } from "../components/ResetMenu";
import { Dropdown } from "../components/Dropdown";
import { EditPicker } from "../components/EditPicker";
import { IconCloudUp, IconTrash } from "../components/Icons";
import { ImmichSyncToggle } from "../components/ImmichSyncToggle";
import { PhotoFilters } from "../components/PhotoFilters";
import { loadPresets, presetAdjustments } from "../utils/presets";
import { useSelects } from "../state/selects";
import { useTasks } from "../state/tasks";
import { useWait } from "../state/wait";
import { collapsePairsBy, groupPairsAdjacent } from "../utils/pairing";
import { usePairDeleteConfirm } from "../components/usePairDeleteConfirm";
import { useMergePairs } from "../state/viewPrefs";
import { modKeyLabel, useSelectionKeys } from "../utils/selection";
import { selectionSharedMeta } from "../utils/selectionMeta";
import { useTransientMessage, useTransientValue } from "../utils/transientMessage";
import { Presence } from "../components/Presence";
import { MOTION } from "../utils/usePresence";
import { LoadingState } from "../components/Spinner";
import { ActionBarMessages } from "../components/ActionBarMessages";
import { errorText, failureReason } from "../utils/apiError";

// How the browsed library is ordered. The server sends it newest first; the
// other orders are made here from the same index, which carries the name and
// the stars of every photo anyway.
type SortKey = "newest" | "oldest" | "name" | "rating";
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "File name" },
  { value: "rating", label: "Rating" },
];
const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

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
  const dateFrom = searchParams.get("from");
  const setDateFrom = (v: string | null) => setParams({ from: v });
  const dateTo = searchParams.get("to");
  const setDateTo = (v: string | null) => setParams({ to: v });
  // In the URL like the filters, so it survives the trip into a photo and back.
  const sortParam = searchParams.get("sort");
  const sort: SortKey = SORT_OPTIONS.some((o) => o.value === sortParam) ? (sortParam as SortKey) : "newest";
  const setSort = (v: SortKey) => setParams({ sort: v === "newest" ? null : v });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const { withBatches } = useWait();
  const selects = useSelects();
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
  // Both flash messages auto-dismiss after a moment.
  const [immichMsg, setImmichMsg] = useTransientMessage();
  const [developBusy, setDevelopBusy] = useState(false);
  const [developMsg, setDevelopMsg] = useTransientMessage();
  // Adding to an album is otherwise invisible (the dropdown just snaps back to
  // its placeholder), so confirm it in the action bar's message row - same place
  // the tag note appears. Carries its own error flag since a failed add must not
  // read like a success.
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
  // ends up side by side. Search results keep their ranking. Array.sort is
  // stable: within one rating the photos stay newest first.
  const sortedImages: GridImage[] = useMemo(() => {
    const list = images ?? [];
    if (q || sort === "newest") return list;
    if (sort === "oldest") return [...list].reverse();
    if (sort === "name") return [...list].sort((a, b) => NAME_ORDER.compare(a.original_filename, b.original_filename));
    return [...list].sort((a, b) => b.rating - a.rating);
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
    // The bar goes with the selection - and must not come back later with
    // an old failure still written on it.
    dismissMessages();
  }

  // Cmd/Ctrl+A picks the whole (filtered) grid, Escape drops the selection,
  // E opens a single selected photo in the editor.
  useSelectionKeys({
    onSelectAll: selectAll,
    onClear: clearSelection,
    hasSelection: selected.size > 0,
    edit: { selected, order: orderedImages.map((img) => img.id) },
    onRate: (rating) => void applyBulk({ rating }),
    // The key of the colour the selection already has takes it off again.
    onColor: (label) =>
      void applyBulk({
        color_label: selectionSharedMeta(images ?? [], selected).colorLabel === label ? "none" : label,
      }),
    onDelete: () => void deleteSelected(),
  });

  async function applyBulk(patch: { rating?: number; color_label?: ColorLabel }) {
    if (selected.size === 0) return;
    const ids = new Set(selected);
    // When pairs are merged the grid only shows the JPEG, so fan the change out
    // to each hidden RAW partner too.
    try {
      // One photo is one quick request and gets no wait popup: the popup
      // holds every key while it is up, and culling from the keyboard - a
      // star, then the arrow to the next photo - must not lose the arrow.
      if (ids.size === 1) await api.images.bulkUpdate(Array.from(ids), patch);
      else await withBatches("Updating photos…", Array.from(ids), (slice) => api.images.bulkUpdate(slice, patch));
      // Onto the tiles at once, without waiting for the whole index to come
      // back (megabytes on a big library). The refetch below then finds what
      // it expected and changes nothing.
      queryClient.setQueriesData<{ images: LibraryIndexImage[] }>({ queryKey: ["images", "index"] }, (old) =>
        old ? { ...old, images: old.images.map((im) => (ids.has(im.id) ? { ...im, ...patch } : im)) } : old
      );
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
      queryClient.invalidateQueries({ queryKey: ["trash"] });
      // Trashing or restoring photos changes which tags live photos carry.
      queryClient.invalidateQueries({ queryKey: ["tags"] });
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

  async function addSelectedToAlbum(albumId: string) {
    if (selected.size === 0) return;
    // In merged view the RAW partner is hidden behind the JPEG card - add it
    // too, so the album holds the whole shot and its own merge toggle works.
    const byId = new Map((images ?? []).map((im) => [im.id, im]));
    const units = pairUnits(withPairedIds(Array.from(selected)), (x) => byId.get(x)?.paired_image_id);
    try {
      const { done, cancelled } = await withBatches("Adding photos to album…", units, (slice) =>
        api.albums.addImages(albumId, slice)
      );
      partialAddRef.current = cancelled ? done.filter((x) => selected.has(x)).length : null;
    } finally {
      queryClient.invalidateQueries({ queryKey: ["albums"] });
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
    // Awaited: the wait popup has to stay up until the grid actually holds the
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
  async function autoDevelopSelected() {
    if (selected.size === 0) return;
    const editedCount = (images ?? []).filter(
      (im) => selected.has(im.id) && (im as ImageOut).edit_rev
    ).length;
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
      queryClient.invalidateQueries({ queryKey: ["tags"] });
    } catch (e) {
      setBarError(errorText(e));
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
      queryClient.invalidateQueries({ queryKey: ["tags"] });
    } catch (e) {
      setBarError(errorText(e));
    } finally {
      setDevelopBusy(false);
    }
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

  // Selective sync: the checkbox flags/unflags the whole selection - flagged
  // photos upload in the background and stay marked as synced; unflagging
  // stops syncing them but leaves what's already on Immich alone.
  async function toggleSelectedImmichSync(enabled: boolean) {
    if (selected.size === 0) return;
    setImmichBusy(true);
    setImmichMsg(null);
    setBarError(null);
    try {
      const updated = await api.images.setImmichSync(Array.from(selected), enabled);
      setImmichMsg(
        enabled
          ? `${updated.length} photo(s) marked for Immich sync. Uploading in the background.`
          : `Stopped syncing ${updated.length} photo(s) to Immich.`
      );
      queryClient.invalidateQueries({ queryKey: ["images"] });
    } catch (e) {
      setBarError(errorText(e));
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
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFrom={setDateFrom}
        onDateTo={setDateTo}
        viewExtras={
          // Search results are ranked by how well they match, so there the
          // control says so and rests - in place, rather than disappearing.
          <Dropdown
            className="sort-dropdown"
            value={q ? "relevance" : sort}
            onChange={(v) => setSort(v as SortKey)}
            disabled={Boolean(q)}
            title={q ? "Search results are ordered by how well they match" : "The order the photos are shown in"}
            ariaLabel="Sort order"
            options={q ? [{ value: "relevance", label: "Best match" }] : SORT_OPTIONS}
          />
        }
      >
        {/* Both only once a photo is picked (Cmd/Ctrl-click) - the toolbar
            stays clean while nothing is selected; Cmd/Ctrl+A works anytime. */}
        {selected.size > 0 && (
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
      <Presence open={selected.size > 0} ms={MOTION.bar}>
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
                onAddToSelects={() => selects.add(Array.from(selected))}
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
                    title="Upload the selected photos to Immich in the background. RAW files only when “Also upload RAW files” is on in Settings. Press again to stop syncing them."
                  />
                )}
                {/* Manual mode only: selective shows the sync checkbox instead, and
                    in full mode everything uploads automatically anyway. */}
                {immich?.sync_mode === "manual" && (
                  <button
                    className="btn"
                    onClick={addSelectedToImmich}
                    disabled={immichBusy}
                    title="Upload the selected photos to your Immich server. RAW files only when “Also upload RAW files” is on in Settings."
                  >
                    <IconCloudUp size={13} /> {immichBusy ? "Uploading to Immich…" : "Add to Immich"}
                  </button>
                )}
              </div>
            )}
            <div className="control-group">
              <EditPicker
                onAutoEdit={autoDevelopSelected}
                onApplyPreset={applyPresetToSelected}
                busy={developBusy}
              />
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
      ) : loadFailed ? (
        <div className="empty-state" role="alert">
          <div>The photos could not be loaded.</div>
          <div className="empty-state-detail">{failureReason(activeQuery.error)}</div>
          <button className="btn empty-state-action" onClick={() => void activeQuery.refetch()}>
            Try again
          </button>
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
          groupByDate={false}
        />
      ) : (
        <VirtualTimeline
          images={orderedImages as LibraryIndexImage[]}
          selectedIds={selected}
          onToggleSelect={toggleSelect}
          onSelectOnly={selectOnly}
          // Changing a FILTER jumps to the top of the (new) result set - the
          // old scroll position pointed into a different library and landed
          // somewhere arbitrary. view_mode is deliberately not part of the key:
          // switching combined/RAW/JPEG shows the same photos and keeps its
          // position via the timeline's re-anchoring.
          sectionLabel={sort === "name" ? nameSection : sort === "rating" ? ratingSection : undefined}
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
            dateFrom,
            dateTo,
          ])}
        />
      )}
      </div>
    </div>
  );
}

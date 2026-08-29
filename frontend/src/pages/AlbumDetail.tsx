import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAppDialogs } from "../components/AppDialogs";
import type { BulkResetOptions, ColorLabel, ImageOut, LibraryFilters, ViewMode } from "../api/types";
import { ThumbnailGrid } from "../components/ThumbnailGrid";
import { TagFilter } from "../components/TagFilter";
import { RatingStars } from "../components/RatingStars";
import { ColorLabelPicker } from "../components/ColorLabelPicker";
import { AlbumPicker } from "../components/AlbumPicker";
import { AlbumNameField } from "../components/AlbumNameField";
import { BulkTagInput } from "../components/BulkTagInput";
import { ResetMenu } from "../components/ResetMenu";
import { IconArrowLeft, IconPencil, IconTrash } from "../components/Icons";
import { PhotoFilters } from "../components/PhotoFilters";
import { Dropdown } from "../components/Dropdown";
import { loadPresets } from "../utils/presets";
import { useSelects } from "../state/selects";
import { useTasks } from "../state/tasks";
import { useWait } from "../state/wait";
import { usePairDeleteConfirm } from "../components/usePairDeleteConfirm";
import { collapsePairs } from "../state/viewPrefs";
import { selectionSharedMeta } from "../utils/selectionMeta";
import { useTransientMessage, useTransientValue } from "../utils/transientMessage";

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
  const dialogs = useAppDialogs();
  const { withWait } = useWait();
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

  const { data: allTags } = useQuery({ queryKey: ["tags"], queryFn: () => api.tags.list() });

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
  }

  async function applyBulk(patch: { rating?: number; color_label?: string }) {
    if (selected.size === 0) return;
    // With merged pairs only the JPEG is visible, so mirror the change to each
    // hidden RAW partner too.
    await withWait(`Updating ${selected.size} photo${selected.size === 1 ? "" : "s"}…`, () =>
      api.images.bulkUpdate(Array.from(selected), { ...patch, apply_to_pair: mergePairs })
    );
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
    await withWait(`Moving ${ids.length} photo${ids.length === 1 ? "" : "s"} to trash…`, () =>
      api.images.bulkDelete(ids)
    );
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
    await withWait(`Removing ${selected.size} photo${selected.size === 1 ? "" : "s"} from album…`, () =>
      Promise.all(ids.map((imageId) => api.albums.removeImage(id, imageId)))
    );
    clearSelection();
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["album", id] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
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

  async function addSelectedToAlbum(targetAlbumId: string) {
    if (selected.size === 0) return;
    // In merged view the RAW partner is hidden behind the JPEG card - add it
    // too, so the target album holds the whole shot.
    await withWait(`Adding ${selected.size} photo${selected.size === 1 ? "" : "s"} to album…`, () =>
      api.albums.addImages(targetAlbumId, withPairedIds(Array.from(selected)))
    );
    queryClient.invalidateQueries({ queryKey: ["albums"] });
    queryClient.invalidateQueries({ queryKey: ["album", targetAlbumId] });
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
    queryClient.invalidateQueries({ queryKey: ["album", id] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  async function autoDevelopSelected() {
    if (selected.size === 0) return;
    const editedCount = (images ?? []).filter((im) => selected.has(im.id) && im.edit_rev).length;
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

  // The album's tag rule: photos carrying any of these tags are members
  // automatically. Saving refreshes the grid, the header count and the cards.
  async function saveTagFilter(tags: string[]) {
    if (!id) return;
    await api.albums.update(id, { tag_filter: tags });
    queryClient.invalidateQueries({ queryKey: ["album", id] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
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
      {pairDeleteDialog}
      <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* Same Back button as the photo view, the import review and the
            editor - one look for leaving any view. */}
        <Link to="/albums" className="btn btn-sm back-btn" title="Back to albums">
          <IconArrowLeft size={13} /> Back
        </Link>
        {album ? (
          /* The album's name is the user's own - click it (or the pencil) to
             rename it right here. */
          <>
            <AlbumNameField
              albumId={album.id}
              name={album.name}
              editing={renaming}
              onEditingChange={setRenaming}
              className="album-title-name"
              inputClassName="album-title-input"
              clickToEdit
            />
            {!renaming && (
              <button
                className="btn ghost btn-sm album-rename-btn"
                title="Rename this album"
                aria-label="Rename this album"
                onClick={() => setRenaming(true)}
              >
                <IconPencil size={14} />
              </button>
            )}
          </>
        ) : (
          "Album"
        )}
        {album && <span className="count-pill">{album.image_count} photos</span>}
        {album && (
          /* Always visible - with no tags in the library yet the picker just
             renders disabled ("No tags"), so the feature stays discoverable. */
          <span
            className="filter-field filter-field-inline"
            style={{ fontSize: 13, fontWeight: 400, display: "inline-flex", alignItems: "center", gap: 6 }}
            title="Photos carrying any of these tags belong to this album automatically"
          >
            Auto-include
            <TagFilter
              options={allTags ?? []}
              value={album.tag_filter ?? []}
              onChange={saveTagFilter}
              emptyLabel="No tags"
              title="Build this album from tags: photos with any selected tag are included automatically"
            />
          </span>
        )}
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
            <AlbumPicker onAdd={addSelectedToAlbum} onResult={reportAlbumAdd} />
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

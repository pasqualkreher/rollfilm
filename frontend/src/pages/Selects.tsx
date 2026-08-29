import { useEffect, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ImageOut } from "../api/types";
import { useSelects } from "../state/selects";
import { useTasks } from "../state/tasks";
import { collapsePairs, useMergePairs } from "../state/viewPrefs";
import { groupPairsAdjacent } from "../utils/pairing";
import { ThumbnailGrid } from "../components/ThumbnailGrid";
import { ExportDialog } from "../components/ExportDialog";
import { useTransientMessage } from "../utils/transientMessage";

export function Selects() {
  const { ids, count, remove } = useSelects();
  const mergePairs = useMergePairs();
  const [exportOpen, setExportOpen] = useState(false);
  // Both flash messages auto-dismiss after a moment.
  const [error, setError] = useTransientMessage();
  const [immichBusy, setImmichBusy] = useState(false);
  const [immichMsg, setImmichMsg] = useTransientMessage();
  // Same select mode as the Library / Album / Import grids, but ON by default
  // here with everything pre-selected: the set is already curated, so the
  // common move is unticking a few photos and downloading the rest. No
  // separate bulk bar - the toolbar's own actions apply to the selection.
  const [selectMode, setSelectMode] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastIndex, setLastIndex] = useState<number | null>(null);

  // The "Add to Immich" action only appears when the integration is configured
  // in Settings (both host and API key present).
  const { data: immich } = useQuery({
    queryKey: ["immich-settings"],
    queryFn: () => api.settings.getImmich(),
  });
  const immichConfigured = Boolean(immich?.base_url && immich?.api_key_set && immich.enabled);

  // Lock the nav + show the top-bar spinner while uploading to Immich, same as
  // the Library and Album pages.
  const { setBusyLabel } = useTasks();
  useEffect(() => {
    setBusyLabel(immichBusy ? "Uploading to Immich…" : null);
  }, [immichBusy, setBusyLabel]);
  useEffect(() => () => setBusyLabel(null), [setBusyLabel]);

  // One query per selected id; photos deleted for good simply resolve to
  // nothing and are filtered out below so the list never shows a broken tile.
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["image", id],
      queryFn: () => api.images.get(id),
    })),
  });

  const loadedImages = results
    .map((r) => r.data)
    // A photo in the Trash still resolves - the endpoint has to serve it for
    // the Trash itself. It has no business sitting in the working set though:
    // deleting a photo anywhere used to leave it here, still shown and still
    // counted, until it was deleted for good.
    .filter((img): img is ImageOut => Boolean(img) && !img!.deleted_at);
  // Drop those ids for real, so the header count and every toolbar action
  // (export, Immich, develop) stop including them. Self-healing: it catches
  // photos trashed from anywhere - another page, the retention purge - not
  // just the ones this session deleted.
  const trashedIds = results
    .map((r) => r.data)
    .filter((img): img is ImageOut => Boolean(img) && Boolean(img!.deleted_at))
    .map((img) => img.id);
  useEffect(() => {
    trashedIds.forEach((id) => remove(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trashedIds.join(",")]);
  // When merging, a selected RAW+JPEG pair shows as its single JPEG card;
  // otherwise both halves sit adjacent (JPEG first), same as the other grids.
  const images = mergePairs
    ? collapsePairs(loadedImages)
    : groupPairsAdjacent(loadedImages, (img) => img.file_type, (img) => img.paired_image_id);

  const hasSelection = selected.size > 0;
  // While photos are selected the toolbar actions target just those; otherwise
  // they act on the whole working set.
  const actionIds = hasSelection ? Array.from(selected) : ids;

  // Select-all by default: each photo is auto-selected the first time it
  // appears (the per-id queries resolve at different times), but only once -
  // a photo the user unticked stays unticked.
  const seenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const newIds = images.map((im) => im.id).filter((id) => !seenRef.current.has(id));
    if (newIds.length === 0) return;
    newIds.forEach((id) => seenRef.current.add(id));
    setSelected((prev) => new Set([...prev, ...newIds]));
  }, [images]);

  // Expand a set of ids with each one's RAW/JPEG partner, but only in merged
  // view where the partner is hidden behind the shown card (the split view lets
  // the user pick each half, so we keep their selection exact there).
  function withPairedIds(imageIds: string[]): string[] {
    if (!mergePairs) return imageIds;
    const byId = new Map(loadedImages.map((im) => [im.id, im]));
    const out = new Set(imageIds);
    for (const imgId of imageIds) {
      const partner = byId.get(imgId)?.paired_image_id;
      if (partner) out.add(partner);
    }
    return Array.from(out);
  }

  // Click = toggle; shift-click = select the whole range since the last click,
  // like the library grid - makes selecting a long run of photos fast.
  function toggleSelect(imageId: string, index: number, shiftKey: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastIndex !== null) {
        const [start, end] = lastIndex < index ? [lastIndex, index] : [index, lastIndex];
        for (let i = start; i <= end; i++) next.add(images[i].id);
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
    setSelected(new Set(images.map((img) => img.id)));
  }

  function clearSelection() {
    setSelected(new Set());
    setLastIndex(null);
  }

  function removeSelectedFromSelects() {
    if (!hasSelection) return;
    // Merged view hides the RAW behind its JPEG - drop both halves of the shot.
    withPairedIds(Array.from(selected)).forEach(remove);
    clearSelection();
  }

  async function addToImmich(imageIds: string[]) {
    if (imageIds.length === 0) return;
    setImmichBusy(true);
    setImmichMsg(null);
    setError(null);
    try {
      const result = await api.images.pushToImmich(imageIds);
      setImmichMsg(result.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImmichBusy(false);
    }
  }

  return (
    <div className="page">
      <h2 className="section-title">
        Selects
        <span className="count-pill">{count} photos</span>
      </h2>

      {count === 0 ? (
        <div className="empty-state">
          No selects yet. Gather photos from the library, an album, or a photo's page to collect the shots you want to
          export or download.
        </div>
      ) : (
        <>
          <div className="filter-bar">
            <div className="control-group">
              <button
                className="btn primary"
                onClick={() => setExportOpen(true)}
                disabled={actionIds.length === 0}
                title="Export as JPEGs with the saved edits baked in, or download the original files 1:1 with all meta tags"
              >
                {hasSelection
                  ? `Export ${selected.size} photo${selected.size === 1 ? "" : "s"}`
                  : `Export all ${count} photos`}
              </button>
              {/* Hidden in full sync mode - everything uploads automatically there. */}
              {immichConfigured && immich?.sync_mode !== "full" && (
                <button
                  className="btn"
                  onClick={() => addToImmich(actionIds)}
                  disabled={immichBusy}
                  title={
                    hasSelection
                      ? "Upload the selected JPEGs to your configured Immich server (RAW files are skipped)"
                      : "Upload all JPEGs in your selects to Immich (RAW files are skipped)"
                  }
                >
                  {immichBusy
                    ? "Uploading to Immich..."
                    : hasSelection
                      ? `Add ${selected.size} to Immich`
                      : "Add to Immich"}
                </button>
              )}
            </div>
            <div className="control-group control-group--actions">
              <button
                className={`btn${selectMode ? " primary" : ""}`}
                onClick={() => {
                  setSelectMode((v) => !v);
                  // Leaving select mode clears the picks; re-entering starts
                  // from the default again - everything selected.
                  if (selectMode) clearSelection();
                  else selectAll();
                }}
              >
                {selectMode ? "Done selecting" : "Select"}
              </button>
              {selectMode && (
                <>
                  <button className="btn" onClick={selectAll}>
                    Select all
                  </button>
                  <button className="btn" onClick={clearSelection} disabled={!hasSelection}>
                    Clear selection
                  </button>
                </>
              )}
              {hasSelection && (
                <button className="btn" onClick={removeSelectedFromSelects}>
                  Remove from selects
                </button>
              )}
            </div>
            {immichMsg && <span className="status-note">{immichMsg}</span>}
            {error && <span className="status-note status-note--error">{error}</span>}
          </div>

          {selectMode && (
            <p style={{ color: "var(--text-muted)", marginTop: -8, marginBottom: 16 }}>
              Click photos to select them - shift-click to select a range. Export/Immich act on
              your selection while one exists.
            </p>
          )}

          {/* The shared grid handles justified tile sizing (--ar + filler) and
              the enlarged 1-2 photo layout - the previous hand-rolled grid
              lacked both, so a lone select stretched huge and got cut off. */}
          <ThumbnailGrid
            images={images}
            selectedIds={selected}
            onToggleSelect={toggleSelect}
            selectMode={selectMode}
            onRemove={remove}
            removeTitle="Remove from selects"
          />
        </>
      )}
      {exportOpen && <ExportDialog imageIds={actionIds} onClose={() => setExportOpen(false)} />}
    </div>
  );
}

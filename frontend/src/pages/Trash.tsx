import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { pairUnits } from "../utils/batchUnits";
import { membershipWarning } from "../utils/deleteMessage";
import { useAppDialogs } from "../components/AppDialogs";
import { IconCheck, IconRestore, IconTrash, IconX } from "../components/Icons";
import { Presence } from "../components/Presence";
import { MOTION } from "../utils/usePresence";
import { modKeyLabel, useSelectionKeys } from "../utils/selection";
import { ThumbnailGrid } from "../components/ThumbnailGrid";
import type { ContextActions } from "../components/PhotoContextMenu";
import type { ImageOut } from "../api/types";
import { collapsePairsBy, groupPairsAdjacent } from "../utils/pairing";
import { useMergePairs } from "../state/viewPrefs";
import { useTransientMessage } from "../utils/transientMessage";
import { useTasks, type BatchItem } from "../state/tasks";
import { LoadingState } from "../components/Spinner";
import { plural } from "../utils/plural";

// The in-app Trash: managed (imported) photos land here when deleted and can
// be restored; only deleting them from here removes the original files from
// the library folder. Photos indexed from external folders never appear here -
// deleting those only removes their catalog entry, their files stay on disk.
export function Trash() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const mergePairs = useMergePairs();
  const { runTask, runBatches } = useTasks();
  // Restores and deletes run as one task in the title bar, counted down with
  // a Stop, one at a time.
  const batch = <R,>(label: string, items: BatchItem[], run: (ids: string[]) => Promise<R>) =>
    runBatches({ id: "batch:trash", kind: "batch", label }, items, run);

  const { data: trashed, isLoading } = useQuery({
    queryKey: ["trash"],
    queryFn: () => api.images.listTrash(),
  });

  // Laid out like every other grid. The backend only reports a pair here when
  // BOTH halves are in the Trash, so a shot whose JPEG alone was deleted shows
  // as the single JPEG it is - it used to claim "RAW+JPG" while its RAW was
  // still sitting in the library, untouched.
  const images = useMemo(() => {
    const list = trashed ?? [];
    return mergePairs
      ? collapsePairsBy(list, (im) => im.file_type, (im) => im.paired_image_id)
      : groupPairsAdjacent(list, (im) => im.file_type, (im) => im.paired_image_id);
  }, [trashed, mergePairs]);

  // Merged view hides the RAW behind its JPEG card, so restoring or deleting
  // one has to take the hidden half with it - otherwise a pair that went into
  // the Trash together would come back out of it split.
  function withPairedIds(ids: string[]): string[] {
    if (!mergePairs) return ids;
    const byId = new Map((trashed ?? []).map((im) => [im.id, im]));
    const out = new Set(ids);
    for (const id of ids) {
      const partner = byId.get(id)?.paired_image_id;
      if (partner) out.add(partner);
    }
    return Array.from(out);
  }
  const { data: trashSettings } = useQuery({
    queryKey: ["trash-settings"],
    queryFn: () => api.settings.getTrash(),
  });

  function toggleSelect(id: string, index: number, shiftKey: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastIndex !== null) {
        const [start, end] = lastIndex < index ? [lastIndex, index] : [index, lastIndex];
        for (let i = start; i <= end; i++) next.add(images[i].id);
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setLastIndex(index);
  }

  // Feedback when a restore/delete request fails - without it a failed call
  // used to abort silently before any refresh, leaving a stale grid until the
  // next tab change. Auto-dismisses after a moment.
  const [actionError, setActionError] = useTransientMessage();

  // The handled photos leave the selection as it is now - the user may have
  // picked more while the task ran; those stay.
  function refreshAfterChange(handled: string[]) {
    const gone = new Set(handled);
    setSelected((prev) => new Set(Array.from(prev).filter((x) => !gone.has(x))));
    setLastIndex(null);
    queryClient.invalidateQueries({ queryKey: ["trash"] });
    // Trashing or restoring photos changes which tags live photos carry.
    queryClient.invalidateQueries({ queryKey: ["tags"] });
    // Restored photos reappear in the grid and album counts.
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  // Drop the handled photos from the cached list right away: the grid updates
  // instantly instead of waiting on the refetch (which can take seconds when
  // the library sits on a sleeping external drive).
  function removeFromCachedList(ids: string[]) {
    queryClient.setQueryData<ImageOut[]>(["trash"], (old) =>
      old?.filter((im) => !ids.includes(im.id))
    );
    // The working set can't hold a photo that no longer exists.
    queryClient.invalidateQueries({ queryKey: ["image"] });
  }

  const partnerOf = (imageId: string) => images.find((im) => im.id === imageId)?.paired_image_id;

  async function restoreSelected(target: string[] = Array.from(selected)) {
    if (target.length === 0) return;
    const ids = withPairedIds(target);
    setActionError(null);
    let handled = ids;
    try {
      const { done } = await batch("Restoring photos…", pairUnits(ids, partnerOf), async (slice) => {
        await api.images.restoreFromTrash(slice);
        // Slice by slice, so a Stop leaves exactly the restored ones gone.
        removeFromCachedList(slice);
      });
      handled = done;
    } catch (e) {
      setActionError(`Restore failed: ${(e as Error).message}`, { keep: true });
    } finally {
      // Refresh even after an error - the server may have applied the change
      // before the request failed, and the refetch brings the view back in
      // sync either way.
      refreshAfterChange(handled);
    }
  }

  async function deleteSelectedForever(target: string[] = Array.from(selected)) {
    if (target.length === 0) return;
    // Counted after the hidden pair halves are folded in, so the number in the
    // question is the number of files that actually get erased.
    const ids = withPairedIds(target);
    // Trashed photos keep their album and canvas memberships - this is the
    // step that really takes them out of there, so say so.
    const warning = await api.images
      .usage(ids)
      .then((usage) => membershipWarning(usage, true))
      .catch(() => null);
    if (
      !(await dialogs.confirm({
        title: `Permanently delete ${plural(ids.length, "photo")}?`,
        message: `The original files are deleted from your library. This cannot be undone.${warning ? `\n\n${warning}` : ""}`,
        confirmLabel: "Delete forever",
        danger: true,
      }))
    ) {
      return;
    }
    setActionError(null);
    let handled = ids;
    try {
      const { done } = await batch("Deleting photos…", pairUnits(ids, partnerOf), async (slice) => {
        await api.images.deleteFromTrash(slice);
        removeFromCachedList(slice);
      });
      handled = done;
    } catch (e) {
      setActionError(`Delete failed: ${(e as Error).message}`, { keep: true });
    } finally {
      refreshAfterChange(handled);
    }
  }

  // The right-click menu's two rows, on the photo under the pointer or the
  // selection it belongs to.
  const trashActions: ContextActions = {
    files: false,
    onRestore: (ids) => restoreSelected(ids),
    onDeleteForever: (ids) => deleteSelectedForever(ids),
  };

  async function emptyTrash() {
    if (!trashed || trashed.length === 0) return;
    if (
      !(await dialogs.confirm({
        title: "Empty the Trash?",
        message: `All ${plural(trashed.length, "photo")} in the Trash are deleted permanently. The original files are deleted from your library. This cannot be undone.`,
        confirmLabel: "Empty Trash",
        danger: true,
      }))
    ) {
      return;
    }
    setActionError(null);
    const all = trashed.map((im) => im.id);
    try {
      await runTask({ id: "batch:trash", kind: "plain", label: "Emptying the Trash…" }, () => api.images.emptyTrash());
      queryClient.setQueryData<ImageOut[]>(["trash"], []);
      queryClient.invalidateQueries({ queryKey: ["image"] });
    } catch (e) {
      setActionError(`Emptying the Trash failed: ${(e as Error).message}`, { keep: true });
    } finally {
      refreshAfterChange(all);
    }
  }

  function selectAll() {
    setSelected(new Set(images.map((im) => im.id)));
  }
  function clearSelection() {
    setSelected(new Set());
    setLastIndex(null);
  }

  // Cmd/Ctrl+A, Esc and Delete work on the grid like they do in the library.
  useSelectionKeys({
    onSelectAll: selectAll,
    onClear: clearSelection,
    hasSelection: selected.size > 0,
    onDelete: () => void deleteSelectedForever(),
  });

  const trashExplainer =
    "Photos stay here until you restore or delete them." +
    (trashSettings && trashSettings.retention_days > 0
      ? ` Deleted automatically after ${trashSettings.retention_days} days (Settings).`
      : "");

  return (
    <div className="page page-timeline">
      <div className="filter-bar filter-bar--sticky">
        {/* One muted line that gives way to the buttons when the window
            narrows; the full sentence stays in the tooltip. It also takes the
            free space, which pushes the actions to the right edge. */}
        <span className="trash-explainer" title={trashExplainer}>
          {trashExplainer}
        </span>
        <div className="control-group control-group--actions">
          <button
            className="btn btn-sm quiet-danger"
            onClick={emptyTrash}
            disabled={!trashed || trashed.length === 0}
            title="Delete every photo in the Trash permanently"
          >
            Empty Trash
          </button>
        </div>
      </div>
      {/* The selection's own bar, risen from the bottom edge like the
          library's: it only exists while something is picked. */}
      <Presence open={selected.size > 0} ms={MOTION.bar}>
        {selected.size > 0 && (
          <div className="filter-bar action-bar--bottom">
            <div className="control-group">
              <span>{selected.size} selected</span>
              <button className="btn" onClick={selectAll} title={`Select every photo shown (${modKeyLabel}+A)`}>
                <span className="btn-label"><IconCheck size={13} /> Select all</span>
              </button>
              <button className="btn" onClick={clearSelection} title="Clear the selection (Esc)">
                <span className="btn-label"><IconX size={13} /> Clear selection</span>
              </button>
            </div>
            <span className="bar-sep" aria-hidden />
            <div className="control-group">
              <button className="btn" onClick={() => void restoreSelected()} title="Restore the selected photos to the library">
                <span className="btn-label"><IconRestore size={13} /> Restore</span>
              </button>
            </div>
            <button
              className="btn btn-sm quiet-danger"
              style={{ marginLeft: "auto" }}
              onClick={() => void deleteSelectedForever()}
              title="Delete the selected photos permanently (Delete)"
              aria-label="Delete the selected photos permanently"
            >
              <IconTrash size={15} />
            </button>
          </div>
        )}
      </Presence>
      <div className="page-scroll">
        {actionError && (
          <p className="status-note status-note--error page-note">{actionError}</p>
        )}
        {isLoading ? (
          <LoadingState />
        ) : images.length === 0 ? (
          <div className="empty-state">
            The Trash is empty. Deleted photos appear here and can be restored.
          </div>
        ) : (
          <ThumbnailGrid
            images={images}
            selectedIds={selected}
            onToggleSelect={toggleSelect}
            onSetSelection={(ids) => setSelected(new Set(ids))}
            // Nothing to open here, so a plain click picks the photo.
            clickSelects
            // Deleted photos are restored or purged, not exported or copied:
            // the right-click menu offers the bar's two actions and nothing else.
            contextActions={trashActions}
          />
        )}
      </div>
    </div>
  );
}

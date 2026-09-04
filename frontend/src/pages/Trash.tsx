import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { membershipWarning } from "../utils/deleteMessage";
import { useAppDialogs } from "../components/AppDialogs";
import { IconRestore, IconTrash } from "../components/Icons";
import { ThumbnailGrid } from "../components/ThumbnailGrid";
import type { ImageOut } from "../api/types";
import { collapsePairsBy, groupPairsAdjacent } from "../utils/pairing";
import { useMergePairs } from "../state/viewPrefs";
import { useTransientMessage } from "../utils/transientMessage";
import { useWait } from "../state/wait";

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
  const { withWait } = useWait();

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

  function refreshAfterChange() {
    setSelected(new Set());
    setLastIndex(null);
    queryClient.invalidateQueries({ queryKey: ["trash"] });
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

  async function restoreSelected() {
    if (selected.size === 0) return;
    const ids = withPairedIds(Array.from(selected));
    setActionError(null);
    try {
      await withWait(`Restoring ${ids.length} photo${ids.length === 1 ? "" : "s"}…`, () =>
        api.images.restoreFromTrash(ids)
      );
      removeFromCachedList(ids);
    } catch (e) {
      setActionError(`Restore failed: ${(e as Error).message}`);
    } finally {
      // Refresh even after an error - the server may have applied the change
      // before the request failed, and the refetch brings the view back in
      // sync either way.
      refreshAfterChange();
    }
  }

  async function deleteSelectedForever() {
    if (selected.size === 0) return;
    // Counted after the hidden pair halves are folded in, so the number in the
    // question is the number of files that actually get erased.
    const ids = withPairedIds(Array.from(selected));
    // Trashed photos keep their album and canvas memberships - this is the
    // step that really takes them out of there, so say so.
    const warning = await api.images
      .usage(ids)
      .then((usage) => membershipWarning(usage, true))
      .catch(() => null);
    if (
      !(await dialogs.confirm({
        title: `Permanently delete ${ids.length} photo(s)?`,
        message: `This removes the original files from your library - it cannot be undone.${warning ? `\n\n${warning}` : ""}`,
        confirmLabel: "Delete forever",
        danger: true,
      }))
    ) {
      return;
    }
    setActionError(null);
    try {
      await withWait(`Deleting ${ids.length} photo${ids.length === 1 ? "" : "s"}…`, () =>
        api.images.deleteFromTrash(ids)
      );
      removeFromCachedList(ids);
    } catch (e) {
      setActionError(`Delete failed: ${(e as Error).message}`);
    } finally {
      refreshAfterChange();
    }
  }

  return (
    <div className="page page-timeline">
      <div className="filter-bar">
        <strong>Trash</strong>
        <span style={{ color: "var(--text-muted)" }}>
          Deleted library photos stay here until you restore them or delete them for good.
          {trashSettings && trashSettings.retention_days > 0
            ? ` Photos are deleted automatically after ${trashSettings.retention_days} days (change this in Settings).`
            : ""}
        </span>
        <span style={{ flex: 1 }} />
        <div className="control-group" style={{ flexWrap: "nowrap" }}>
          <button
            className="btn"
            onClick={() => setSelected(new Set(images.map((im) => im.id)))}
            disabled={images.length === 0}
          >
            Select all
          </button>
          <button className="btn" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
            Clear selection
          </button>
          <button
            className="btn btn-sm"
            onClick={restoreSelected}
            disabled={selected.size === 0}
            title="Restore the selected photos to the library"
            aria-label="Restore the selected photos to the library"
          >
            <IconRestore size={15} />
          </button>
          <button
            className="btn btn-sm quiet-danger"
            onClick={deleteSelectedForever}
            disabled={selected.size === 0}
            title="Delete the selected photos forever"
            aria-label="Delete the selected photos forever"
          >
            <IconTrash size={15} />
          </button>
        </div>
      </div>
      <div className="page-scroll">
        {actionError && (
          <p className="status-note status-note--error" style={{ marginBottom: 16 }}>{actionError}</p>
        )}
        {selected.size > 0 && (
          <p style={{ color: "var(--text-muted)", marginBottom: 16 }}>{selected.size} selected</p>
        )}
        {isLoading ? (
          <div className="empty-state">Loading...</div>
        ) : images.length === 0 ? (
          <div className="empty-state">
            The Trash is empty. Deleted library photos land here and can be restored.
          </div>
        ) : (
          <ThumbnailGrid
            images={images}
            selectedIds={selected}
            onToggleSelect={toggleSelect}
            selectMode
          />
        )}
      </div>
    </div>
  );
}

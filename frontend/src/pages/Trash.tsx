import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { ThumbnailGrid } from "../components/ThumbnailGrid";

// The in-app Trash: managed (imported) photos land here when deleted and can
// be restored; only deleting them from here removes the original files from
// the library folder. Photos indexed from external folders never appear here -
// deleting those only removes their catalog entry, their files stay on disk.
export function Trash() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const { data: images, isLoading } = useQuery({
    queryKey: ["trash"],
    queryFn: () => api.images.listTrash(),
  });
  const { data: trashSettings } = useQuery({
    queryKey: ["trash-settings"],
    queryFn: () => api.settings.getTrash(),
  });

  function toggleSelect(id: string, index: number, shiftKey: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastIndex !== null && images) {
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

  function refreshAfterChange() {
    setSelected(new Set());
    setLastIndex(null);
    queryClient.invalidateQueries({ queryKey: ["trash"] });
    // Restored photos reappear in the grid and album counts.
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  async function restoreSelected() {
    if (selected.size === 0) return;
    await api.images.restoreFromTrash(Array.from(selected));
    refreshAfterChange();
  }

  async function deleteSelectedForever() {
    if (selected.size === 0) return;
    if (
      !window.confirm(
        `Permanently delete ${selected.size} photo(s)? This removes the original files from your library - it cannot be undone.`
      )
    ) {
      return;
    }
    await api.images.deleteFromTrash(Array.from(selected));
    refreshAfterChange();
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
            onClick={() => setSelected(new Set((images ?? []).map((im) => im.id)))}
            disabled={!images || images.length === 0}
          >
            Select all
          </button>
          <button className="btn" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
            Clear selection
          </button>
          <button className="btn" onClick={restoreSelected} disabled={selected.size === 0}>
            Restore
          </button>
          <button className="btn quiet-danger btn-sm" onClick={deleteSelectedForever} disabled={selected.size === 0}>
            Delete forever
          </button>
        </div>
      </div>
      <div className="page-scroll">
        {selected.size > 0 && (
          <p style={{ color: "var(--text-muted)", marginBottom: 16 }}>{selected.size} selected</p>
        )}
        {isLoading ? (
          <div className="empty-state">Loading...</div>
        ) : !images || images.length === 0 ? (
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

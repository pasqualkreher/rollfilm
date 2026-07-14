import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

interface Props {
  onAdd: (albumId: string) => void | Promise<unknown>;
  currentAlbumIds?: string[];
  onRemove?: (albumId: string) => void;
}

// Pure "add to an existing album" picker. Creating albums deliberately lives
// only on the Albums page, so this stays a compact dropdown that fits in the
// detail sidebar and the bulk action bar.
export function AlbumPicker({ onAdd, currentAlbumIds, onRemove }: Props) {
  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });

  // Adding is otherwise invisible (the dropdown just snaps back to its
  // placeholder), so confirm briefly that it actually happened.
  const [flash, setFlash] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  function showFlash(text: string, error = false) {
    setFlash({ text, error });
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 2500);
  }

  async function handleAdd(albumId: string) {
    const name = (albums ?? []).find((a) => a.id === albumId)?.name ?? "album";
    setBusy(true);
    try {
      await onAdd(albumId);
      showFlash(`Added to “${name}” ✓`);
    } catch {
      showFlash(`Could not add to “${name}”`, true);
    } finally {
      setBusy(false);
    }
  }

  const currentAlbums = currentAlbumIds
    ? (albums ?? []).filter((a) => currentAlbumIds.includes(a.id))
    : [];

  return (
    <div className="album-picker">
      {currentAlbumIds && currentAlbums.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {currentAlbums.map((a) => (
            <span key={a.id} className="tag-chip">
              {a.name}
              {onRemove && (
                <button type="button" onClick={() => onRemove(a.id)} aria-label={`Remove from ${a.name}`}>
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <select
        value=""
        disabled={busy}
        onChange={(e) => {
          if (e.target.value) handleAdd(e.target.value);
        }}
      >
        <option value="">Add to album...</option>
        {(albums ?? []).map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {flash && (
        <span
          style={{
            marginLeft: 8,
            fontSize: 13,
            color: flash.error ? "var(--danger, #d33)" : "var(--text-muted)",
          }}
        >
          {flash.text}
        </span>
      )}
      {(albums ?? []).length === 0 && (
        <p className="album-picker-hint" style={{ color: "var(--text-muted)", fontSize: 12, margin: "6px 0 0" }}>
          No albums yet — create one on the Albums page.
        </p>
      )}
    </div>
  );
}

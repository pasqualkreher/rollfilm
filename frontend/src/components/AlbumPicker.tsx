import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

interface Props {
  onAdd: (albumId: string) => void;
  currentAlbumIds?: string[];
  onRemove?: (albumId: string) => void;
}

export function AlbumPicker({ onAdd, currentAlbumIds, onRemove }: Props) {
  const [creating, setCreating] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");
  const queryClient = useQueryClient();
  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });

  const createAlbum = useMutation({
    mutationFn: (name: string) => api.albums.create(name),
    onSuccess: (album) => {
      queryClient.invalidateQueries({ queryKey: ["albums"] });
      onAdd(album.id);
      setNewAlbumName("");
      setCreating(false);
    },
  });

  const currentAlbums = currentAlbumIds
    ? (albums ?? []).filter((a) => currentAlbumIds.includes(a.id))
    : [];

  return (
    <div>
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

      {creating ? (
        <form
          style={{ display: "inline-flex", gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (newAlbumName.trim()) createAlbum.mutate(newAlbumName.trim());
          }}
        >
          <input
            type="text"
            placeholder="New album name"
            value={newAlbumName}
            onChange={(e) => setNewAlbumName(e.target.value)}
            autoFocus
          />
          <button className="btn primary" type="submit" disabled={!newAlbumName.trim()}>
            Create &amp; add
          </button>
          <button className="btn" type="button" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <select
          value=""
          onChange={(e) => {
            const value = e.target.value;
            if (value === "__new__") setCreating(true);
            else if (value) onAdd(value);
          }}
        >
          <option value="">Add to album...</option>
          {(albums ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          <option value="__new__">+ New album</option>
        </select>
      )}
    </div>
  );
}

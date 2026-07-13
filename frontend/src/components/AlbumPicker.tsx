import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

interface Props {
  onAdd: (albumId: string) => void;
  currentAlbumIds?: string[];
  onRemove?: (albumId: string) => void;
}

// Pure "add to an existing album" picker. Creating albums deliberately lives
// only on the Albums page, so this stays a compact dropdown that fits in the
// detail sidebar and the bulk action bar.
export function AlbumPicker({ onAdd, currentAlbumIds, onRemove }: Props) {
  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });

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
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value);
        }}
      >
        <option value="">Add to album...</option>
        {(albums ?? []).map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {(albums ?? []).length === 0 && (
        <p className="album-picker-hint" style={{ color: "var(--text-muted)", fontSize: 12, margin: "6px 0 0" }}>
          No albums yet — create one on the Albums page.
        </p>
      )}
    </div>
  );
}

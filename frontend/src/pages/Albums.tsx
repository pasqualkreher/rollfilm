import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

export function Albums() {
  const [name, setName] = useState("");
  const queryClient = useQueryClient();

  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });

  const createAlbum = useMutation({
    mutationFn: () => api.albums.create(name),
    onSuccess: () => {
      setName("");
      queryClient.invalidateQueries({ queryKey: ["albums"] });
    },
  });

  // Deleting an album only removes the album itself (and its photo links) -
  // the photos stay in the library untouched.
  async function deleteAlbum(id: string, albumName: string, count: number) {
    if (!window.confirm(`Delete album “${albumName}”? Its ${count} photo(s) stay in your library.`)) return;
    await api.albums.remove(id);
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  return (
    <div className="page">
      <h2 className="section-title">Albums</h2>
      <form
        className="import-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) createAlbum.mutate();
        }}
      >
        <input type="text" placeholder="New album name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" type="submit">
          Create album
        </button>
      </form>

      {albums && albums.length === 0 && <div className="empty-state">No albums yet - create one above.</div>}

      <div className="thumbnail-grid">
        {albums?.map((album) => (
          <Link
            key={album.id}
            to={`/albums/${album.id}`}
            className="thumb-card has-remove"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}
          >
            <div style={{ textAlign: "center", color: "var(--text)" }}>
              <div style={{ fontWeight: 600 }}>{album.name}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{album.image_count} photos</div>
            </div>
            <button
              className="card-remove"
              title="Delete album (photos stay in the library)"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                deleteAlbum(album.id, album.name, album.image_count);
              }}
            >
              ×
            </button>
          </Link>
        ))}
        {/* Same trailing spacer as the photo grids: soaks up final-row slack so
            a lone album card keeps its normal size instead of stretching huge. */}
        <i className="grid-filler" aria-hidden />
      </div>
    </div>
  );
}

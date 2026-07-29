import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, DEFAULT_EDIT_VERSION } from "../api/client";
import { useAppDialogs } from "../components/AppDialogs";
import type { SmartAlbumOut } from "../api/types";

// Cover thumbnail that fades in once decoded (see .smart-card img in CSS)
// instead of popping into the card.
function SmartCover({ imageId }: { imageId: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      src={api.images.thumbnailUrl(imageId, DEFAULT_EDIT_VERSION)}
      alt=""
      loading="lazy"
      className={loaded ? "loaded" : undefined}
      onLoad={() => setLoaded(true)}
    />
  );
}

// Mini mosaic of up to 4 member photos filling an album card - a quick peek
// inside the album instead of a single cover. Fewer photos get bigger cells
// (see .cover-mosaic--N in CSS); a single photo just fills the card.
export function CoverMosaic({ imageIds }: { imageIds: string[] }) {
  const ids = imageIds.slice(0, 4);
  return (
    <div className={`cover-mosaic cover-mosaic--${ids.length}`}>
      {ids.map((id) => (
        <SmartCover key={id} imageId={id} />
      ))}
    </div>
  );
}

// Shimmering placeholder row shown while the smart albums are still being
// fetched/computed - keeps the layout stable so nothing pops in.
function SmartRowSkeleton({ title, hint }: { title?: string; hint?: string }) {
  return (
    <section className="smart-section" aria-hidden>
      {title ? (
        <h3 className="smart-row-title">
          {title}
          {hint && <span className="smart-row-hint">{hint}</span>}
        </h3>
      ) : (
        <div className="smart-title--skeleton" />
      )}
      <div className="smart-row" style={{ overflowX: "hidden" }}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="smart-card smart-card--skeleton" />
        ))}
      </div>
    </section>
  );
}

// One horizontally scrollable row of smart-album cards (cover + name + count).
function SmartRow({ title, items }: { title: string; items: SmartAlbumOut[] }) {
  if (items.length === 0) return null;
  return (
    <section className="smart-section">
      <h3 className="smart-row-title">{title}</h3>
      <div className="smart-row">
        {items.map((album) => (
          <Link
            key={album.id}
            to={`/smart-albums/${encodeURIComponent(album.id)}`}
            state={{ smart: album }}
            className="smart-card"
          >
            {album.cover_image_ids?.length ? (
              <CoverMosaic imageIds={album.cover_image_ids} />
            ) : album.cover_image_id ? (
              <SmartCover imageId={album.cover_image_id} />
            ) : (
              <div className="smart-card-blank" />
            )}
            <div className="smart-card-caption">
              <div className="smart-card-name">{album.name}</div>
              <div className="smart-card-count">{album.image_count} photos</div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function Albums() {
  const [name, setName] = useState("");
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();

  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });

  // Auto-computed albums (similarity clusters + years/months/big days). The
  // cluster pass runs in the background on the server - keep polling while
  // the very first build ("building") OR a stale rebuild ("refreshing", e.g.
  // embeddings still backfilling after an import) is running, so freshly
  // computed Moments appear without leaving the page.
  const { data: smart, isPending: smartLoading } = useQuery({
    queryKey: ["smart-albums"],
    queryFn: () => api.smartAlbums.list(),
    refetchInterval: (query) => {
      const status = query.state.data?.clusters_status;
      return status === "building" || status === "refreshing" ? 2500 : false;
    },
  });

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
    if (
      !(await dialogs.confirm({
        title: `Delete album “${albumName}”?`,
        message: `Its ${count} photo(s) stay in your library.`,
        confirmLabel: "Delete album",
        danger: true,
      }))
    )
      return;
    await api.albums.remove(id);
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  const clustersPending = smart
    ? smart.clusters_status !== "ready" && smart.clusters.length === 0
    : false;
  const hasSmart =
    !!smart &&
    (smart.clusters.length > 0 ||
      smart.places.length > 0 ||
      smart.countries.length > 0 ||
      smart.country_years.length > 0 ||
      smart.years.length > 0 ||
      smart.days.length > 0 ||
      smart.edits.length > 0 ||
      clustersPending);

  return (
    <div className="page">
      <h2 className="section-title">Albums</h2>

      {smartLoading && (
        <>
          <SmartRowSkeleton />
          <SmartRowSkeleton />
        </>
      )}

      {hasSmart && (
        <>
          {clustersPending && (
            <SmartRowSkeleton title="Moments" hint="Analyzing your photos…" />
          )}
          <SmartRow title="Moments" items={smart.clusters} />
          <SmartRow title="Places" items={smart.places} />
          <SmartRow title="Countries" items={smart.countries} />
          <SmartRow title="Countries by year" items={smart.country_years} />
          <SmartRow title="Big days" items={smart.days} />
          <SmartRow title="Edited" items={smart.edits} />
          <SmartRow title="Years" items={smart.years} />
          <SmartRow title="Months" items={smart.months} />
        </>
      )}

      <h3 className="smart-row-title">My albums</h3>
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
            {/* A peek inside the album: mini mosaic of its first photos with
                the name overlaid, like the smart cards. Empty albums keep the
                plain centered text. */}
            {album.cover_image_ids.length > 0 ? (
              <>
                <CoverMosaic imageIds={album.cover_image_ids} />
                <div className="smart-card-caption">
                  <div className="smart-card-name">{album.name}</div>
                  <div className="smart-card-count">{album.image_count} photos</div>
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", color: "var(--text)" }}>
                <div style={{ fontWeight: 600 }}>{album.name}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{album.image_count} photos</div>
              </div>
            )}
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

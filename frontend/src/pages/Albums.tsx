import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, DEFAULT_EDIT_VERSION } from "../api/client";
import { useAppDialogs } from "../components/AppDialogs";
import { TagFilter } from "../components/TagFilter";
import { IconChevronDown } from "../components/Icons";
import type { AlbumOut, SmartAlbumOut } from "../api/types";

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

// One smart-album card: cover mosaic + name + count, linking into the album.
function SmartCard({ album, displayName }: { album: SmartAlbumOut; displayName?: string }) {
  return (
    <Link
      to={`/smart-albums/${encodeURIComponent(album.id)}`}
      state={{ smart: album }}
      className="smart-card"
      title={album.name}
    >
      {album.cover_image_ids?.length ? (
        <CoverMosaic imageIds={album.cover_image_ids} />
      ) : album.cover_image_id ? (
        <SmartCover imageId={album.cover_image_id} />
      ) : (
        <div className="smart-card-blank" />
      )}
      <div className="smart-card-caption">
        <div className="smart-card-name">{displayName ?? album.name}</div>
        <div className="smart-card-count">{album.image_count} photos</div>
      </div>
    </Link>
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
          <SmartCard key={album.id} album={album} />
        ))}
      </div>
    </section>
  );
}

// The Moments row, with same-label moments stacked: "Mountains · Alpine" and
// "Mountains · Mediterranean" share one "Mountains" card that expands into an
// indented sub-row (the tree), instead of sitting side by side as
// near-duplicates ("Mountains", "Mountains II", ...). The sub-row leads with
// an "All ..." card merging the whole family (cluster-group id).
function MomentsRow({ items }: { items: SmartAlbumOut[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (items.length === 0) return null;

  const groups: { key: string; members: SmartAlbumOut[] }[] = [];
  const byKey = new Map<string, SmartAlbumOut[]>();
  for (const item of items) {
    const key = item.group ?? item.name;
    const list = byKey.get(key);
    if (list) {
      list.push(item);
    } else {
      const created = [item];
      byKey.set(key, created);
      groups.push({ key, members: created });
    }
  }

  const open = expanded !== null ? byKey.get(expanded) : undefined;
  const openTotal = (open ?? []).reduce((sum, m) => sum + m.image_count, 0);
  // The sub-card drops the shared prefix ("Mountains · Alpine" → "Alpine") -
  // the group header just said it.
  const subName = (album: SmartAlbumOut, key: string) =>
    album.name.startsWith(`${key} · `) ? album.name.slice(key.length + 3) : album.name;

  return (
    <section className="smart-section">
      <h3 className="smart-row-title">Moments</h3>
      <div className="smart-row">
        {groups.map(({ key, members }) =>
          members.length === 1 ? (
            <SmartCard key={members[0].id} album={members[0]} />
          ) : (
            <button
              key={key}
              type="button"
              className={`smart-card smart-card--stack${expanded === key ? " open" : ""}`}
              onClick={() => setExpanded(expanded === key ? null : key)}
              title={`${members.length} ${key} moments - click to ${expanded === key ? "collapse" : "expand"}`}
            >
              <CoverMosaic
                imageIds={members
                  .flatMap((m) => (m.cover_image_ids[0] ? [m.cover_image_ids[0]] : []))
                  .slice(0, 4)}
              />
              <div className="smart-card-caption">
                <div className="smart-card-name">{key}</div>
                <div className="smart-card-count">
                  {members.reduce((sum, m) => sum + m.image_count, 0)} photos ·{" "}
                  {members.length} moments{" "}
                  <span aria-hidden>
                    <IconChevronDown size={11} className={expanded === key ? "rot-180" : ""} />
                  </span>
                </div>
              </div>
            </button>
          )
        )}
      </div>
      {open && expanded !== null && (
        <div className="smart-row smart-row--sub">
          <SmartCard
            album={{
              id: `cluster-group:${expanded}`,
              kind: "cluster",
              name: `All ${expanded}`,
              image_count: openTotal,
              cover_image_id: open[0]?.cover_image_ids[0] ?? open[0]?.cover_image_id ?? null,
              cover_image_ids: open
                .flatMap((m) => (m.cover_image_ids[0] ? [m.cover_image_ids[0]] : []))
                .slice(0, 4),
              group: expanded,
            }}
          />
          {open.map((album) => (
            <SmartCard key={album.id} album={album} displayName={subName(album, expanded)} />
          ))}
        </div>
      )}
    </section>
  );
}

// "120 photos · beach, family" - album cards carrying a tag rule say so.
function albumCount(album: AlbumOut): string {
  const tags = album.tag_filter;
  return `${album.image_count} photos${tags.length ? ` · ${tags.join(", ")}` : ""}`;
}

export function Albums() {
  const [name, setName] = useState("");
  const [newTags, setNewTags] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();

  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });
  const { data: allTags } = useQuery({ queryKey: ["tags"], queryFn: () => api.tags.list() });

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
    mutationFn: () => api.albums.create(name, undefined, newTags),
    onSuccess: () => {
      setName("");
      setNewTags([]);
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
      smart.tags.length > 0 ||
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
          <MomentsRow items={smart.clusters} />
          <SmartRow title="Tags" items={smart.tags} />
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
        {/* Optional tag rule: photos carrying any checked tag belong to the
            album automatically (and keep joining it as they get tagged).
            Rendered even with no tags in the library (disabled "No tags"),
            so the feature stays discoverable. */}
        <TagFilter
          options={allTags ?? []}
          value={newTags}
          onChange={setNewTags}
          emptyLabel="Tags (optional)"
          title="Build the album from tags: photos with any selected tag are included automatically"
        />
        <button className="btn primary" type="submit">
          Create album
        </button>
        {newTags.length > 0 && (
          <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Auto-includes photos tagged {newTags.join(", ")}
          </span>
        )}
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
                  <div className="smart-card-count">{albumCount(album)}</div>
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", color: "var(--text)" }}>
                <div style={{ fontWeight: 600 }}>{album.name}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{albumCount(album)}</div>
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

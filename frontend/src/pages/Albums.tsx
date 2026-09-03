import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, DEFAULT_EDIT_VERSION } from "../api/client";
import { useAppDialogs } from "../components/AppDialogs";
import { TagFilter } from "../components/TagFilter";
import {
  IconArrowLeft,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconPencil,
} from "../components/Icons";
import { AlbumNameField } from "../components/AlbumNameField";
import { ExportChip } from "../components/CanvasExportChip";
import { shelfSheets, ShelfSheetItems } from "../components/CanvasSheet";
import type { CanvasGalleryOut, AlbumOut, ImageOut, SmartAlbumOut } from "../api/types";

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

// --- The Canvas Shelf -------------------------------------------------------
//
// Albums whose canvas opted in ("Canvas Shelf", chosen inside the canvas)
// appear here as a print-style preview: the paper itself with the photos on
// it, drawn from the album's chosen VERSION - the one last kept or last
// loaded - never from the autosaving working draft. A card opens the
// full-screen print view below, for LOOKING and exporting only: editing stays
// in the album's own canvas.

function CanvasCard({
  canvas,
  onOpen,
  onRemove,
}: {
  canvas: CanvasGalleryOut;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const sheet = useMemo(() => shelfSheets(canvas)[0], [canvas]);

  const caption = [
    `“${canvas.version_name}”`,
    `${canvas.version_count} ${canvas.version_count === 1 ? "version" : "versions"}`,
    canvas.page_mode === "pages" && canvas.page_count > 1 ? `${canvas.page_count} pages` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="canvas-shelf-card">
      <button
        type="button"
        className="canvas-shelf-open"
        onClick={onOpen}
        title={`Show “${canvas.canvas_name}” as it will print`}
      >
        <div
          className="canvas-shelf-paper"
          style={{ background: canvas.background, aspectRatio: `${sheet.w} / ${sheet.h}` }}
        >
          <ShelfSheetItems canvas={canvas} sheet={sheet} />
        </div>
        <div className="canvas-shelf-caption">
          <div className="canvas-shelf-name">{canvas.canvas_name}</div>
          <div className="canvas-shelf-meta">{caption}</div>
        </div>
      </button>
      {/* Same × as the album cards - but this one only takes the canvas off
          the shelf. Deleting a canvas stays inside the canvas itself. */}
      <button
        className="card-remove"
        title="Take off the Canvas Shelf (the canvas and its versions are kept)"
        aria-label={`Take “${canvas.canvas_name}” off the Canvas Shelf`}
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
      >
        ×
      </button>
    </div>
  );
}

// Room kept around the sheet, as in the canvas's print view: the arrows live
// in the side bands, the caption in the bottom one.
const SHELF_PAD_X = 84;
const SHELF_PAD_Y = 64;
const SHELF_IDLE_MS = 2200;

// The full-screen print view of one shelf canvas. Deliberately read-only: the
// only things that work here are the print view's own moves - turn the pages,
// zoom about the cursor, drag the sheet, Escape out - and Export. Changing the
// design means opening the album's canvas.
function CanvasShelfViewer({ canvas, onClose }: { canvas: CanvasGalleryOut; onClose: () => void }) {
  const sheets = useMemo(() => shelfSheets(canvas), [canvas]);
  const [index, setIndex] = useState(0);
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  // The controls fade once the pointer has settled, so a page can be looked
  // at with nothing at all around it; any movement brings them back.
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | null>(null);
  // A closer look: the wheel zooms about the cursor, a drag moves the page.
  // scale 1 = the whole sheet fit in the window; x/y displace its centre, in
  // screen pixels.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [look, setLook] = useState({ scale: 1, x: 0, y: 0 });
  const lookRef = useRef(look);
  lookRef.current = look;
  const pan = useRef<{ id: number; x: number; y: number } | null>(null);
  const [panning, setPanning] = useState(false);

  // What the Export chip needs: the version's document dressed as a full
  // layout (the editing aids are irrelevant to an export), and just enough of
  // an ImageOut per photo to build its export URL with the right cache-buster.
  const doc = useMemo(
    () => ({
      page_mode: canvas.page_mode,
      page_width_mm: canvas.page_width_mm,
      page_height_mm: canvas.page_height_mm,
      page_count: canvas.page_count,
      background: canvas.background,
      show_grid: false,
      grid_mm: 10,
      snap: true,
      show_page_guide: canvas.show_page_guide,
      show_in_canvases: true,
      items: canvas.items,
    }),
    [canvas]
  );
  const byId = useMemo(() => {
    const map = new Map<string, ImageOut>();
    for (const [id, version] of Object.entries(canvas.thumb_versions)) {
      map.set(id, { id, edit_rev: Number(version) || 0 } as unknown as ImageOut);
    }
    return map;
  }, [canvas]);

  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), SHELF_IDLE_MS);
  }, []);

  useEffect(() => {
    wake();
    return () => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    };
  }, [wake]);

  useEffect(() => {
    function onResize() {
      setSize({ w: window.innerWidth, h: window.innerHeight });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const last = sheets.length - 1;
  const go = useCallback(
    (to: number) => {
      setIndex(Math.max(0, Math.min(last, to)));
      wake();
    },
    [last, wake]
  );

  // Every page opens at fit: a zoom is an inspection of THIS page.
  useEffect(() => {
    setLook({ scale: 1, x: 0, y: 0 });
  }, [index]);

  // The wheel zooms about the cursor. Bound by hand because React registers
  // wheel handlers passively, and a passive handler cannot preventDefault.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const from = lookRef.current;
      const scale = Math.max(1, Math.min(10, from.scale * Math.exp(-event.deltaY * 0.0022)));
      if (scale === from.scale) return;
      if (scale === 1) {
        setLook({ scale: 1, x: 0, y: 0 });
      } else {
        const cx = event.clientX - window.innerWidth / 2;
        const cy = event.clientY - window.innerHeight / 2;
        const ratio = scale / from.scale;
        setLook({ scale, x: cx - (cx - from.x) * ratio, y: cy - (cy - from.y) * ratio });
      }
      wake();
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [wake]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          onClose();
          return;
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
        case " ":
          event.preventDefault();
          go(index + 1);
          return;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          event.preventDefault();
          go(index - 1);
          return;
        case "Home":
          event.preventDefault();
          go(0);
          return;
        case "End":
          event.preventDefault();
          go(last);
          return;
        case "0":
          event.preventDefault();
          setLook({ scale: 1, x: 0, y: 0 });
          return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go, index, last, onClose]);

  // Fetch the neighbouring sheets' photos ahead of time, so turning a page
  // shows a page and not a page filling in.
  useEffect(() => {
    for (const near of [index + 1, index - 1]) {
      const sheet = sheets[near];
      if (!sheet) continue;
      for (const item of sheet.items) {
        if (item.kind !== "photo" || !item.image_id || item.available === false) continue;
        new Image().src = api.images.previewUrl(
          item.image_id,
          canvas.thumb_versions[item.image_id] ?? DEFAULT_EDIT_VERSION
        );
      }
    }
  }, [canvas, index, sheets]);

  const sheet = sheets[Math.min(index, last)];
  const zoom = Math.max(
    0.01,
    Math.min((size.w - SHELF_PAD_X * 2) / sheet.w, (size.h - SHELF_PAD_Y * 2) / sheet.h)
  );

  return createPortal(
    <div
      ref={boxRef}
      className={`canvas-print${idle ? " is-idle" : ""}${panning ? " is-panning" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={`“${canvas.canvas_name}” print view`}
      onPointerDown={(event) => {
        wake();
        if (event.button !== 0) return;
        if ((event.target as Element).closest("button, .filter-chip")) return;
        pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        setPanning(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        wake();
        const start = pan.current;
        if (!start || start.id !== event.pointerId) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (!dx && !dy) return;
        pan.current = { id: start.id, x: event.clientX, y: event.clientY };
        setLook((from) => ({ ...from, x: from.x + dx, y: from.y + dy }));
      }}
      onPointerUp={() => {
        pan.current = null;
        setPanning(false);
      }}
      onPointerCancel={() => {
        pan.current = null;
        setPanning(false);
      }}
      onDoubleClick={(event) => {
        // In for a closer look, back out to the whole page - about the point
        // that was double-clicked.
        if ((event.target as Element).closest("button, .filter-chip")) return;
        const from = lookRef.current;
        if (from.scale > 1) {
          setLook({ scale: 1, x: 0, y: 0 });
        } else {
          const scale = 2.5;
          const cx = event.clientX - window.innerWidth / 2;
          const cy = event.clientY - window.innerHeight / 2;
          setLook({ scale, x: cx - (cx - from.x) * scale, y: cy - (cy - from.y) * scale });
        }
        wake();
      }}
    >
      <div
        className="canvas-print-sheet canvas-shelf-view"
        style={{
          width: sheet.w * zoom,
          height: sheet.h * zoom,
          background: canvas.background,
          transform: `translate(${look.x}px, ${look.y}px) scale(${look.scale})`,
        }}
      >
        <ShelfSheetItems canvas={canvas} sheet={sheet} detail />
      </div>

      {sheets.length > 1 && (
        <>
          <button
            className="lightbox-nav-btn lightbox-nav-prev canvas-print-chrome"
            onClick={() => go(index - 1)}
            disabled={index === 0}
            aria-label="Previous page"
            title="Previous page (←)"
          >
            <IconChevronLeft size={20} />
          </button>
          <button
            className="lightbox-nav-btn lightbox-nav-next canvas-print-chrome"
            onClick={() => go(index + 1)}
            disabled={index === last}
            aria-label="Next page"
            title="Next page (→)"
          >
            <IconChevronRight size={20} />
          </button>
        </>
      )}

      {/* One bottom bar, like the photo stages' toolbars: the standard Back
          flush left, the caption centred, Export flush right. */}
      <div className="canvas-print-foot canvas-print-chrome" aria-live="polite">
        <button
          className="btn btn-sm back-btn stage-back-btn"
          onClick={onClose}
          title="Back to the albums (Escape)"
        >
          <IconArrowLeft size={13} /> Back
        </button>
        {canvas.canvas_name} · “{canvas.version_name}”
        {sheets.length > 1 ? ` · Page ${index + 1} of ${sheets.length}` : ""}
        <span className="canvas-print-hint">Scroll to zoom · drag to move · Esc to come back</span>
        <span className="canvas-print-export">
          <ExportChip doc={doc} byId={byId} title={canvas.canvas_name} drop="up" />
        </span>
      </div>
    </div>,
    document.body
  );
}

export function Albums() {
  const [name, setName] = useState("");
  const [newTags, setNewTags] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();

  // Which album card currently has its name open for editing (one at a time).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // The shelf canvas currently open in the full-screen print view.
  const [viewing, setViewing] = useState<CanvasGalleryOut | null>(null);

  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });
  const { data: allTags } = useQuery({ queryKey: ["tags"], queryFn: () => api.tags.list() });
  // The Canvases shelf: albums whose canvas opted in, each showing its chosen
  // kept version (see CanvasCard above).
  const { data: canvases } = useQuery({
    queryKey: ["canvases"],
    queryFn: () => api.canvases.gallery(),
  });

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
  // the photos stay in the library untouched, and canvases are their own
  // documents now, unaffected by album deletions.
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

  // The shelf card's ×: off the shelf, nothing more. The canvas and its kept
  // versions stay with the album - the checkbox inside the canvas re-shows it.
  async function removeFromShelf(canvas: CanvasGalleryOut) {
    if (
      !(await dialogs.confirm({
        title: `Take “${canvas.canvas_name}” off the Canvas Shelf?`,
        message:
          "Only the card is removed - the canvas and its kept versions stay untouched. Turn it back on inside the canvas (Versions → Canvas Shelf).",
        confirmLabel: "Take it off",
      }))
    )
      return;
    await api.canvases.setShelf(canvas.canvas_id, false);
    queryClient.invalidateQueries({ queryKey: ["canvases"] });
    // The canvas's own Versions panel reads this flag from the layout query.
    queryClient.invalidateQueries({ queryKey: ["canvas-layout", canvas.canvas_id] });
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
    <div className="page albums-page">
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
        {albums?.map((album) => {
          const renaming = renamingId === album.id;
          // Over a cover mosaic the box is white-on-dark like the caption it
          // replaces; on a bare card it follows the normal theme colours.
          const nameField = (inputClassName: string) => (
            <AlbumNameField
              albumId={album.id}
              name={album.name}
              editing={renaming}
              onEditingChange={(on) => setRenamingId(on ? album.id : null)}
              inputClassName={inputClassName}
            />
          );
          const body = (
            <>
              {/* A peek inside the album: mini mosaic of its first photos with
                  the name overlaid, like the smart cards. Empty albums keep the
                  plain centered text. */}
              {album.cover_image_ids.length > 0 ? (
                <>
                  <CoverMosaic imageIds={album.cover_image_ids} />
                  <div className="smart-card-caption">
                    <div className="smart-card-name">{nameField("album-card-input")}</div>
                    <div className="smart-card-count">{albumCount(album)}</div>
                  </div>
                </>
              ) : (
                <div style={{ textAlign: "center", color: "var(--text)" }}>
                  <div style={{ fontWeight: 600 }}>{nameField("album-card-input album-card-input--plain")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{albumCount(album)}</div>
                </div>
              )}
              {!renaming && (
                <button
                  className="card-rename"
                  title="Rename album"
                  aria-label={`Rename album ${album.name}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setRenamingId(album.id);
                  }}
                >
                  <IconPencil size={13} />
                </button>
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
            </>
          );
          const cardStyle = {
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textDecoration: "none",
          } as const;
          // While the name is being edited the tile stops being a link - a
          // click in the text box would otherwise open the album.
          return renaming ? (
            <div key={album.id} className="thumb-card has-remove" style={cardStyle}>
              {body}
            </div>
          ) : (
            <Link
              key={album.id}
              to={`/albums/${album.id}`}
              className="thumb-card has-remove"
              style={cardStyle}
            >
              {body}
            </Link>
          );
        })}
        {/* Same trailing spacer as the photo grids: soaks up final-row slack so
            a lone album card keeps its normal size instead of stretching huge. */}
        <i className="grid-filler" aria-hidden />
      </div>

      {canvases && canvases.length > 0 && (
        <section className="canvas-shelf-section">
          <h3 className="smart-row-title">
            Canvas Shelf
            <span className="smart-row-hint">The kept version of each album’s canvas - click to see it as it will print</span>
          </h3>
          <div className="canvas-shelf">
            {canvases.map((canvas) => (
              <CanvasCard
                key={canvas.canvas_id}
                canvas={canvas}
                onOpen={() => setViewing(canvas)}
                onRemove={() => removeFromShelf(canvas)}
              />
            ))}
          </div>
        </section>
      )}

      {viewing && <CanvasShelfViewer canvas={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

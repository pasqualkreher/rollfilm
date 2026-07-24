import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { LibraryIndexImage } from "../api/types";
import { api, DEFAULT_EDIT_VERSION } from "../api/client";
import { COLOR_HEX } from "./ColorLabelPicker";
import { TimelineScrubber } from "./TimelineScrubber";
import { Thumb, fileTypeBadge, fileTypeBadgeClass, tileAspectRatio } from "./ThumbnailGrid";
import { useMergePairs } from "../state/viewPrefs";
import { thumbPx, useThumbSize } from "../state/viewPrefs";
import { clearLastViewedImage, peekLastViewedImage } from "../utils/lastViewed";
import { preloadImage } from "../utils/preload";

// Layout constants mirroring the CSS grid (.thumbnail-grid gap, month header
// pill + margin, section spacing). They only need to be internally consistent:
// the virtual grid positions everything itself, so these ARE the layout.
const GAP = 12;
const HEADER_H = 34;
const HEADER_MB = 12;
const SECTION_MB = 8;
// How far beyond the viewport tiles are mounted. Large enough that normal
// scrolling always meets already-mounted tiles (whose thumbnails are loading
// via the near-viewport preloader), small enough that a jump across the
// library only mounts the landing area.
const OVERSCAN = 2000;
// Beyond the mounted band, thumbnails for the next stretch in both directions
// are pre-warmed into the browser's cache (see utils/preload.ts) - when those
// rows mount during scrolling, their pixels are already local.
const PREWARM = 3000;
// Scroll positions are quantized before landing in React state, so a smooth
// scroll re-renders every ~2 tile rows instead of every frame.
const SCROLL_QUANTUM = 400;

interface Tile {
  image: LibraryIndexImage;
  index: number; // position in the flat ordered list (drives range-select)
  left: number;
  width: number;
}

interface Row {
  top: number; // within the section
  height: number;
  tiles: Tile[];
}

interface Section {
  label: string;
  top: number; // within the whole timeline
  height: number;
  rows: Row[];
  count: number;
}

interface Layout {
  sections: Section[];
  totalHeight: number;
}

function monthLabel(iso: string | null): string {
  if (!iso) return "Unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// Justified-rows layout, the JS twin of the CSS flexbox grid (flex-grow: ar,
// flex-basis: ar*rowH): fill a row while the tiles' natural widths fit, then
// scale the row so it exactly spans the container. The last row of a section
// keeps its natural height (the CSS grid-filler equivalent). Positions are
// computed for EVERY photo up front - that's what makes the scrollbar exact
// and lets a scrubber jump land pixel-perfect on month boundaries.
function buildLayout(images: LibraryIndexImage[], width: number, rowH: number): Layout {
  const sections: Section[] = [];
  let y = 0;

  const flushSection = (label: string, group: { image: LibraryIndexImage; index: number }[]) => {
    const rows: Row[] = [];
    let innerY = HEADER_H + HEADER_MB;
    let pending: { image: LibraryIndexImage; index: number; ar: number }[] = [];
    let sumAr = 0;

    const flushRow = (last: boolean) => {
      if (pending.length === 0) return;
      const avail = width - GAP * (pending.length - 1);
      const natural = sumAr * rowH;
      // Underfull last row: keep the target height, left-aligned. Every other
      // row is justified to span the container exactly.
      const height = last && natural <= avail ? rowH : avail / sumAr;
      let x = 0;
      const tiles: Tile[] = pending.map((p) => {
        const w = p.ar * height;
        const tile = { image: p.image, index: p.index, left: x, width: w };
        x += w + GAP;
        return tile;
      });
      rows.push({ top: innerY, height, tiles });
      innerY += height + GAP;
      pending = [];
      sumAr = 0;
    };

    for (const entry of group) {
      const ar = tileAspectRatio(entry.image.width, entry.image.height);
      if (pending.length > 0 && (sumAr + ar) * rowH + GAP * pending.length > width) {
        flushRow(false);
      }
      pending.push({ ...entry, ar });
      sumAr += ar;
    }
    flushRow(true);

    const height = innerY - GAP + SECTION_MB;
    sections.push({ label, top: y, height, rows, count: group.length });
    y += height;
  };

  let currentLabel: string | null = null;
  let group: { image: LibraryIndexImage; index: number }[] = [];
  images.forEach((image, index) => {
    const label = monthLabel(image.taken_at);
    if (label !== currentLabel && group.length > 0) {
      flushSection(currentLabel!, group);
      group = [];
    }
    currentLabel = label;
    group.push({ image, index });
  });
  if (group.length > 0) flushSection(currentLabel!, group);

  return { sections, totalHeight: y };
}

interface Props {
  images: LibraryIndexImage[];
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string, index: number, shiftKey: boolean) => void;
  selectMode?: boolean;
}

// Virtualized library timeline: the layout of the ENTIRE (filtered) library is
// computed from the slim index - so the scroll range is exact from the first
// frame and dragging the scrollbar (or the date scrubber) anywhere lands
// directly on real, correctly-sized tiles - while only the tiles near the
// viewport are actually mounted, keeping the DOM and thumbnail traffic small
// no matter how big the library is.
export function VirtualTimeline({ images, selectedIds, onToggleSelect, selectMode }: Props) {
  const navigate = useNavigate();
  const mergePairs = useMergePairs();
  const rowH = thumbPx(useThumbSize());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const sectionEls = useRef<Map<string, HTMLElement>>(new Map());
  const [width, setWidth] = useState(0);
  const [window_, setWindow] = useState({ top: 0, bottom: 0 });
  // Unquantized scroll position (relative to the timeline root), for the
  // re-anchoring below - the quantized window state is too coarse for it.
  const lastScrollRef = useRef(0);

  const allIds = useMemo(() => images.map((im) => im.id), [images]);
  const layout = useMemo(
    () => (width > 0 ? buildLayout(images, width, rowH) : null),
    [images, width, rowH]
  );

  // While the library is empty the early-return below skips rendering the
  // root div entirely - so this must re-run when the first photos arrive
  // (very first import), or the observer never attaches, width stays 0 and
  // no layout is ever built until a remount (tab switch).
  const isEmpty = images.length === 0;

  // Track container width and the scroller's visible window (quantized, so
  // scrolling doesn't re-render per frame).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const scroller = (root.closest(".page-scroll") ?? root.parentElement) as HTMLElement;
    scrollerRef.current = scroller;

    const measure = () => {
      setWidth(root.clientWidth);
      const rootTop = root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      const top = scroller.scrollTop - rootTop;
      lastScrollRef.current = top;
      const raw = { top, bottom: top + scroller.clientHeight };
      setWindow((prev) => {
        const q = (v: number) => Math.round(v / SCROLL_QUANTUM) * SCROLL_QUANTUM;
        return q(prev.top) === q(raw.top) && q(prev.bottom) === q(raw.bottom) ? prev : raw;
      });
    };

    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    ro.observe(scroller);
    return () => {
      cancelAnimationFrame(raf);
      scroller.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [isEmpty]);

  // Re-anchor across layout changes: when the tile size (S/M/L), the window
  // width or the image set changes, every position shifts - raw scrollTop
  // would land on completely different photos and read as a jump. Instead,
  // find the photo row at the top of the viewport in the OLD layout and
  // scroll so that same photo sits at the same relative spot in the new one.
  const prevLayoutRef = useRef<Layout | null>(null);
  useLayoutEffect(() => {
    const prev = prevLayoutRef.current;
    prevLayoutRef.current = layout;
    const scroller = scrollerRef.current;
    const root = rootRef.current;
    if (!prev || !layout || prev === layout || !scroller || !root) return;

    const top = lastScrollRef.current;
    let anchorId: string | null = null;
    let frac = 0; // how far into the anchor row the viewport top sat
    outer: for (const s of prev.sections) {
      if (s.top + s.height <= top) continue;
      for (const r of s.rows) {
        const rowTop = s.top + r.top;
        if (rowTop + r.height > top) {
          anchorId = r.tiles[0]?.image.id ?? null;
          frac = Math.max(-0.5, Math.min(1, (top - rowTop) / r.height));
          break outer;
        }
      }
    }
    if (!anchorId) return;

    for (const s of layout.sections) {
      for (const r of s.rows) {
        if (r.tiles.some((t) => t.image.id === anchorId)) {
          const rootTop =
            root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
          scroller.scrollTop = rootTop + s.top + r.top + frac * r.height;
          return;
        }
      }
    }
  }, [layout]);

  // Returning from the detail view: jump straight to the photo the user was
  // looking at. With the full layout known this works for ANY photo in the
  // library - including ones far beyond where scrolling had reached before.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !layout || !scrollerRef.current || images.length === 0) return;
    restoredRef.current = true;
    const target = peekLastViewedImage();
    if (!target) return;
    clearLastViewedImage();
    for (const s of layout.sections) {
      for (const r of s.rows) {
        if (r.tiles.some((t) => t.image.id === target)) {
          const root = rootRef.current!;
          const scroller = scrollerRef.current!;
          const rootTop =
            root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
          scroller.scrollTop = rootTop + s.top + r.top - (scroller.clientHeight - r.height) / 2;
          return;
        }
      }
    }
  }, [layout, images.length]);

  // Pre-warm the browser cache for the stretches just outside the mounted
  // band, so tiles scrolling in have their pixels already local. Debounced:
  // warming fires only after the window has been stable for a moment, so
  // scrubbing/jumping across the library never floods the network with
  // uncancellable warm-up fetches for regions the user flew past - only the
  // place they actually stop at gets warmed. preloadImage dedups per URL.
  useEffect(() => {
    if (!layout) return;
    const timer = window.setTimeout(() => {
      const zones: [number, number][] = [
        [window_.bottom + OVERSCAN, window_.bottom + OVERSCAN + PREWARM],
        [window_.top - OVERSCAN - PREWARM, window_.top - OVERSCAN],
      ];
      for (const s of layout.sections) {
        for (const [zoneTop, zoneBottom] of zones) {
          if (s.top + s.height <= zoneTop || s.top >= zoneBottom) continue;
          for (const r of s.rows) {
            const rowTop = s.top + r.top;
            if (rowTop + r.height <= zoneTop || rowTop >= zoneBottom) continue;
            for (const t of r.tiles) {
              preloadImage(
                api.images.thumbnailUrl(t.image.id, t.image.thumb_version || DEFAULT_EDIT_VERSION)
              );
            }
          }
        }
      }

      // Also warm the DETAIL previews for what's actually on screen right now
      // (capped): clicking any visible photo then opens the lightbox with its
      // preview already in the browser cache - instant, no request round-trip.
      // A dozen previews are a few MB once; preloadImage dedups so photos that
      // stay in view cost nothing on subsequent passes.
      const VISIBLE_PREVIEW_CAP = 12;
      let warmed = 0;
      for (const s of layout.sections) {
        if (warmed >= VISIBLE_PREVIEW_CAP) break;
        if (s.top + s.height <= window_.top || s.top >= window_.bottom) continue;
        for (const r of s.rows) {
          if (warmed >= VISIBLE_PREVIEW_CAP) break;
          const rowTop = s.top + r.top;
          if (rowTop + r.height <= window_.top || rowTop >= window_.bottom) continue;
          for (const t of r.tiles) {
            if (warmed >= VISIBLE_PREVIEW_CAP) break;
            preloadImage(
              api.images.previewUrl(t.image.id, t.image.thumb_version || DEFAULT_EDIT_VERSION)
            );
            warmed++;
          }
        }
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [layout, window_]);

  if (images.length === 0) {
    return <div className="empty-state">No photos here yet.</div>;
  }

  const winTop = window_.top - OVERSCAN;
  const winBottom = window_.bottom + OVERSCAN;

  function renderTile(tile: Tile, row: Row) {
    const { image, index } = tile;
    const merged = mergePairs && Boolean(image.paired_image_id);
    return (
      <div
        key={image.id}
        className={`thumb-card${selectMode && selectedIds?.has(image.id) ? " selected" : ""}`}
        style={{
          position: "absolute",
          top: row.top,
          left: tile.left,
          width: tile.width,
          height: row.height,
        }}
        onClick={(e) => {
          if (selectMode && onToggleSelect) {
            onToggleSelect(image.id, index, e.shiftKey);
          } else {
            navigate(`/image/${image.id}`, { state: { imageIds: allIds } });
          }
        }}
      >
        <Thumb
          src={api.images.thumbnailUrl(image.id, image.thumb_version || DEFAULT_EDIT_VERSION)}
          alt={image.original_filename}
        />
        <span className={fileTypeBadgeClass(image.file_type, merged)}>
          {fileTypeBadge(image.file_type, merged)}
        </span>
        {selectMode && onToggleSelect && (
          <input
            className="select-checkbox"
            type="checkbox"
            checked={selectedIds?.has(image.id) ?? false}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect(image.id, index, e.shiftKey);
            }}
            onChange={() => {}}
          />
        )}
        {(image.rating > 0 || image.color_label !== "none") && (
          <div className="overlay-info">
            <span className="overlay-stars">{image.rating > 0 ? "★".repeat(image.rating) : ""}</span>
            {image.color_label !== "none" && (
              <span
                className="overlay-color-dot"
                style={{ background: COLOR_HEX[image.color_label] }}
                title={image.color_label}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="timeline has-scrubber"
      style={{ position: "relative", display: "block", height: layout?.totalHeight }}
    >
      {layout?.sections.map((section) => {
        const sectionVisible = section.top < winBottom && section.top + section.height > winTop;
        return (
          <section
            key={section.label}
            className="timeline-section"
            ref={(el) => {
              if (el) sectionEls.current.set(section.label, el);
              else sectionEls.current.delete(section.label);
            }}
            style={{
              position: "absolute",
              top: section.top,
              left: 0,
              right: 0,
              height: section.height,
              margin: 0,
            }}
          >
            <h3 className="timeline-header">
              {section.label}
              <span className="timeline-header-count">{section.count}</span>
            </h3>
            {/* Tiles are positioned against the section itself (row.top already
                includes the header's space), not wrapped in a flow container -
                the sticky header renders above them via its own z-index.
                flatMap (not nested map) so the visible tiles are ONE flat list
                of key={image.id} children: React then reconciles every tile by
                its stable id no matter which row it's in. A nested map yields an
                array-per-row, which React matches positionally - so on a slow
                scroll, when the top row drops out of the filter every row-array
                shifts one slot, the keyed tiles land in a different slot than
                last frame, and React remounts their <img>s (reload + re-run the
                fade-in) instead of moving them. That remount was the flicker. */}
            {sectionVisible &&
              section.rows
                .filter(
                  (row) =>
                    section.top + row.top < winBottom && section.top + row.top + row.height > winTop
                )
                .flatMap((row) => row.tiles.map((tile) => renderTile(tile, row)))}
          </section>
        );
      })}

      <TimelineScrubber
        getScroller={() => scrollerRef.current}
        getSectionEl={(label) => sectionEls.current.get(label) ?? null}
        sections={(layout?.sections ?? []).map((s) => ({ label: s.label }))}
      />
    </div>
  );
}

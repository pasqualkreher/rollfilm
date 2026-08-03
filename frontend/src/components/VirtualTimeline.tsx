import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { LibraryIndexImage } from "../api/types";
import { api, DEFAULT_EDIT_VERSION } from "../api/client";
import { COLOR_HEX } from "./ColorLabelPicker";
import { TimelineScrubber } from "./TimelineScrubber";
import { Thumb, fileTypeBadge, fileTypeBadgeClass, tileAspectRatio } from "./ThumbnailGrid";
import { useMergePairs } from "../state/viewPrefs";
import { thumbPx, thumbTier, useThumbSize } from "../state/viewPrefs";
import {
  clearLastViewedImage,
  peekLastViewedTarget,
  rememberLastViewedImageAt,
} from "../utils/lastViewed";
import { preloadImage } from "../utils/preload";
import {
  GAP,
  overscanFor,
  buildJustifiedLayout,
  useVirtualWindow,
  type JustifiedLayout,
  type LayoutRow,
  type LayoutTile,
} from "../utils/justifiedLayout";

// Layout, constants and the scroll-window tracking are shared with the import
// review's grid - see utils/justifiedLayout.ts. Only what this timeline does
// with them (month sections, navigation, re-anchoring) lives here.

// Beyond the mounted band, thumbnails for the next stretch in both directions
// are pre-warmed into the browser's cache (see utils/preload.ts) - when those
// rows mount during scrolling, their pixels are already local.
const PREWARM = 3000;

type Tile = LayoutTile<LibraryIndexImage>;
type Row = LayoutRow<LibraryIndexImage>;
type Layout = JustifiedLayout<LibraryIndexImage>;

function monthLabel(iso: string | null): string {
  if (!iso) return "Unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

interface Props {
  images: LibraryIndexImage[];
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string, index: number, shiftKey: boolean) => void;
  selectMode?: boolean;
  // When this key changes (the Library's filters), the view jumps to the top
  // of the new result set instead of re-anchoring to the photo that happened
  // to be on screen - a filtered library is a different list, and the old
  // position pointed somewhere arbitrary in it.
  resetKey?: string;
}

// Virtualized library timeline: the layout of the ENTIRE (filtered) library is
// computed from the slim index - so the scroll range is exact from the first
// frame and dragging the scrollbar (or the date scrubber) anywhere lands
// directly on real, correctly-sized tiles - while only the tiles near the
// viewport are actually mounted, keeping the DOM and thumbnail traffic small
// no matter how big the library is.
export function VirtualTimeline({ images, selectedIds, onToggleSelect, selectMode, resetKey }: Props) {
  const navigate = useNavigate();
  const mergePairs = useMergePairs();
  const thumbSize = useThumbSize();
  const rowH = thumbPx(thumbSize);
  // XS/S request the 640px tier - full 1600px thumbnails overflow the
  // renderer's decoded-image budget at those densities (see thumbTier).
  const tier = thumbTier(thumbSize);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sectionEls = useRef<Map<string, HTMLElement>>(new Map());

  const allIds = useMemo(() => images.map((im) => im.id), [images]);
  const { width, window: window_, scrollerRef, lastScrollRef } = useVirtualWindow(
    rootRef,
    images.length > 0
  );
  const layout = useMemo(
    () =>
      width > 0
        ? buildJustifiedLayout(images, {
            width,
            rowHeight: rowH,
            labelOf: (image) => monthLabel(image.taken_at),
            aspectOf: (image) => tileAspectRatio(image.width, image.height),
          })
        : null,
    [images, width, rowH]
  );


  // A filter change means a NEW result set: jump to its top right away (the
  // old grid is still shown until the new index arrives), and remember to skip
  // the re-anchoring below once the new layout lands - it would otherwise
  // chase the previously-visible photo to wherever it sits in the filtered set.
  const pendingResetRef = useRef(false);
  const prevResetKeyRef = useRef(resetKey);
  useEffect(() => {
    if (prevResetKeyRef.current === resetKey) return;
    prevResetKeyRef.current = resetKey;
    pendingResetRef.current = true;
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [resetKey]);

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

    if (pendingResetRef.current) {
      pendingResetRef.current = false;
      scroller.scrollTop = 0;
      return;
    }

    const top = lastScrollRef.current;
    let anchors: Set<string> | null = null;
    let frac = 0; // how far into the anchor row the viewport top sat
    outer: for (const s of prev.sections) {
      if (s.top + s.height <= top) continue;
      for (const r of s.rows) {
        const rowTop = s.top + r.top;
        if (rowTop + r.height > top) {
          // Every photo in the anchor row AND each one's RAW/JPEG partner.
          // Anchoring on a single id broke exactly when the id was the half
          // that just disappeared - toggling "Merge RAW+JPG" drops every RAW
          // from the list, so the anchor was nowhere in the new layout, no
          // scroll correction ran, and the old offset pointed into a grid
          // that had shrunk underneath it. That was the jump. The partner
          // card shows the same shot, so it re-anchors seamlessly; the same
          // holds for the RAW/JPEG view-mode switch.
          anchors = new Set<string>();
          for (const t of r.tiles) {
            anchors.add(t.item.id);
            if (t.item.paired_image_id) anchors.add(t.item.paired_image_id);
          }
          frac = Math.max(-0.5, Math.min(1, (top - rowTop) / r.height));
          break outer;
        }
      }
    }
    if (!anchors || anchors.size === 0) return;

    // First row holding any of them: the anchor row's photos stay contiguous
    // in the new list, so that row is where the viewport top belongs.
    for (const s of layout.sections) {
      for (const r of s.rows) {
        if (r.tiles.some((t) => anchors!.has(t.item.id))) {
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
    const target = peekLastViewedTarget();
    if (!target) return;
    clearLastViewedImage();
    for (const s of layout.sections) {
      for (const r of s.rows) {
        if (r.tiles.some((t) => t.item.id === target.id)) {
          const root = rootRef.current!;
          const scroller = scrollerRef.current!;
          const rootTop =
            root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
          const rowTop = rootTop + s.top + r.top;
          // Put the photo back exactly where it was when it was clicked. Only
          // a photo the user arrowed to in the detail view (no recorded
          // offset) gets centred - it had no tile position to return to.
          scroller.scrollTop =
            target.offset !== undefined
              ? rowTop - target.offset
              : rowTop - (scroller.clientHeight - r.height) / 2;
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
      // Just outside the mounted band, which now moves with the tile size.
      const mounted = overscanFor(rowH);
      const zones: [number, number][] = [
        [window_.bottom + mounted, window_.bottom + mounted + PREWARM],
        [window_.top - mounted - PREWARM, window_.top - mounted],
      ];
      for (const s of layout.sections) {
        for (const [zoneTop, zoneBottom] of zones) {
          if (s.top + s.height <= zoneTop || s.top >= zoneBottom) continue;
          for (const r of s.rows) {
            const rowTop = s.top + r.top;
            if (rowTop + r.height <= zoneTop || rowTop >= zoneBottom) continue;
            for (const t of r.tiles) {
              preloadImage(
                api.images.thumbnailUrl(t.item.id, t.item.thumb_version || DEFAULT_EDIT_VERSION, tier)
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
              api.images.previewUrl(t.item.id, t.item.thumb_version || DEFAULT_EDIT_VERSION)
            );
            warmed++;
          }
        }
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [layout, window_, rowH, tier]);

  if (images.length === 0) {
    return <div className="empty-state">No photos here yet.</div>;
  }

  const overscan = overscanFor(rowH);
  const winTop = window_.top - overscan;
  const winBottom = window_.bottom + overscan;

  function renderTile(tile: Tile, row: Row) {
    const { item: image, index } = tile;
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
            // Record where this tile sits in the viewport, so coming back
            // lands on this exact spot rather than re-centring the photo.
            const scroller = scrollerRef.current;
            if (scroller) {
              rememberLastViewedImageAt(
                image.id,
                e.currentTarget.getBoundingClientRect().top -
                  scroller.getBoundingClientRect().top
              );
            }
            navigate(`/image/${image.id}`, { state: { imageIds: allIds } });
          }
        }}
      >
        <Thumb
          src={api.images.thumbnailUrl(image.id, image.thumb_version || DEFAULT_EDIT_VERSION, tier)}
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { LibraryIndexImage } from "../api/types";
import { api, DEFAULT_EDIT_VERSION } from "../api/client";
import { COLOR_HEX } from "./ColorLabelPicker";
import { TimelineScrubber } from "./TimelineScrubber";
import { Thumb, fileTypeBadge, fileTypeBadgeClass, tileAspectRatio } from "./ThumbnailGrid";
import { usePhotoInfoCard } from "./PhotoInfoCard";
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
  useLayoutScrollAnchor,
  useVirtualWindow,
  type LayoutRow,
  type LayoutTile,
} from "../utils/justifiedLayout";

// Layout, constants and the scroll-window tracking are shared with the import
// review's grid - see utils/justifiedLayout.ts. Only what this timeline does
// with them (month sections, navigation, re-anchoring) lives here.

type Tile = LayoutTile<LibraryIndexImage>;
type Row = LayoutRow<LibraryIndexImage>;

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
  // The per-tile "i" that opens a photo's details. Hidden while selecting -
  // the tile's top-left corner is the checkbox's there.
  const { infoButton, overlay: infoOverlay } = usePhotoInfoCard(!selectMode);

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


  // Re-anchoring across layout changes (tile size, window width, a new filtered
  // set) is shared with the import review grid - see useLayoutScrollAnchor.
  useLayoutScrollAnchor({
    layout,
    rootRef,
    scrollerRef,
    lastScrollRef,
    partnerIdOf: (image) => image.paired_image_id,
    resetKey,
  });

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

  // Warm the DETAIL previews for what's actually on screen right now (capped):
  // clicking any visible photo then opens the lightbox with its preview already
  // in the browser cache - instant, no request round-trip. A dozen previews are
  // a few MB once; preloadImage dedups so photos that stay in view cost nothing
  // on subsequent passes. Debounced, so scrubbing or scrolling across the
  // library only warms the place the user actually stops at.
  //
  // Thumbnails are deliberately NOT warmed this way. An Image() fetch cannot be
  // cancelled, so a pass over the rows outside the viewport went on competing
  // with the visible tiles for the ~6 per-origin connections long after the
  // user had scrolled somewhere else - which is what made a grid feel like it
  // was loading the whole library. Tiles request themselves as they approach
  // the viewport (see Thumb / START_MARGIN), and drop the request the moment
  // they fall away again.
  useEffect(() => {
    if (!layout) return;
    const timer = window.setTimeout(() => {
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
  }, [layout, window_]);

  // Stable identities for everything the scrubber is handed. These all used to
  // be built fresh on every render, and they sit in the scrubber's recompute
  // deps - so its scroll listener was torn down and re-attached on every
  // scroll step.
  const getScroller = useCallback(() => scrollerRef.current, []);
  const getSectionEl = useCallback((key: string) => sectionEls.current.get(key) ?? null, []);
  // Identified by `key`, not by the month's name: a photo sitting out of date
  // order splits a month into two sections that are both called "June 2024",
  // and keying either map by the name drops one of them (see LayoutSection.key).
  const scrubberSections = useMemo(
    () => (layout?.sections ?? []).map((s) => ({ key: s.key, label: s.label })),
    [layout]
  );

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
          rowHeight={rowH}
        />
        <span className={fileTypeBadgeClass(image.file_type, merged)}>
          {fileTypeBadge(image.file_type, merged)}
        </span>
        {infoButton(image.id)}
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
      {/* Every section stays mounted, not just the visible ones: the scrubber's
          rail is built by MEASURING these elements, so unmounting the
          off-screen months silently shrinks the rail to whatever happens to be
          on screen. Only the tiles inside are virtualized. */}
      {layout?.sections.map((section) => {
        const sectionVisible = section.top < winBottom && section.top + section.height > winTop;
        return (
          <section
            key={section.key}
            className="timeline-section"
            ref={(el) => {
              if (el) sectionEls.current.set(section.key, el);
              else sectionEls.current.delete(section.key);
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
        getScroller={getScroller}
        getSectionEl={getSectionEl}
        sections={scrubberSections}
      />
      {infoOverlay}
    </div>
  );
}

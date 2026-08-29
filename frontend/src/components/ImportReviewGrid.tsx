import { useEffect, useMemo, useRef } from "react";
import { api } from "../api/client";
import type { ColorLabel, StagedFileOut, ViewMode } from "../api/types";
import { RatingStars } from "./RatingStars";
import { ColorLabelPicker } from "./ColorLabelPicker";
import { TimelineScrubber } from "./TimelineScrubber";
import { Thumb, fileTypeBadge, fileTypeBadgeClass, tileAspectRatio } from "./ThumbnailGrid";
import { thumbPx, useThumbSize } from "../state/viewPrefs";
import { GRID_PIN_LIMIT, preloadImage } from "../utils/preload";
import {
  overscanFor,
  buildJustifiedLayout,
  useLayoutScrollAnchor,
  useVirtualWindow,
  type LayoutRow,
  type LayoutTile,
} from "../utils/justifiedLayout";

// Byte-identical to a photo already in the library or elsewhere in this same
// batch - the backend refuses to import these, so the UI shouldn't let you
// select them in the first place. Exception: a copy of a photo sitting in the
// Trash may be imported (it restores that photo), so it stays selectable.
// A flagged duplicate is always an identical file: nothing is flagged for
// merely looking alike, so there is no "maybe" case to keep selectable.
export function isDuplicate(f: StagedFileOut): boolean {
  return Boolean(f.duplicate_of_image_id || f.duplicate_of_staged_file_id) && !f.duplicate_in_trash;
}

// Height reserved under each thumbnail for the rating stars and colour
// swatches, mirroring what .import-card-footer draws: 6px padding, two rows of
// --sym-sized symbols, 4px between them, 6px padding. --sym follows the grid
// size exactly as the CSS clamp does. Handed to the CSS as --card-footer-h so
// the two can't drift - the layout has to know a card's full height before the
// card exists.
function footerHeight(rowHeight: number): number {
  const sym = Math.min(Math.max(9, rowHeight * 0.05 - 2), 16);
  return Math.round(16 + 2 * sym);
}

export function dayLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// Whole-section selection for the day headers. The wizard owns the counting
// (it has the unfiltered batch and the pair partners); the grid only draws the
// controls and reports clicks back.
export interface SectionSelect {
  // null when the section has nothing selectable in it (e.g. an all-duplicate
  // day) - the header then draws no controls at all. `month`/`year` are null
  // when the batch doesn't span more than one, where they'd duplicate
  // "Select all".
  infoOf: (label: string) => {
    day: SectionSelectState;
    month: SectionSelectState | null;
    year: SectionSelectState | null;
    monthLabel: string;
    yearLabel: string;
  } | null;
  onToggle: (label: string, scope: "day" | "month" | "year") => void;
}

export type SectionSelectState = "none" | "some" | "all";

interface Props {
  sessionId: string;
  // Already filtered and ordered - the flat list every index refers to.
  files: StagedFileOut[];
  // Capture date used for sectioning; the wizard resolves it (EXIF, falling
  // back to the paired file's) so both halves of a pair sit under one day.
  takenAtOf: (file: StagedFileOut) => string | null;
  selectMode: boolean;
  mergePairs: boolean;
  viewMode: ViewMode;
  onToggleSelect: (index: number, shiftKey: boolean) => void;
  sectionSelect?: SectionSelect;
  onOpen: (index: number) => void;
  onPatch: (fileId: string, patch: { rating?: number; color_label?: ColorLabel }) => void;
  // Previews are only worth warming once the import has finished copying and
  // analyzing - before that, asking for one makes the server render it on the
  // spot, competing with the import that is producing them.
  warmPreviews: boolean;
  // Date-rail ticks, built by the wizard from the same dayLabel() this grid
  // sections by - so a tick always finds its section element.
  scrubberSections: {
    label: string;
    tickGroup?: string;
    tickPrimary?: string;
    tickSecondary?: string;
  }[];
  getBottomInset?: () => number;
  // Changes when the review filters do - a filtered batch is a new list, so the
  // grid jumps to its top instead of chasing the photo that was on screen.
  resetKey?: string;
}

// The import review grid, virtualized exactly like the library timeline
// (utils/justifiedLayout.ts): the whole batch is laid out up front so the
// scrollbar and the date scrubber are exact, but only the cards near the
// viewport are mounted. It used to render every card - at a few thousand
// photos that is tens of thousands of DOM nodes re-rendered on every poll of
// a running import, which is what made reviewing a big card crawl.
export function ImportReviewGrid({
  sessionId,
  files,
  takenAtOf,
  selectMode,
  mergePairs,
  viewMode,
  onToggleSelect,
  sectionSelect,
  onOpen,
  onPatch,
  warmPreviews,
  scrubberSections,
  getBottomInset,
  resetKey,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sectionEls = useRef<Map<string, HTMLElement>>(new Map());
  const rowH = thumbPx(useThumbSize());
  const footerH = footerHeight(rowH);
  const { width, window: window_, scrollerRef, lastScrollRef } = useVirtualWindow(
    rootRef,
    files.length > 0
  );

  const layout = useMemo(
    () =>
      width > 0
        ? buildJustifiedLayout(files, {
            width,
            rowHeight: rowH,
            // Files still being analyzed have no date yet; they group under one
            // unlabeled section rather than shouting "Unknown date" at every
            // mid-import state.
            labelOf: (file) => dayLabel(takenAtOf(file)),
            aspectOf: (file) => tileAspectRatio(file.width, file.height),
            rowExtra: footerH,
          })
        : null,
    [files, width, rowH, footerH, takenAtOf]
  );

  // Hold the scroll position across every layout rebuild. An import reflows
  // constantly while a card is being read in: each poll appends freshly copied
  // photos, and every file whose EXIF is finally parsed leaves the dateless
  // tail for its own day section, pushing everything after it down. Without
  // this the grid slid under the user for as long as the SD card was copying.
  useLayoutScrollAnchor({
    layout,
    rootRef,
    scrollerRef,
    lastScrollRef,
    partnerIdOf: (file) => file.paired_staged_file_id,
    resetKey,
  });

  // Warm the full-size preview of the cards on screen, so opening one has
  // nothing left to fetch. Only what is actually mounted, and only once the
  // import is done - see `warmPreviews`.
  useEffect(() => {
    if (!layout || !warmPreviews) return;
    const timer = window.setTimeout(() => {
      let budget = GRID_PIN_LIMIT;
      for (const section of layout.sections) {
        if (budget <= 0) break;
        if (section.top + section.height <= window_.top || section.top >= window_.bottom) continue;
        for (const row of section.rows) {
          if (budget <= 0) break;
          const rowTop = section.top + row.top;
          if (rowTop + row.height <= window_.top || rowTop >= window_.bottom) continue;
          for (const tile of row.tiles) {
            if (budget-- <= 0) break;
            preloadImage(api.import.stagedPreviewUrl(sessionId, tile.item.id));
          }
        }
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [layout, window_, warmPreviews, sessionId]);

  if (files.length === 0) return null;

  const overscan = overscanFor(rowH);
  const winTop = window_.top - overscan;
  const winBottom = window_.bottom + overscan;

  // Tri-state tick in the day header: whole day selected, partly, or not at
  // all. Selecting a trip day at a time is the granularity an import batch
  // actually has - clicking through 300 cards to keep one afternoon was the
  // slow path this replaces.
  function renderSectionSelect(label: string) {
    if (!selectMode || !sectionSelect) return null;
    const info = sectionSelect.infoOf(label);
    if (!info) return null;
    return (
      <input
        className="section-select-checkbox"
        type="checkbox"
        checked={info.day === "all"}
        // "Partly selected" has no JSX attribute - it's a DOM property only.
        ref={(el) => {
          if (el) el.indeterminate = info.day === "some";
        }}
        onChange={() => sectionSelect.onToggle(label, "day")}
        title={`Select or clear every photo from ${label}`}
        aria-label={`Select or clear every photo from ${label}`}
      />
    );
  }

  // Wider scopes, shown only when the batch spans more than one month/year -
  // an archive folder holding several years, where ticking day by day would be
  // hopeless.
  function renderScopeButtons(label: string) {
    if (!selectMode || !sectionSelect) return null;
    const info = sectionSelect.infoOf(label);
    if (!info || (info.month === null && info.year === null)) return null;
    const button = (
      scope: "month" | "year",
      state: SectionSelectState,
      text: string,
      title: string
    ) => (
      <button
        type="button"
        className={`section-scope-btn${state === "all" ? " on" : state === "some" ? " partial" : ""}`}
        onClick={() => sectionSelect.onToggle(label, scope)}
        title={title}
      >
        {text}
      </button>
    );
    return (
      <span className="timeline-header-scopes">
        {info.month !== null &&
          button(
            "month",
            info.month,
            info.monthLabel,
            `Select or clear every photo from ${info.monthLabel} ${info.yearLabel}`
          )}
        {info.year !== null &&
          button(
            "year",
            info.year,
            info.yearLabel,
            `Select or clear every photo from ${info.yearLabel}`
          )}
      </span>
    );
  }

  function renderTile(tile: LayoutTile<StagedFileOut>, row: LayoutRow<StagedFileOut>) {
    const f = tile.item;
    const i = tile.index;
    const merged = mergePairs && viewMode === "combined" && Boolean(f.paired_staged_file_id);
    return (
      <div
        key={f.id}
        className={`import-card${f.selected ? " selected" : ""}`}
        style={{
          position: "absolute",
          top: row.top,
          left: tile.left,
          width: tile.width,
          height: row.height + footerH,
        }}
      >
        <div
          className={`thumb-card${f.selected ? " selected" : ""}`}
          style={{ height: row.height, flex: "none" }}
          // The pointer landing on a card is the earliest signal that this is
          // the photo about to be opened - warming here buys the preview the
          // moment before the click.
          onPointerEnter={() => preloadImage(api.import.stagedPreviewUrl(sessionId, f.id))}
          onClick={(e) => (selectMode ? onToggleSelect(i, e.shiftKey) : onOpen(i))}
          title={
            selectMode
              ? isDuplicate(f)
                ? "Already in your library - can't be imported"
                : f.duplicate_in_trash
                  ? "This photo is in the Trash - importing it restores it"
                  : "Click to tick, shift-click to tick or clear a whole range"
              : "Click to preview"
          }
        >
          {f.processed ? (
            <Thumb
              src={api.import.stagedThumbnailUrl(sessionId, f.id)}
              alt={f.original_filename}
              rowHeight={rowH}
            />
          ) : (
            // Copied but not yet analyzed - no thumbnail exists yet. The files
            // poll swaps this for the real Thumb when the background analysis
            // finishes this file. Shimmers like the album skeleton cards.
            <div className="thumb-analyzing" title="Analyzing…" />
          )}
          {selectMode && (
            <input
              className="select-checkbox"
              type="checkbox"
              checked={f.selected}
              disabled={isDuplicate(f)}
              onClick={(e) => {
                e.stopPropagation();
                onToggleSelect(i, e.shiftKey);
              }}
              onChange={() => {}}
            />
          )}
          {(f.duplicate_of_image_id || f.duplicate_of_staged_file_id) && (
            <span className="duplicate-badge">
              {f.duplicate_in_trash ? "In Trash - restores" : "Already in library"}
            </span>
          )}
          <span className={fileTypeBadgeClass(f.file_type, merged)}>
            {fileTypeBadge(f.file_type, merged)}
          </span>
        </div>
        {/* No per-card import checkbox: it's cramped at grid sizes and crowds
            the stars. Toggle import via "Select" mode (overlay checkbox /
            click) or in the large preview (Space key). */}
        <div className="import-card-footer">
          <RatingStars rating={f.rating} onChange={(rating) => onPatch(f.id, { rating })} />
          <ColorLabelPicker
            value={f.color_label}
            onChange={(color_label) => onPatch(f.id, { color_label })}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="timeline has-scrubber"
      style={{
        position: "relative",
        display: "block",
        height: layout?.totalHeight,
        ["--card-footer-h" as string]: `${footerH}px`,
      }}
    >
      {layout?.sections.map((section) => {
        const sectionVisible = section.top < winBottom && section.top + section.height > winTop;
        return (
          <section
            key={section.label || "dateless-tail"}
            className="timeline-section"
            ref={(el) => {
              if (!section.label) return; // headerless tail - no scrubber anchor
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
            {section.label && (
              <h3 className="timeline-header">
                {renderSectionSelect(section.label)}
                {section.label}
                <span className="timeline-header-count">{section.count}</span>
                {renderScopeButtons(section.label)}
              </h3>
            )}
            {/* flatMap, not a nested map: the visible tiles have to be ONE flat
                list of key={id} children or React matches them positionally
                per row, and a slow scroll then remounts every <img> as rows
                drop out of the filter. */}
            {sectionVisible &&
              section.rows
                .filter(
                  (row) =>
                    section.top + row.top < winBottom &&
                    section.top + row.top + row.height + footerH > winTop
                )
                .flatMap((row) => row.tiles.map((tile) => renderTile(tile, row)))}
          </section>
        );
      })}

      <TimelineScrubber
        getScroller={() => scrollerRef.current}
        getSectionEl={(label) => sectionEls.current.get(label) ?? null}
        sections={scrubberSections}
        getBottomInset={getBottomInset}
      />
    </div>
  );
}

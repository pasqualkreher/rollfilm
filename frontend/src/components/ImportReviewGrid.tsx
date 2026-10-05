import { useEffect, useMemo, useRef } from "react";
import { api } from "../api/client";
import type { ColorLabel, StagedFileOut, ViewMode } from "../api/types";
import { RatingStars } from "./RatingStars";
import { ColorLabelPicker } from "./ColorLabelPicker";
import { TimelineScrubber } from "./TimelineScrubber";
import { IconImport } from "./Icons";
import { Thumb, fileTypeBadge, fileTypeBadgeClass, tileAspectRatio } from "./ThumbnailGrid";
import { thumbPx, useThumbSize } from "../state/viewPrefs";
import { GRID_PIN_LIMIT, preloadImage } from "../utils/preload";
import { isSelectClick, modKeyLabel } from "../utils/selection";
import type { ReviewScrollAnchor } from "../utils/importReviewState";
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
// merely looking alike, so there is no "maybe" case to keep selectable. A file
// an earlier partial import of this session already added counts as one too.
export function isDuplicate(f: StagedFileOut): boolean {
  return flaggedDuplicate(f) && !f.duplicate_in_trash;
}

// Flagged at all - including the importable Trash case isDuplicate excludes.
export function flaggedDuplicate(f: StagedFileOut): boolean {
  return Boolean(f.duplicate_of_image_id || f.duplicate_of_staged_file_id || f.imported);
}

// Heights reserved under each thumbnail for the rating stars, colour swatches
// and import box, mirroring what .import-card-footer draws. --sym follows the
// grid size exactly as the CSS clamp does. Handed to the CSS as
// --card-footer-h / --card-footer-inline-h so the two can't drift - the layout
// has to know a card's full height before the card exists.
//
// Two arrangements: `stacked` is two rows (stars and import box, then the
// swatches: 6px padding, two rows of --sym-sized symbols, 4px between them,
// 6px padding), `inline` is everything on one line. A row of the grid goes
// inline when every card in it is at least `inlineMinWidth` wide, so the cards
// of one row always read the same and share one height.
function footerSizes(rowHeight: number) {
  const sym = Math.min(Math.max(9, rowHeight * 0.05 - 2), 16);
  const swatchGap = Math.max(1, rowHeight * 0.008);
  const swatch = Math.max(8, sym * 0.82);
  // The word "Import" at its CSS font size.
  const word = 3.3 * Math.max(9, sym * 0.8);
  return {
    stacked: Math.round(16 + 2 * sym),
    inline: Math.round(14 + sym),
    // 5 stars, the import symbol and box (7 symbols), 8 swatches and their
    // gaps, the word, and 60px of paddings, button insets and the two 12px
    // gaps between the groups.
    inlineMinWidth: 7 * sym + 8 * swatch + 7 * swatchGap + word + 60,
  };
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
  // when the batch doesn't span more than one, where they'd only repeat what
  // "Select all" already reaches.
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
  mergePairs: boolean;
  viewMode: ViewMode;
  // Flips the import checkbox in a card's footer. The wizard applies it to
  // every picked card when the card is one of them.
  onToggleSelect: (index: number) => void;
  // Cards picked the way the library picks photos (Cmd/Ctrl-click, Shift-click,
  // the corner checkbox once one is picked) - separate from importing. What
  // happens to them is decided in the wizard's bottom bar, or by the import
  // checkbox of one of them.
  markedIds: Set<string>;
  onToggleMark: (index: number, shiftKey: boolean) => void;
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
  // Where the grid stood when it was last unmounted (the wizard keeps it per
  // session): scrolled to once the first layout is built, so coming back to
  // the review lands on the same photos.
  initialScroll?: ReviewScrollAnchor | null;
  // Reports the photo at the top of the viewport while scrolling (debounced)
  // and once more on unmount - what `initialScroll` is fed from next time.
  onScrollAnchor?: (anchor: ReviewScrollAnchor) => void;
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
  mergePairs,
  viewMode,
  onToggleSelect,
  markedIds,
  onToggleMark,
  sectionSelect,
  onOpen,
  onPatch,
  warmPreviews,
  scrubberSections,
  getBottomInset,
  resetKey,
  initialScroll,
  onScrollAnchor,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sectionEls = useRef<Map<string, HTMLElement>>(new Map());
  const rowH = thumbPx(useThumbSize());
  const footer = useMemo(() => footerSizes(rowH), [rowH]);
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
            rowExtra: (tileWidths) =>
              tileWidths.every((w) => w >= footer.inlineMinWidth) ? footer.inline : footer.stacked,
          })
        : null,
    [files, width, rowH, footer, takenAtOf]
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

  // Coming back to the review: put the row that was at the top of the
  // viewport back there. One-shot, on the first layout that has photos; the
  // anchor's RAW/JPEG partner counts too, in case the pair merge or the view
  // mode changed which half of the shot is in the list.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !layout || !scrollerRef.current || files.length === 0) return;
    restoredRef.current = true;
    if (!initialScroll) return;
    const anchorFile = files.find((f) => f.id === initialScroll.id);
    const ids = new Set([initialScroll.id, anchorFile?.paired_staged_file_id ?? ""]);
    for (const s of layout.sections) {
      for (const r of s.rows) {
        if (r.tiles.some((t) => ids.has(t.item.id))) {
          const root = rootRef.current!;
          const scroller = scrollerRef.current!;
          const rootTop =
            root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
          scroller.scrollTop = rootTop + s.top + r.top + initialScroll.frac * r.height;
          return;
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, files.length]);

  // The photo currently at the top of the viewport, in the form the restore
  // above reads. Read at call time from the latest layout and scroll offset,
  // so a debounced report always describes where the grid is NOW.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onScrollAnchorRef = useRef(onScrollAnchor);
  onScrollAnchorRef.current = onScrollAnchor;
  const reportAnchor = () => {
    const cur = layoutRef.current;
    if (!cur || !restoredRef.current || !onScrollAnchorRef.current) return;
    const top = lastScrollRef.current;
    for (const s of cur.sections) {
      if (s.top + s.height <= top) continue;
      for (const r of s.rows) {
        const rowTop = s.top + r.top;
        if (rowTop + r.height > top && r.tiles.length > 0) {
          const frac = Math.max(-0.5, Math.min(1, (top - rowTop) / r.height));
          onScrollAnchorRef.current({ id: r.tiles[0].item.id, frac });
          return;
        }
      }
    }
  };
  const reportAnchorRef = useRef(reportAnchor);
  reportAnchorRef.current = reportAnchor;
  useEffect(() => {
    const timer = window.setTimeout(() => reportAnchorRef.current(), 300);
    return () => window.clearTimeout(timer);
  }, [window_.top]);
  // On unmount (the user left for another tab) the position must be exact,
  // not up to a debounce old.
  useEffect(() => () => reportAnchorRef.current(), []);

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

  // Once a card is picked every card grows a checkbox, exactly as in the
  // library grid.
  const selecting = markedIds.size > 0;

  const overscan = overscanFor(rowH);
  const winTop = window_.top - overscan;
  const winBottom = window_.bottom + overscan;

  // Tri-state tick in the day header: whole day selected, partly, or not at
  // all. Selecting a trip day at a time is the granularity an import batch
  // actually has - clicking through 300 cards to keep one afternoon was the
  // slow path this replaces.
  function renderSectionSelect(label: string) {
    if (!sectionSelect) return null;
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
        title={`Import or skip every photo from ${label}`}
        aria-label={`Import or skip every photo from ${label}`}
      />
    );
  }

  // Wider scopes, shown only when the batch spans more than one month/year -
  // an archive folder holding several years, where ticking day by day would be
  // hopeless.
  function renderScopeButtons(label: string) {
    if (!sectionSelect) return null;
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
            `Import or skip every photo from ${info.monthLabel} ${info.yearLabel}`
          )}
        {info.year !== null &&
          button(
            "year",
            info.year,
            info.yearLabel,
            `Import or skip every photo from ${info.yearLabel}`
          )}
      </span>
    );
  }

  function renderTile(tile: LayoutTile<StagedFileOut>, row: LayoutRow<StagedFileOut>) {
    const f = tile.item;
    const i = tile.index;
    const merged = mergePairs && viewMode === "combined" && Boolean(f.paired_staged_file_id);
    const marked = markedIds.has(f.id);
    const duplicate = isDuplicate(f);
    return (
      <div
        key={f.id}
        // Not going to be imported (unticked, or an exact duplicate): the
        // photo is dimmed, so what comes in reads at a glance.
        className={`import-card${f.selected && !duplicate ? "" : " skipped"}`}
        // A card is large: its tips show at the mouse, not under the card.
        data-tip-at="pointer"
        style={{
          position: "absolute",
          top: row.top,
          left: tile.left,
          width: tile.width,
          height: row.height + row.extra,
        }}
      >
        <div
          className={`thumb-card${marked ? " selected" : ""}`}
          style={{ height: row.height, flex: "none" }}
          // The pointer landing on a card is the earliest signal that this is
          // the photo about to be opened - warming here buys the preview the
          // moment before the click. Only once the import's own render pass is
          // done (same gate as the batch warmer above): while it runs, every
          // card the mouse sweeps over would otherwise queue a demosaic of its
          // own on the request path.
          onPointerEnter={() => {
            if (warmPreviews) preloadImage(api.import.stagedPreviewUrl(sessionId, f.id));
          }}
          // Same as a library tile: a plain click previews, Cmd/Ctrl-click or
          // Shift-click picks the card. Picking says nothing about importing -
          // that is the checkbox in the footer below.
          onClick={(e) => (isSelectClick(e) ? onToggleMark(i, e.shiftKey) : onOpen(i))}
          title={
            duplicate
              ? "Already in your library"
              : f.duplicate_in_trash
                ? "This photo is in the Trash. Importing it restores it."
                : `Click to preview. ${modKeyLabel}-click to select, Shift-click for a range.`
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
          {/* The library's selection checkbox: on every card once one is
              picked, so the rest can be picked with plain clicks on it. An
              exact duplicate can never be imported, so there is nothing to
              pick it for - its badge takes the corner instead. */}
          {selecting && !duplicate && (
            <input
              className="select-checkbox"
              type="checkbox"
              checked={marked}
              onClick={(e) => {
                e.stopPropagation();
                onToggleMark(i, e.shiftKey);
              }}
              onChange={() => {}}
            />
          )}
          {flaggedDuplicate(f) && (
            // A Trash-restore duplicate can be picked, so its badge always
            // leaves the checkbox's corner free - it must not jump aside the
            // moment a selection starts.
            <span className={`duplicate-badge${duplicate ? "" : " beside-checkbox"}`}>
              {f.duplicate_in_trash ? "In Trash, will be restored" : "Already in library"}
            </span>
          )}
          <span className={fileTypeBadgeClass(f.file_type, merged)}>
            {fileTypeBadge(f.file_type, merged)}
          </span>
        </div>
        <div
          className={`import-card-footer${row.extra === footer.inline ? " import-card-footer--inline" : ""}`}
        >
          {/* Import or not: beside the stars, where the shorter of the two
              rows leaves room at every grid size. Like the stars and swatches
              it is this card's own, picked or not - the picked cards as a
              whole are decided in the wizard's bottom bar. An exact duplicate
              keeps the box, switched off, so every footer reads the same. */}
          <div className="import-card-footer-row">
            <RatingStars rating={f.rating} onChange={(rating) => onPatch(f.id, { rating })} />
            {/* Named, so the box can't be taken for the selection checkbox on
                the photo: the app's Import symbol always, the word beside it
                wherever the card is wide enough (the CSS decides - narrow
                portrait and XS cards keep the symbol alone). */}
            <label
              className={`import-check${duplicate ? " disabled" : ""}`}
              title={duplicate ? "Already in your library" : "Import this photo"}
            >
              <IconImport />
              <span className="import-check-text">Import</span>
              <input
                className="import-checkbox"
                type="checkbox"
                checked={!duplicate && f.selected}
                disabled={duplicate}
                onClick={() => onToggleSelect(i)}
                onChange={() => {}}
                aria-label="Import this photo"
              />
            </label>
          </div>
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
        ["--card-footer-h" as string]: `${footer.stacked}px`,
        ["--card-footer-inline-h" as string]: `${footer.inline}px`,
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
                    section.top + row.top + row.height + row.extra > winTop
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

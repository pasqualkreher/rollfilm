import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import type { AlbumOut, CanvasSummary, ColorLabel, Facet, ViewMode } from "../api/types";
import { ColorLabelPicker } from "./ColorLabelPicker";
import { ViewPrefsControls } from "./ViewPrefsControls";
import { TagFilter } from "./TagFilter";
import { FilterChip } from "./FilterChip";
import { Dropdown } from "./Dropdown";
import { IconAlbum, IconAperture, IconCamera, IconChevronDown, IconFilter, IconImage, IconPin, IconStar, IconTag, IconX } from "./Icons";
import { setFilterPinned, useFilterPinned } from "../state/viewPrefs";

// Whether the pinned fields fit the bar in two lines. The docked fields have
// fixed widths (index.css, .filter-menu--docked .filter-menu-row), so the
// line count is a function of the bar's width alone: the widths are read
// off the dock whenever it is on screen and remembered, and the same greedy
// wrap that flex does is run over them on every bar resize - also while the
// dock is folded away, when there is nothing to measure. Deciding both ways
// from the same numbers is what keeps the edge from flickering. A layout
// effect, so a dock that opens on a too-narrow bar folds before it paints.
function useDockFits(barRef: { current: HTMLElement | null }, pinned: boolean, rowKey: string) {
  const [fits, setFits] = useState(true);
  const widths = useRef<number[]>([]);
  useLayoutEffect(() => {
    if (!pinned) return;
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => {
      const dock = bar.querySelector<HTMLElement>(".filter-menu--docked");
      if (dock) {
        const seen = Array.from(dock.children)
          .map((c) => (c as HTMLElement).offsetWidth)
          .filter((w) => w > 0);
        if (seen.length) widths.current = seen;
      }
      if (!widths.current.length) return;
      // The dock runs the bar's full width and carries the bar's own insets,
      // so the bar's content box is the room the fields have.
      const cs = getComputedStyle(bar);
      const room = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const gap = parseFloat(cs.columnGap) || 0;
      let lines = 1;
      let x = 0;
      for (const w of widths.current) {
        if (x > 0 && x + gap + w > room) {
          lines += 1;
          x = w;
        } else {
          x += x > 0 ? gap + w : w;
        }
      }
      setFits(lines <= 2);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
    // Re-run when the dock (re)appears so the widths are fresh, and when the
    // set of rows changes, since a remembered sum would be stale.
  }, [barRef, pinned, rowKey, fits]);
  return fits;
}

// Dual-thumb slider over the focal lengths actually present in the library
// (the facet's sorted, formatted mm values are its stops). Dragging both
// thumbs to the outer ends means "any" and clears the filter.
function FocalRangeSlider({
  options,
  min,
  max,
  onChange,
  compact = false,
}: {
  options: Facet[];
  min: string;
  max: string;
  onChange: (min: string, max: string) => void;
  // Docked in the bar: a field-sized box with a "mm" prefix in place of the
  // hidden caption, and a short readout ("24–70") so the slider keeps room.
  compact?: boolean;
}) {
  const values = options.map((o) => parseFloat(o.value));
  const last = values.length - 1;

  // Selected bounds as slider positions. The stops shift under cross-filtering
  // (picking a camera narrows them), so snap a stored bound to the nearest
  // remaining stop rather than requiring an exact match.
  const toIndex = (bound: string, fallback: number) => {
    if (!bound) return fallback;
    const num = parseFloat(bound);
    let best = fallback;
    let bestDist = Infinity;
    values.forEach((v, i) => {
      const d = Math.abs(v - num);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  };
  const lo = toIndex(min, 0);
  const hi = toIndex(max, last);

  const commit = (nextLo: number, nextHi: number) => {
    if (nextLo <= 0 && nextHi >= last) onChange("", "");
    else onChange(options[nextLo].value, options[nextHi].value);
  };

  if (values.length === 0) return null;
  if (values.length === 1) {
    if (compact) {
      return (
        <div className="focal-range focal-range--compact">
          <span className="focal-range-unit" aria-hidden>
            mm
          </span>
          <span className="focal-range-value">{options[0].value}</span>
        </div>
      );
    }
    return <span className="focal-range-value">{options[0].value}mm</span>;
  }

  const active = Boolean(min || max);
  return (
    <div className={`focal-range${compact ? " focal-range--compact" : ""}`}>
      {compact && (
        <span className="focal-range-unit" aria-hidden>
          mm
        </span>
      )}
      <span className={`focal-range-value${active ? " active" : ""}`}>
        {active
          ? compact
            ? `${options[lo].value}–${options[hi].value}`
            : `${options[lo].value}mm – ${options[hi].value}mm`
          : "Any"}
      </span>
      <div className="dual-range">
        <div className="dual-range-track" />
        <div
          className="dual-range-fill"
          style={{
            left: `${(lo / last) * 100}%`,
            width: `${((hi - lo) / last) * 100}%`,
          }}
        />
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={lo}
          aria-label="Minimum focal length"
          onChange={(e) => {
            const v = Math.min(Number(e.target.value), hi);
            commit(v, hi);
          }}
        />
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={hi}
          aria-label="Maximum focal length"
          onChange={(e) => {
            const v = Math.max(Number(e.target.value), lo);
            commit(lo, v);
          }}
        />
      </div>
    </div>
  );
}

interface Props {
  // Where you are, first in the bar ("Library", "Album · <name>"). Wrapped in
  // .bar-title and followed by a divider here, so every screen's title sits at
  // the same spot. Pass .bar-title-sub / .bar-title-name spans for a muted
  // prefix and an ellipsised name; a plain string is fine too.
  title?: ReactNode;
  viewMode: ViewMode;
  onViewMode: (v: ViewMode) => void;
  // Whether the RAW+JPG / RAW / JPG choice (a row of the Filter menu) is
  // offered at all. Screens that can
  // only work on whole shots (the album canvas) hide it and stay on the app's
  // default pairing rather than letting a filter split a pair under them.
  showViewMode?: boolean;
  ratingMin: number;
  onRatingMin: (n: number) => void;
  colorLabel: ColorLabel;
  onColorLabel: (c: ColorLabel) => void;
  // When provided, an album filter is shown. Album detail pages omit this
  // (they're already scoped to one album); the Library shows it.
  albums?: AlbumOut[];
  albumId?: string;
  onAlbumId?: (id: string) => void;
  // Canvases join the same dropdown as a second group: the grid then shows
  // what one canvas holds. Picking one clears the album and vice versa - it
  // is one "where" filter with two kinds of place.
  canvases?: CanvasSummary[];
  canvasId?: string;
  onCanvasId?: (id: string) => void;
  // When provided, a multi-select "Tag" filter is shown. `allTags` is every
  // tag name the user has ever created; `selectedTags` are the ones the grid is
  // currently filtered to (AND - a photo must have all of them). Album detail
  // and Library both show it; Import review omits it (staged files aren't
  // tagged yet).
  allTags?: string[];
  selectedTags?: string[];
  onTags?: (tags: string[]) => void;
  // When provided, a "Camera" dropdown of the camera models present in the
  // library is shown. `camera` is the selected model ("" = any).
  cameras?: Facet[];
  camera?: string;
  onCamera?: (model: string) => void;
  // When provided, a "Lens" dropdown of the lens names present in the library
  // is shown. `lens` is the selected name ("" = any).
  lenses?: Facet[];
  lens?: string;
  onLens?: (lens: string) => void;
  // When provided, a "Focal length" range slider over the focal lengths
  // present in the library is shown. Bounds are the facet's formatted mm
  // numbers ("23", "8.8"); "" = unbounded on that side.
  focalLengths?: Facet[];
  focalMin?: string;
  focalMax?: string;
  onFocalRange?: (min: string, max: string) => void;
  // When provided, a "From date – To date" range is shown that filters by
  // capture date (taken_at) with month/day precision via native date pickers.
  // Both handlers must be given to enable it. Values are ISO dates ("YYYY-MM-DD").
  dateFrom?: string | null;
  dateTo?: string | null;
  onDateFrom?: (d: string | null) => void;
  onDateTo?: (d: string | null) => void;
  // Whether to show the "Merge RAW+JPG" toggle. On for the Library and the
  // import review (which honours the same preference for its staged pairs);
  // off for albums, which always collapse each pair to one card.
  showMerge?: boolean;
  // Extra view controls (e.g. import's "Hide duplicates") rendered inside the
  // view group, left of the divider - so they read as a display option rather
  // than a page action.
  viewExtras?: ReactNode;
  // The order control (the Library's sort dropdown). It lives inside the
  // Filter menu as its first row: sorting is set in the same place as the
  // rest of what shapes the grid, and the bar stays one calm row. It is not a
  // filter, so it neither counts on the chip nor resets with "Clear".
  sort?: ReactNode;
  // Extra actions (e.g. import's Select / Select all buttons) render after the
  // shared filters, right of the divider, so every screen keeps an identical
  // filter core.
  children?: ReactNode;
  // Pinned to the far right of the bar, past everything else. For a switch that
  // belongs to the whole page rather than to the filters - which way of looking
  // at these photos am I in - so it reads as the page's own control and not as
  // one more thing to set.
  trailing?: ReactNode;
}

// The shared filter row used by the Library, Album detail, and Import review
// screens - so rating and color filtering behave identically everywhere.
export function PhotoFilters({
  title,
  viewMode,
  onViewMode,
  showViewMode = true,
  ratingMin,
  onRatingMin,
  colorLabel,
  onColorLabel,
  albums,
  albumId,
  onAlbumId,
  canvases,
  canvasId,
  onCanvasId,
  allTags,
  selectedTags,
  onTags,
  cameras,
  camera,
  onCamera,
  lenses,
  lens,
  onLens,
  focalLengths,
  focalMin,
  focalMax,
  onFocalRange,
  dateFrom,
  dateTo,
  onDateFrom,
  onDateTo,
  showMerge = true,
  viewExtras,
  sort,
  children,
  trailing,
}: Props) {
  // Pinned: the same menu docks as the bar's second row instead of hanging
  // off the chip as a popover, so it survives every click while culling. The
  // same on every screen: the first row stays as it is unpinned, the fields
  // line up under it.
  const pinned = useFilterPinned();
  const showDates = Boolean(onDateFrom && onDateTo);
  const showCamera = Boolean(cameras && onCamera);
  const showLens = Boolean(lenses && onLens);
  const showFocal = Boolean(focalLengths && onFocalRange);

  // Pinned is docked while the fields fit in two lines: the docked row
  // wraps its fields onto a second line when the bar is narrower than their
  // sum (a 13" laptop in full screen shows the Library's full set on two
  // lines, a wide monitor on one). A bar so narrow that they would need a
  // third folds the dock away and the chip opens the same menu as a popover
  // again, with the pin still set - the pin is a saved preference, the fold
  // only follows the window, so a wider window brings the dock straight
  // back. The fields keep the same fixed widths on every screen; only the
  // number of lines changes with the window.
  const barRef = useRef<HTMLDivElement | null>(null);
  const rowKey = [
    Boolean(sort),
    showViewMode,
    Boolean(albums && onAlbumId),
    Boolean(allTags && onTags),
    showCamera,
    showLens,
    showFocal && (focalLengths?.length ?? 0) > 0,
    showDates,
  ].join();
  const dockFits = useDockFits(barRef, pinned, rowKey);
  const docked = pinned && dockFits;

  // How many filters are engaged - shown on the closed Filter chip so the
  // state stays visible while the menu is shut.
  const activeCount =
    (ratingMin > 0 ? 1 : 0) +
    (colorLabel !== "none" ? 1 : 0) +
    ((albumId ?? "") !== "" || (canvasId ?? "") !== "" ? 1 : 0) +
    ((selectedTags?.length ?? 0) > 0 ? 1 : 0) +
    ((camera ?? "") !== "" ? 1 : 0) +
    ((lens ?? "") !== "" ? 1 : 0) +
    (focalMin || focalMax ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0) +
    (showViewMode && viewMode !== "combined" ? 1 : 0);
  const isFiltering = activeCount > 0;

  function clearAll() {
    onRatingMin(0);
    onColorLabel("none");
    onAlbumId?.("");
    onCanvasId?.("");
    onTags?.([]);
    onCamera?.("");
    onLens?.("");
    onFocalRange?.("", "");
    onDateFrom?.(null);
    onDateTo?.(null);
    if (showViewMode) onViewMode("combined");
  }

  const chipLabel = (
    <>
      <IconFilter size={12} /> Filter
      {/* The count's cell is always there (two digits wide, blank when nothing
          filters), so the chip keeps one width and the controls after it stay
          put when the first filter is set. */}
      <span className={`filter-chip-count${activeCount > 0 ? "" : " filter-chip-count--idle"}`}>
        {activeCount > 0 ? `· ${activeCount}` : ""}
      </span>
    </>
  );

  // The pin sits in the panel's top-right corner, so it's found where the
  // filters are and reads as "keep this panel". Toggling it moves the very same
  // menu between the popover and the docked row. Unpinning lands on the closed
  // chip rather than reopening the popover: unpinning is how you put the
  // filters away, so leaving the same panel on screen only means clicking a
  // second time to be rid of it.
  const pinButton = (
    <button
      type="button"
      className={`filter-pin${pinned ? " active" : ""}`}
      aria-pressed={pinned}
      title={pinned ? "Unpin the filters" : "Keep the filters open"}
      onClick={() => setFilterPinned(!pinned)}
    >
      <IconPin size={13} filled={pinned} />
    </button>
  );

  const menu = (
    <div className={`filter-menu${docked ? " filter-menu--docked" : ""}`}>
      {pinButton}
      <div className="filter-menu-head">
        <span className="filter-menu-title">Filter</span>
      </div>
      {sort && (
        <div className="filter-menu-row filter-menu-row--sort">
          <span className="filter-menu-label">Sort</span>
          {sort}
        </div>
      )}
      {/* Which files of a shot to show: it narrows the grid like any other
          filter, so it lives here, counts on the chip and resets with Clear. */}
      {showViewMode && (
        <div className="filter-menu-row filter-menu-row--filetype">
          <span className="filter-menu-label">File type</span>
          <Dropdown
            ariaLabel="File type"
            icon={<IconImage size={13} />}
            value={viewMode}
            onChange={(v) => onViewMode(v as ViewMode)}
            options={[
              { value: "combined", label: "RAW + JPEG" },
              { value: "jpeg_only", label: "JPEG" },
              { value: "raw_only", label: "RAW" },
            ]}
          />
        </div>
      )}
      {showDates && (
        <div className="filter-menu-row filter-menu-row--date">
          <span className="filter-menu-label">Date</span>
          <span className="date-range">
            <input
              type="date"
              value={dateFrom ?? ""}
              max={dateTo ?? undefined}
              onChange={(e) => onDateFrom?.(e.target.value || null)}
              aria-label="From date"
            />
            <span className="date-range-sep">–</span>
            <input
              type="date"
              value={dateTo ?? ""}
              min={dateFrom ?? undefined}
              onChange={(e) => onDateTo?.(e.target.value || null)}
              aria-label="To date"
            />
          </span>
        </div>
      )}
      {albums && onAlbumId && (
        <div className="filter-menu-row filter-menu-row--album">
          <span className="filter-menu-label">{canvases ? "Album / Canvas" : "Album"}</span>
          <Dropdown
            ariaLabel={canvases ? "Album or canvas" : "Album"}
            icon={<IconAlbum size={13} />}
            searchable
            value={albumId ? `album:${albumId}` : canvasId ? `canvas:${canvasId}` : ""}
            onChange={(v) => {
              if (v.startsWith("album:")) {
                onCanvasId?.("");
                onAlbumId(v.slice("album:".length));
              } else if (v.startsWith("canvas:")) {
                onAlbumId("");
                onCanvasId?.(v.slice("canvas:".length));
              } else {
                onAlbumId("");
                onCanvasId?.("");
              }
            }}
            options={[
              { value: "", label: "All photos" },
              ...(canvases && canvases.length > 0
                ? [{ value: "h-albums", label: <span className="dropdown-group-label">Albums</span>, disabled: true }]
                : []),
              ...albums.map((a) => ({ value: `album:${a.id}`, label: a.name })),
              ...(canvases && canvases.length > 0
                ? [
                    { value: "h-canvases", label: <span className="dropdown-group-label">Canvases</span>, disabled: true },
                    ...canvases.map((c) => ({ value: `canvas:${c.id}`, label: c.name })),
                  ]
                : []),
            ]}
          />
        </div>
      )}

      <div className="filter-menu-row filter-menu-row--rating">
        <span className="filter-menu-label">Rating</span>
        <Dropdown
          ariaLabel="Rating"
          icon={<IconStar size={13} />}
          value={String(ratingMin)}
          onChange={(v) => onRatingMin(Number(v))}
          options={[0, 1, 2, 3, 4, 5].map((n) => ({
            value: String(n),
            label: n === 0 ? "Any" : `${"★".repeat(n)}+`,
            // The closed field reads "★ 3+" with its own star in front.
            short: n === 0 ? "Any" : `${n}+`,
          }))}
        />
      </div>

      <div className="filter-menu-row filter-menu-row--color">
        <span className="filter-menu-label">Color</span>
        <ColorLabelPicker value={colorLabel} onChange={onColorLabel} />
      </div>

      {allTags && onTags && (
        <div className="filter-menu-row filter-menu-row--tags">
          <span className="filter-menu-label">Tags</span>
          <TagFilter icon={<IconTag size={13} />} options={allTags} value={selectedTags ?? []} onChange={onTags} />
        </div>
      )}

      {showCamera && (
        <div className="filter-menu-row filter-menu-row--camera">
          <span className="filter-menu-label">Camera</span>
          <Dropdown
            ariaLabel="Camera"
            icon={<IconCamera size={13} />}
            searchable
            value={camera ?? ""}
            onChange={(v) => onCamera?.(v)}
            // The selected value can drop out of the cross-filtered options
            // (facets refetching); keep it listed so the button never shows a
            // stale blank.
            options={[
              { value: "", label: "All cameras" },
              ...cameras!.map((c) => ({ value: c.value, label: `${c.value} (${c.count})` })),
              ...(camera && !cameras!.some((c) => c.value === camera)
                ? [{ value: camera, label: camera }]
                : []),
            ]}
          />
        </div>
      )}

      {showLens && (
        <div className="filter-menu-row filter-menu-row--lens">
          <span className="filter-menu-label">Lens</span>
          <Dropdown
            ariaLabel="Lens"
            icon={<IconAperture size={13} />}
            searchable
            value={lens ?? ""}
            onChange={(v) => onLens?.(v)}
            options={[
              { value: "", label: "All lenses" },
              ...lenses!.map((l) => ({ value: l.value, label: `${l.value} (${l.count})` })),
              ...(lens && !lenses!.some((l) => l.value === lens)
                ? [{ value: lens, label: lens }]
                : []),
            ]}
          />
        </div>
      )}

      {showFocal && focalLengths!.length > 0 && (
        <div className="filter-menu-row filter-menu-row--focal">
          <span className="filter-menu-label">Focal length</span>
          <FocalRangeSlider
            options={focalLengths!}
            min={focalMin ?? ""}
            max={focalMax ?? ""}
            onChange={(min, max) => onFocalRange?.(min, max)}
            compact={docked}
          />
        </div>
      )}
    </div>
  );

  return (
    <div className="filter-bar filter-bar--sticky" ref={barRef}>
      {title != null && (
        <>
          <span className="bar-title">{title}</span>
          <span className="bar-sep" aria-hidden />
        </>
      )}

      {/* View: how the same photos are displayed (size, pairing). */}
      <div className="control-group control-group--view">
        <ViewPrefsControls showMerge={showMerge} />
        {viewExtras}
      </div>

      {/* All filters live behind one quiet "Filter" chip (funnel + count),
          like a pro app's filter popover - the bar itself stays one calm row.
          Inside the menu every filter gets a labelled row and full-width
          control, where that verbosity belongs. Sits between the view
          controls and the page actions. Pinned, the chip collapses the docked
          row instead of opening a popover. */}
      <div className="control-group control-group--filter">
        {docked ? (
          <button
            type="button"
            className={`tag-filter-btn${isFiltering ? " active" : ""}`}
            title="Collapse the filters"
            aria-expanded
            onClick={() => setFilterPinned(false)}
          >
            <span className="tag-filter-btn-label">{chipLabel}</span>
            <span className="tag-filter-caret tag-filter-caret--up">
              <IconChevronDown size={11} />
            </span>
          </button>
        ) : (
          <FilterChip title="Filter photos" active={isFiltering} label={chipLabel}>
            {menu}
          </FilterChip>
        )}

        {/* Always in the row, only hidden while nothing filters: mounting it
            with the first filter shifted whatever followed it. Hidden, it is
            out of the tab order and the accessibility tree too. */}
        <button
          type="button"
          className={`btn btn-sm ghost bar-clear${isFiltering ? "" : " bar-clear--idle"}`}
          onClick={clearAll}
          title="Clear all filters"
          aria-label="Clear all filters"
          aria-hidden={!isFiltering || undefined}
          tabIndex={isFiltering ? undefined : -1}
        >
          <IconX size={12} />
        </button>
      </div>

      {/* Page-specific actions (Select, Select all, ...). */}
      {children && <div className="control-group control-group--actions">{children}</div>}

      {trailing && <div className="control-group control-group--trailing">{trailing}</div>}

      {/* Pinned: the same menu docked as the bar's own second row of bare
          controls (the captions are for screen readers only). Always a row of
          its own, full width, so the first row is the same pinned or not;
          too many fields for the width wrap onto a second line, and past
          that the dock folds away (useDockFits) until the bar is wide
          enough again. */}
      {docked && <div className="filter-dock">{menu}</div>}
    </div>
  );
}

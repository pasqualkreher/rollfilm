import { useCallback, useEffect, useRef, useState } from "react";

// The rail draws two tick levels: a bold "primary" line where `tickGroup`
// changes (the library's years) and a small "secondary" line for the sections
// between (the library's months). Callers may set these per section to rescale
// the hierarchy - the import review scrubs month→day instead of year→month.
// When omitted, the defaults below split "July 2026"-style labels.
export interface ScrubberSection {
  label: string; // unique key, bubble text, and getSectionEl lookup key
  tickGroup?: string;
  tickPrimary?: string;
  tickSecondary?: string;
}

interface Props {
  // Returns the scrolling ancestor (the `.page`) and the DOM node for a given
  // section, resolved lazily since they mount after this component.
  getScroller: () => HTMLElement | null;
  getSectionEl: (label: string) => HTMLElement | null;
  sections: ScrubberSection[];
  // Extra space to keep clear at the rail's bottom end, e.g. the import
  // review's fixed bottom action bar (which would otherwise cover the rail's
  // lower markers). Read during recompute, so it may measure a live element.
  getBottomInset?: () => number;
}

interface Marker {
  label: string;
  group: string; // primary ticks appear where this changes
  primary: string;
  secondary: string;
  frac: number; // 0..1 position along the rail
}

// "July 2026" splits into a year and a month line; a label without a trailing
// year (the "Unknown date" bucket of photos whose EXIF hasn't been read yet)
// renders as a single line instead of a nonsense "date / Unk" split.
function hasYear(label: string): boolean {
  return /^\d{4}$/.test(label.split(" ").pop() ?? "");
}

function yearOf(label: string): string {
  return hasYear(label) ? label.split(" ").pop()! : label;
}

function monthOf(label: string): string {
  return hasYear(label) ? (label.split(" ")[0] ?? label).slice(0, 3) : label.slice(0, 3);
}

function toMarkerFields(s: ScrubberSection): Omit<Marker, "frac"> {
  const primary = s.tickPrimary ?? yearOf(s.label);
  return {
    label: s.label,
    group: s.tickGroup ?? primary,
    primary,
    secondary: s.tickSecondary ?? monthOf(s.label),
  };
}

// Markers, the handle and the drag hit-testing all map a 0..1 fraction onto the
// rail with this end padding, so the first/last labels aren't jammed against
// the ends. It MUST be shared: if placement (posTop) and click→fraction
// (fracFromEvent) disagree, dragging to a visible label lands on its neighbour.
const RAIL_INSET = 24;

// The rail runs from just under the filter bar down to just above the window
// bottom, with the SAME gap at both ends. Keeping the top at the filter bar
// (not poking up into it) means the first month label - which RAIL_INSET already
// pushes down from the rail's top - sits just below the bar rather than jammed
// against it or up inside it; RAIL_INSET insets the last label by the same
// amount, so with equal end gaps the top and bottom labels get equal breathing
// room automatically.
const RAIL_GAP = 6;

/**
 * Immich-style date scrubber pinned to the right edge of the library timeline:
 * year/month markers positioned by where each section sits in the scroll range,
 * draggable to jump to a date, with a bubble showing the current month.
 */
export function TimelineScrubber({ getScroller, getSectionEl, sections, getBottomInset }: Props) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [currentFrac, setCurrentFrac] = useState(0);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Briefly reveal the scrubber + position bubble while the user scrolls the
  // grid, then fade back out - so scrolling shows where you are, like the drag.
  const [scrolling, setScrolling] = useState(false);
  const scrollHideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The scroll window the rail maps onto: [firstOffset, firstOffset + span].
  // firstOffset is the topmost section's content offset (mapped to the rail's
  // top, since the rail is anchored to the first photo, not to scrollTop 0).
  const rangeRef = useRef({ firstOffset: 0, span: 1 });
  const [railTop, setRailTop] = useState(120);
  const [railBottom, setRailBottom] = useState(RAIL_GAP);
  const [railHeight, setRailHeight] = useState(0);

  const recompute = useCallback(() => {
    const scroller = getScroller();
    if (!scroller) return;
    const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    const scrollerRect = scroller.getBoundingClientRect();
    const scrollerTop = scrollerRect.top;

    // Anchor the rail just below the filter bar (the scroll area's top) and give
    // it the SAME gap at the bottom, so its top and bottom breathing room match.
    // A caller with a fixed bottom bar (the import review) grows the bottom gap
    // so the rail ends above the bar instead of running underneath it.
    const top = scrollerTop + RAIL_GAP;
    const bottom = RAIL_GAP + (getBottomInset?.() ?? 0);
    setRailTop(top);
    setRailBottom(bottom);
    setRailHeight(Math.max(0, window.innerHeight - bottom - top));

    // Each section's content offset, then map them onto the rail RELATIVE to
    // the topmost section: its offset becomes frac 0 (the rail's top), so the
    // first month's label lands at the first photo the rail is anchored to. Not
    // doing this leaves the small gap above the first section as a fraction of
    // the scroll range - invisible in a long library, but in one that barely
    // scrolls it pushes the first label well down the rail.
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    const raw: { section: ScrubberSection; offset: number }[] = [];
    for (const section of sections) {
      const el = getSectionEl(section.label);
      if (!el) continue;
      raw.push({ section, offset: el.getBoundingClientRect().top - scrollerTop + scroller.scrollTop });
    }
    const firstOffset = raw.length ? Math.min(...raw.map((r) => r.offset)) : 0;
    const span = Math.max(1, maxScroll - firstOffset);
    rangeRef.current = { firstOffset, span };

    const next: Marker[] = raw.map(({ section, offset }) => ({
      ...toMarkerFields(section),
      frac: clamp01((offset - firstOffset) / span),
    }));
    // Deepest section still at/above the fold - the one you're currently in.
    const topmost = raw.filter((r) => r.offset <= scroller.scrollTop + 4).pop()?.section.label ?? null;
    setMarkers(next);
    setCurrentFrac(clamp01((scroller.scrollTop - firstOffset) / span));
    if (!dragging) setActiveLabel(topmost ?? next[0]?.label ?? null);
  }, [getScroller, getSectionEl, sections, dragging, getBottomInset]);

  useEffect(() => {
    const scroller = getScroller();
    if (!scroller) return;
    recompute();
    // Reveal the bubble on real user scrolls only (not the mount/resize
    // recomputes), and auto-hide a moment after scrolling stops.
    //
    // Coalesced onto animation frames, the same way the grid's own scroll
    // tracking is (useVirtualWindow): scroll events fire faster than the screen
    // refreshes, and every one of them used to recompute the whole rail and
    // push new marker state through React - work that can only be seen once per
    // frame no matter how often it is done, on the thread the scroll itself
    // needs.
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
      setScrolling(true);
      clearTimeout(scrollHideTimer.current);
      scrollHideTimer.current = setTimeout(() => setScrolling(false), 900);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(scroller);
    window.addEventListener("resize", recompute);
    // The page-enter animation slides `.page` down a few px while this first
    // measures, so re-measure once any enter animation settles (animationend
    // bubbles to window) - otherwise the rail keeps that offset until the
    // next scroll or resize.
    window.addEventListener("animationend", recompute);
    return () => {
      cancelAnimationFrame(raf);
      scroller.removeEventListener("scroll", onScroll);
      ro.disconnect();
      window.removeEventListener("resize", recompute);
      window.removeEventListener("animationend", recompute);
      clearTimeout(scrollHideTimer.current);
    };
  }, [getScroller, recompute]);

  const scrollToFrac = useCallback(
    (frac: number) => {
      const scroller = getScroller();
      const rail = railRef.current;
      if (!scroller || !rail) return;
      const clamped = Math.min(1, Math.max(0, frac));
      // Invert the recompute() mapping: frac 0 = the topmost section, frac 1 =
      // the bottom of the scroll range.
      const { firstOffset, span } = rangeRef.current;
      scroller.scrollTop = firstOffset + clamped * span;
      // Move the indicator with the pointer right away, rather than waiting for
      // the scroll event to round-trip through recompute().
      setCurrentFrac(clamped);
      // Show the section that's actually at the top after this scroll - the
      // last marker at or above the drag position - so the bubble matches the
      // grid (nearest-marker would flip to the next section a bit too early).
      // Markers are in document order => ascending frac, regardless of whether
      // the timeline runs newest-first (library) or oldest-first (import).
      let topmost = markers[0]?.label ?? null;
      for (const m of markers) {
        if (m.frac <= clamped + 1e-4) topmost = m.label;
        else break;
      }
      setActiveLabel(topmost);
    },
    [getScroller, markers]
  );

  const fracFromEvent = useCallback((clientY: number) => {
    const rail = railRef.current;
    if (!rail) return 0;
    const rect = rail.getBoundingClientRect();
    // Invert posTop()'s inset so a click on a label maps to that label's frac.
    const usable = rect.height - RAIL_INSET * 2;
    if (usable <= 0) return 0;
    return Math.min(1, Math.max(0, (clientY - rect.top - RAIL_INSET) / usable));
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => scrollToFrac(fracFromEvent(e.clientY));
    const onUp = () => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, scrollToFrac, fracFromEvent]);

  if (sections.length < 1) return null;

  // Inset positions a little from the rail's top/bottom edges so the first and
  // last labels aren't jammed against the ends. Kept in lockstep with
  // fracFromEvent via RAIL_INSET so clicks land on the label they point at.
  const posTop = (frac: number) => `calc(${frac} * (100% - ${RAIL_INSET * 2}px) + ${RAIL_INSET}px)`;

  // Declutter: with many sections (or a short rail) the raw markers overlap
  // into an unreadable stack. Ticks are centered on their position (translateY
  // -50%); a primary tick (year, or month in the import's month→day scale) is
  // two lines (~22px), a secondary tick one (~10px). Primaries are placed
  // first and always win their space; a secondary label only renders when it
  // clears the previously placed tick AND the next primary tick below it -
  // without that look-ahead, secondaries sat right on top of the next
  // primary's label. Dropped ticks are only labels: dragging still scrolls
  // through them.
  const PRIMARY_SPACING = 30;
  const SECONDARY_TO_SECONDARY = 16;
  const SECONDARY_TO_PRIMARY = 22;
  const usable = Math.max(0, railHeight - RAIL_INSET * 2);
  const seenGroups = new Set<string>();
  const annotated = markers.map((m) => {
    const isGroupStart = !seenGroups.has(m.group);
    if (isGroupStart) seenGroups.add(m.group);
    return { m, y: m.frac * usable, isGroupStart };
  });
  const primaryTicks: typeof annotated = [];
  let lastPrimaryY = -Infinity;
  for (const a of annotated) {
    if (a.isGroupStart && a.y - lastPrimaryY >= PRIMARY_SPACING) {
      primaryTicks.push(a);
      lastPrimaryY = a.y;
    }
  }
  const primaryTickSet = new Set(primaryTicks);
  const shown: { marker: Marker; showPrimary: boolean }[] = [];
  let nextPrimaryIdx = 0;
  let prevY = -Infinity;
  let prevWasPrimary = false;
  for (const a of annotated) {
    if (primaryTickSet.has(a)) {
      shown.push({ marker: a.m, showPrimary: true });
      prevY = a.y;
      prevWasPrimary = true;
      nextPrimaryIdx++;
      continue;
    }
    // A group-start whose primary label was dropped (primaries too dense):
    // showing it as a bare secondary would just re-crowd the freed-up space.
    if (a.isGroupStart) continue;
    if (a.y - prevY < (prevWasPrimary ? SECONDARY_TO_PRIMARY : SECONDARY_TO_SECONDARY)) continue;
    const nextPrimary = primaryTicks[nextPrimaryIdx];
    if (nextPrimary && nextPrimary.y - a.y < SECONDARY_TO_PRIMARY) continue;
    shown.push({ marker: a.m, showPrimary: false });
    prevY = a.y;
    prevWasPrimary = false;
  }

  return (
    <div
      ref={railRef}
      className={`timeline-scrubber${dragging ? " dragging" : ""}${scrolling ? " scrolling" : ""}`}
      style={{ top: railTop, bottom: railBottom }}
      onPointerDown={(e) => {
        setDragging(true);
        scrollToFrac(fracFromEvent(e.clientY));
      }}
    >
      {shown.map(({ marker: m, showPrimary }) => {
        const isActive = m.label === activeLabel;
        return (
          <div
            key={m.label}
            className={`scrubber-tick${showPrimary ? " year-start" : ""}${isActive ? " active" : ""}`}
            style={{ top: posTop(m.frac) }}
          >
            {showPrimary && <span className="scrubber-year">{m.primary}</span>}
            {/* When the primary line already shows the whole label (a no-year
                label like "Unknown date"), a second truncated line under it
                would just repeat its first letters. */}
            {(!showPrimary || m.primary !== m.label) && (
              <span className="scrubber-month">{m.secondary}</span>
            )}
          </div>
        );
      })}

      <div className="scrubber-handle" style={{ top: posTop(currentFrac) }} />

      {activeLabel && (
        <div className={`scrubber-bubble${dragging || scrolling ? " visible" : ""}`} style={{ top: posTop(currentFrac) }}>
          {activeLabel}
        </div>
      )}
    </div>
  );
}

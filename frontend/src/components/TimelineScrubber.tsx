import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  // Returns the scrolling ancestor (the `.page`) and the DOM node for a given
  // month section, resolved lazily since they mount after this component.
  getScroller: () => HTMLElement | null;
  getSectionEl: (label: string) => HTMLElement | null;
  sections: { label: string }[];
}

interface Marker {
  label: string;
  year: string;
  month: string;
  frac: number; // 0..1 position along the rail
}

function yearOf(label: string): string {
  return label.split(" ").pop() ?? label;
}

function monthOf(label: string): string {
  return (label.split(" ")[0] ?? label).slice(0, 3);
}

// Markers, the handle and the drag hit-testing all map a 0..1 fraction onto the
// rail with this end padding, so the first/last labels aren't jammed against
// the ends. It MUST be shared: if placement (posTop) and click→fraction
// (fracFromEvent) disagree, dragging to a visible label lands on its neighbour.
const RAIL_INSET = 24;

// The rail spans the scroll viewport with these fixed insets: top is measured
// from the scroller's visible top, bottom from the window edge. Both live here
// (not in CSS) so railHeight can be derived arithmetically.
// The top inset is negative on purpose: the rail reaches up past the scroll
// area into the filter bar's right end (empty space there), so it starts higher
// and the first month label sits level with the first row of photos instead of
// a good bit below it.
const RAIL_TOP_INSET = -24;
// Matched to the top overlap so the rail has the same small breathing room to
// the box below (window bottom) as it does to the bar above - and reaching a
// bit further down gives it a touch more height.
const RAIL_BOTTOM = 4;

/**
 * Immich-style date scrubber pinned to the right edge of the library timeline:
 * year/month markers positioned by where each section sits in the scroll range,
 * draggable to jump to a date, with a bubble showing the current month.
 */
export function TimelineScrubber({ getScroller, getSectionEl, sections }: Props) {
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
  const [railHeight, setRailHeight] = useState(0);

  const recompute = useCallback(() => {
    const scroller = getScroller();
    if (!scroller) return;
    const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    const scrollerRect = scroller.getBoundingClientRect();
    const scrollerTop = scrollerRect.top;

    // Pin the rail to the scroll viewport: from just under the scroller's top
    // edge down to just above the window's bottom, so its height matches the
    // visible timeline area instead of hanging from wherever the first photo
    // happens to sit.
    const top = scrollerTop + RAIL_TOP_INSET;
    setRailTop(top);
    setRailHeight(Math.max(0, window.innerHeight - RAIL_BOTTOM - top));

    // Each section's content offset, then map them onto the rail RELATIVE to
    // the topmost section: its offset becomes frac 0 (the rail's top), so the
    // first month's label lands at the first photo the rail is anchored to. Not
    // doing this leaves the small gap above the first section as a fraction of
    // the scroll range - invisible in a long library, but in one that barely
    // scrolls it pushes the first label well down the rail.
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    const raw: { label: string; offset: number }[] = [];
    for (const { label } of sections) {
      const el = getSectionEl(label);
      if (!el) continue;
      raw.push({ label, offset: el.getBoundingClientRect().top - scrollerTop + scroller.scrollTop });
    }
    const firstOffset = raw.length ? Math.min(...raw.map((r) => r.offset)) : 0;
    const span = Math.max(1, maxScroll - firstOffset);
    rangeRef.current = { firstOffset, span };

    const next: Marker[] = raw.map(({ label, offset }) => ({
      label,
      year: yearOf(label),
      month: monthOf(label),
      frac: clamp01((offset - firstOffset) / span),
    }));
    // Deepest section still at/above the fold - the month you're currently in.
    const topmost = raw.filter((r) => r.offset <= scroller.scrollTop + 4).pop()?.label ?? null;
    setMarkers(next);
    setCurrentFrac(clamp01((scroller.scrollTop - firstOffset) / span));
    if (!dragging) setActiveLabel(topmost ?? next[0]?.label ?? null);
  }, [getScroller, getSectionEl, sections, dragging]);

  useEffect(() => {
    const scroller = getScroller();
    if (!scroller) return;
    recompute();
    // Reveal the bubble on real user scrolls only (not the mount/resize
    // recomputes), and auto-hide a moment after scrolling stops.
    const onScroll = () => {
      recompute();
      setScrolling(true);
      clearTimeout(scrollHideTimer.current);
      scrollHideTimer.current = setTimeout(() => setScrolling(false), 900);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(scroller);
    window.addEventListener("resize", recompute);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      ro.disconnect();
      window.removeEventListener("resize", recompute);
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
      // grid (nearest-marker would flip to the next month a bit too early).
      // markers are in document order (newest first) => ascending frac.
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

  // Declutter: with many months (or a short rail) the raw markers overlap into
  // an unreadable stack. Ticks are centered on their position (translateY -50%);
  // a year tick is two lines (~22px), a month tick one (~10px). Years are
  // placed first and always win their space; a month label only renders when
  // it clears the previously placed tick AND the next year tick below it -
  // without that look-ahead, months sat right on top of the next year's label.
  // Dropped months are only labels: dragging still scrolls through them.
  const YEAR_SPACING = 30;
  const MONTH_TO_MONTH = 16;
  const MONTH_TO_YEAR = 22;
  const usable = Math.max(0, railHeight - RAIL_INSET * 2);
  const seenYears = new Set<string>();
  const annotated = markers.map((m) => {
    const isYearStart = !seenYears.has(m.year);
    if (isYearStart) seenYears.add(m.year);
    return { m, y: m.frac * usable, isYearStart };
  });
  const yearTicks: typeof annotated = [];
  let lastYearY = -Infinity;
  for (const a of annotated) {
    if (a.isYearStart && a.y - lastYearY >= YEAR_SPACING) {
      yearTicks.push(a);
      lastYearY = a.y;
    }
  }
  const yearTickSet = new Set(yearTicks);
  const shown: { marker: Marker; showYear: boolean }[] = [];
  let nextYearIdx = 0;
  let prevY = -Infinity;
  let prevWasYear = false;
  for (const a of annotated) {
    if (yearTickSet.has(a)) {
      shown.push({ marker: a.m, showYear: true });
      prevY = a.y;
      prevWasYear = true;
      nextYearIdx++;
      continue;
    }
    // A year-start whose year label was dropped (years too dense): showing it
    // as a bare month would just re-crowd the space the drop freed up.
    if (a.isYearStart) continue;
    if (a.y - prevY < (prevWasYear ? MONTH_TO_YEAR : MONTH_TO_MONTH)) continue;
    const nextYear = yearTicks[nextYearIdx];
    if (nextYear && nextYear.y - a.y < MONTH_TO_YEAR) continue;
    shown.push({ marker: a.m, showYear: false });
    prevY = a.y;
    prevWasYear = false;
  }

  return (
    <div
      ref={railRef}
      className={`timeline-scrubber${dragging ? " dragging" : ""}${scrolling ? " scrolling" : ""}`}
      style={{ top: railTop, bottom: RAIL_BOTTOM }}
      onPointerDown={(e) => {
        setDragging(true);
        scrollToFrac(fracFromEvent(e.clientY));
      }}
    >
      {shown.map(({ marker: m, showYear }) => {
        const isActive = m.label === activeLabel;
        return (
          <div
            key={m.label}
            className={`scrubber-tick${showYear ? " year-start" : ""}${isActive ? " active" : ""}`}
            style={{ top: posTop(m.frac) }}
          >
            {showYear && <span className="scrubber-year">{m.year}</span>}
            <span className="scrubber-month">{m.month}</span>
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

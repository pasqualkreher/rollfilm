import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  // Returns the scrolling ancestor (the `.page`) and the DOM node for a given
  // month section, resolved lazily since they mount after this component.
  getScroller: () => HTMLElement | null;
  getSectionEl: (label: string) => HTMLElement | null;
  // The timeline root, used to align the rail's top with where the photo grid
  // begins (below the filter bar) rather than the top of the viewport.
  getAnchor: () => HTMLElement | null;
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

/**
 * Immich-style date scrubber pinned to the right edge of the library timeline:
 * year/month markers positioned by where each section sits in the scroll range,
 * draggable to jump to a date, with a bubble showing the current month.
 */
export function TimelineScrubber({ getScroller, getSectionEl, getAnchor, sections }: Props) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [currentFrac, setCurrentFrac] = useState(0);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [railTop, setRailTop] = useState(120);

  const recompute = useCallback(() => {
    const scroller = getScroller();
    if (!scroller) return;
    const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    const scrollerRect = scroller.getBoundingClientRect();
    const scrollerTop = scrollerRect.top;

    // Start the rail where the grid starts (below the filter bar), but never
    // above the top of the scroll area once that's scrolled off-screen.
    const padTop = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
    const minTop = scrollerTop + padTop;
    const anchor = getAnchor();
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : minTop;
    setRailTop(Math.max(minTop, anchorTop));

    const next: Marker[] = [];
    let topmost: string | null = null;
    for (const { label } of sections) {
      const el = getSectionEl(label);
      if (!el) continue;
      const offset = el.getBoundingClientRect().top - scrollerTop + scroller.scrollTop;
      const frac = Math.min(1, Math.max(0, offset / maxScroll));
      next.push({ label, year: yearOf(label), month: monthOf(label), frac });
      if (offset <= scroller.scrollTop + 4) topmost = label;
    }
    setMarkers(next);
    setCurrentFrac(scroller.scrollTop / maxScroll);
    if (!dragging) setActiveLabel(topmost ?? next[0]?.label ?? null);
  }, [getScroller, getSectionEl, getAnchor, sections, dragging]);

  useEffect(() => {
    const scroller = getScroller();
    if (!scroller) return;
    recompute();
    scroller.addEventListener("scroll", recompute, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(scroller);
    window.addEventListener("resize", recompute);
    return () => {
      scroller.removeEventListener("scroll", recompute);
      ro.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, [getScroller, recompute]);

  const scrollToFrac = useCallback(
    (frac: number) => {
      const scroller = getScroller();
      const rail = railRef.current;
      if (!scroller || !rail) return;
      const clamped = Math.min(1, Math.max(0, frac));
      const maxScroll = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = clamped * maxScroll;
      // Reflect the nearest section in the bubble immediately while dragging.
      let nearest = markers[0]?.label ?? null;
      let best = Infinity;
      for (const m of markers) {
        const d = Math.abs(m.frac - clamped);
        if (d < best) {
          best = d;
          nearest = m.label;
        }
      }
      setActiveLabel(nearest);
    },
    [getScroller, markers]
  );

  const fracFromEvent = useCallback((clientY: number) => {
    const rail = railRef.current;
    if (!rail) return 0;
    const rect = rail.getBoundingClientRect();
    return (clientY - rect.top) / rect.height;
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

  if (sections.length < 2) return null;

  // Inset positions a little from the rail's top/bottom edges so the first and
  // last labels aren't jammed against the ends.
  const posTop = (frac: number) => `calc(${frac} * (100% - 28px) + 14px)`;

  // Only render a year label once per year (at its first/earliest marker), to
  // avoid stacking the same year repeatedly down the rail.
  const seenYears = new Set<string>();

  return (
    <div
      ref={railRef}
      className={`timeline-scrubber${dragging ? " dragging" : ""}`}
      style={{ top: railTop }}
      onPointerDown={(e) => {
        setDragging(true);
        scrollToFrac(fracFromEvent(e.clientY));
      }}
    >
      {markers.map((m) => {
        const showYear = !seenYears.has(m.year);
        if (showYear) seenYears.add(m.year);
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
        <div className={`scrubber-bubble${dragging ? " visible" : ""}`} style={{ top: posTop(currentFrac) }}>
          {activeLabel}
        </div>
      )}
    </div>
  );
}

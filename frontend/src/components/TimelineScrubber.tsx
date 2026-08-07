import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// The rail draws two tick levels: a bold "primary" line where `tickGroup`
// changes (the library's years) and a small "secondary" line for the sections
// between (the library's months). Callers may set these per section to rescale
// the hierarchy - the import review scrubs month→day instead of year→month.
// When omitted, the defaults below split "July 2026"-style labels.
export interface ScrubberSection {
  label: string; // bubble text; also the identity when `key` is omitted
  // Identity: the React key and what getSectionEl is called with. Only needed
  // where the same label can occur twice - the library timeline, where a photo
  // out of date order splits a month into two same-named sections (see
  // LayoutSection.key). Keyed by label alone, the second section overwrites the
  // first in the element map and every tick between them disappears.
  key?: string;
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
  key: string; // section identity (see ScrubberSection.key)
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
    key: s.key ?? s.label,
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

// Inset positions a little from the rail's top/bottom edges so the first and
// last labels aren't jammed against the ends. Kept in lockstep with
// fracFromEvent via RAIL_INSET so clicks land on the label they point at.
function posTop(frac: number): string {
  return `calc(${frac} * (100% - ${RAIL_INSET * 2}px) + ${RAIL_INSET}px)`;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// --- tick placement --------------------------------------------------------
//
// With many sections (or a short rail) the raw markers overlap into an
// unreadable stack, so only the labels that have room are drawn. Ticks are
// centered on their position (translateY -50%), so the spacings below are what
// each kind needs: a year block is two lines (~22px), a month label one
// (~10px). A section whose label is dropped draws nothing - dragging still
// scrolls through it, and the bubble names it on the way past.

type LabelKind = "primary" | "secondary";

interface Annotated {
  m: Marker;
  y: number;
  isGroupStart: boolean;
}

interface PlacedTick {
  marker: Marker;
  kind: LabelKind;
}

// A label is either a two-line year block or a bare month. Year blocks are
// placed first and always win their space; a month label needs to clear the
// previously placed label AND the next year block below it - without that
// look-ahead, months sat right on top of the next year's label.
function placeLabels(annotated: Annotated[]): PlacedTick[] {
  const PRIMARY_SPACING = 30;
  const SECONDARY_TO_SECONDARY = 13;
  const SECONDARY_TO_PRIMARY = 19;

  const primaryTicks: Annotated[] = [];
  let lastPrimaryY = -Infinity;
  for (const a of annotated) {
    if (a.isGroupStart && a.y - lastPrimaryY >= PRIMARY_SPACING) {
      primaryTicks.push(a);
      lastPrimaryY = a.y;
    }
  }
  const primarySet = new Set(primaryTicks);

  const out: PlacedTick[] = [];
  let nextPrimaryIdx = 0;
  let prevY = -Infinity;
  let prevWasPrimary = false;
  for (const a of annotated) {
    if (primarySet.has(a)) {
      out.push({ marker: a.m, kind: "primary" });
      prevY = a.y;
      prevWasPrimary = true;
      nextPrimaryIdx++;
      continue;
    }
    // A group-start whose year label was dropped (years too dense): writing it
    // out as a bare month would just re-crowd the space that dropping the year
    // label freed.
    if (a.isGroupStart) continue;
    if (a.y - prevY < (prevWasPrimary ? SECONDARY_TO_PRIMARY : SECONDARY_TO_SECONDARY)) continue;
    const nextPrimary = primaryTicks[nextPrimaryIdx];
    if (nextPrimary && nextPrimary.y - a.y < SECONDARY_TO_PRIMARY) continue;
    out.push({ marker: a.m, kind: "secondary" });
    prevY = a.y;
    prevWasPrimary = false;
  }
  return out;
}

/**
 * Immich-style date scrubber pinned to the right edge of the library timeline:
 * year/month markers positioned by where each section sits in the scroll range,
 * draggable to jump to a date, with a bubble showing the current month.
 */
export function TimelineScrubber({ getScroller, getSectionEl, sections, getBottomInset }: Props) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [currentFrac, setCurrentFrac] = useState(0);
  // The section at the fold, held by identity rather than by name: two months
  // can carry the same label (see ScrubberSection.key), and highlighting by
  // name lights up both of them.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Read by the scroll handler, which must not be rebuilt (and its listener
  // torn down and re-attached) just because a drag started or ended.
  const draggingRef = useRef(false);
  // Briefly reveal the scrubber + position bubble while the user scrolls the
  // grid, then fade back out - so scrolling shows where you are, like the drag.
  const [scrolling, setScrolling] = useState(false);
  const scrollHideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The scroll window the rail maps onto: [firstOffset, firstOffset + span].
  // firstOffset is the topmost section's content offset (mapped to the rail's
  // top, since the rail is anchored to the first photo, not to scrollTop 0).
  const rangeRef = useRef({ firstOffset: 0, span: 1 });
  // Where each section starts in the scroll range, in document order. Measured
  // with the rail rather than per scroll frame - see measure().
  const offsetsRef = useRef<{ key: string; offset: number }[]>([]);
  // The scroll range those offsets were measured against: the one thing that
  // can invalidate them without `sections` changing too.
  const measuredHeightRef = useRef(0);
  const [railTop, setRailTop] = useState(120);
  const [railBottom, setRailBottom] = useState(RAIL_GAP);
  const [railHeight, setRailHeight] = useState(0);

  // What a scroll actually changes: where the handle sits, and which section
  // is at the fold. Everything else about the rail is geometry, and geometry
  // does not move when you scroll past it. Measuring it per frame anyway meant
  // a scrubber drag - hundreds of scroll positions, each one a frame - read
  // every month's element back out of the DOM and pushed a fresh array of
  // markers through React, re-rendering every tick on the rail, to draw the
  // exact same ticks in the exact same places. That was the drag stuttering
  // against its own bookkeeping.
  const sync = useCallback(() => {
    const scroller = getScroller();
    if (!scroller) return;
    const { firstOffset, span } = rangeRef.current;
    const top = scroller.scrollTop;
    setCurrentFrac(clamp01((top - firstOffset) / span));
    if (draggingRef.current) return;
    // Deepest section still at/above the fold - the one you're currently in.
    let topmost = offsetsRef.current[0]?.key ?? null;
    for (const o of offsetsRef.current) {
      if (o.offset <= top + 4) topmost = o.key;
    }
    setActiveKey(topmost);
  }, [getScroller]);

  const measure = useCallback(() => {
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
    const raw: { section: ScrubberSection; offset: number }[] = [];
    for (const section of sections) {
      const el = getSectionEl(section.key ?? section.label);
      if (!el) continue;
      raw.push({ section, offset: el.getBoundingClientRect().top - scrollerTop + scroller.scrollTop });
    }
    const firstOffset = raw.length ? Math.min(...raw.map((r) => r.offset)) : 0;
    const span = Math.max(1, maxScroll - firstOffset);
    rangeRef.current = { firstOffset, span };
    offsetsRef.current = raw.map((r) => ({
      key: r.section.key ?? r.section.label,
      offset: r.offset,
    }));
    measuredHeightRef.current = scroller.scrollHeight;

    setMarkers(
      raw.map(({ section, offset }) => ({
        ...toMarkerFields(section),
        frac: clamp01((offset - firstOffset) / span),
      }))
    );
    sync();
  }, [getScroller, getSectionEl, sections, getBottomInset, sync]);

  useEffect(() => {
    const scroller = getScroller();
    if (!scroller) return;
    measure();
    // Reveal the bubble on real user scrolls only (not the mount/resize
    // measurements), and auto-hide a moment after scrolling stops.
    //
    // Coalesced onto animation frames, the same way the grid's own scroll
    // tracking is (useVirtualWindow): scroll events fire faster than the screen
    // refreshes, and the result can only be seen once per frame no matter how
    // often it is computed - on the thread the scroll itself needs.
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // The grid grew or shrank underneath us: the cached offsets describe a
        // scroll range that no longer exists, so re-measure before using them.
        if (scroller.scrollHeight !== measuredHeightRef.current) measure();
        else sync();
      });
      setScrolling(true);
      clearTimeout(scrollHideTimer.current);
      scrollHideTimer.current = setTimeout(() => setScrolling(false), 900);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    window.addEventListener("resize", measure);
    // The page-enter animation slides `.page` down a few px while this first
    // measures, so re-measure once any enter animation settles (animationend
    // bubbles to window) - otherwise the rail keeps that offset until the
    // next scroll or resize.
    window.addEventListener("animationend", measure);
    return () => {
      cancelAnimationFrame(raf);
      scroller.removeEventListener("scroll", onScroll);
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("animationend", measure);
      clearTimeout(scrollHideTimer.current);
    };
  }, [getScroller, measure, sync]);

  const scrollToFrac = useCallback(
    (frac: number) => {
      const scroller = getScroller();
      const rail = railRef.current;
      if (!scroller || !rail) return;
      const clamped = Math.min(1, Math.max(0, frac));
      // Invert the measure() mapping: frac 0 = the topmost section, frac 1 =
      // the bottom of the scroll range.
      const { firstOffset, span } = rangeRef.current;
      scroller.scrollTop = firstOffset + clamped * span;
      // Move the indicator with the pointer right away, rather than waiting for
      // the scroll event to round-trip through sync().
      setCurrentFrac(clamped);
      // Show the section that's actually at the top after this scroll - the
      // last marker at or above the drag position - so the bubble matches the
      // grid (nearest-marker would flip to the next section a bit too early).
      // Markers are in document order => ascending frac, regardless of whether
      // the timeline runs newest-first (library) or oldest-first (import).
      let topmost = markers[0]?.key ?? null;
      for (const m of markers) {
        if (m.frac <= clamped + 1e-4) topmost = m.key;
        else break;
      }
      setActiveKey(topmost);
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
    const onUp = () => {
      draggingRef.current = false;
      setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, scrollToFrac, fracFromEvent]);

  // What the rail shows for each section, in document order. Depends only on
  // the rail's geometry and which mode it is in, so it survives a drag
  // untouched - which is the point of keeping `markers` stable across scrolls.
  const shown = useMemo(() => {
    const usable = Math.max(0, railHeight - RAIL_INSET * 2);
    const seenGroups = new Set<string>();
    const annotated: Annotated[] = markers.map((m) => {
      const isGroupStart = !seenGroups.has(m.group);
      if (isGroupStart) seenGroups.add(m.group);
      return { m, y: m.frac * usable, isGroupStart };
    });
    return placeLabels(annotated);
  }, [markers, railHeight]);

  // The ticks themselves only change when the rail is re-measured or the
  // highlighted section changes - not on every step of a scroll, which is what
  // moves the handle and the bubble below. Kept out of the render that follows
  // the handle so a drag doesn't rebuild every label on the rail per frame.
  const ticks = useMemo(
    () =>
      shown.map(({ marker: m, kind }) => {
        const isActive = m.key === activeKey;
        return (
          <div
            key={m.key}
            className={`scrubber-tick${kind === "primary" ? " year-start" : ""}${isActive ? " active" : ""}`}
            style={{ top: posTop(m.frac) }}
          >
            {kind === "primary" && <span className="scrubber-year">{m.primary}</span>}
            {/* When the primary line already shows the whole label (a no-year
                label like "Unknown date"), a second truncated line under it
                would just repeat its first letters. */}
            {kind === "secondary" || (kind === "primary" && m.primary !== m.label) ? (
              <span className="scrubber-month">{m.secondary}</span>
            ) : null}
          </div>
        );
      }),
    [shown, activeKey]
  );

  // Bubble text for whichever section is at the fold. Looked up rather than
  // stored alongside the key, so it can never drift from the markers.
  const activeLabel = useMemo(
    () => markers.find((m) => m.key === activeKey)?.label ?? null,
    [markers, activeKey]
  );

  if (sections.length < 1) return null;

  return (
    <div
      ref={railRef}
      className={`timeline-scrubber${dragging ? " dragging" : ""}${scrolling ? " scrolling" : ""}`}
      style={{ top: railTop, bottom: railBottom }}
      onPointerDown={(e) => {
        draggingRef.current = true;
        setDragging(true);
        scrollToFrac(fracFromEvent(e.clientY));
      }}
    >
      {ticks}

      <div className="scrubber-handle" style={{ top: posTop(currentFrac) }} />

      {activeLabel && (
        <div className={`scrubber-bubble${dragging || scrolling ? " visible" : ""}`} style={{ top: posTop(currentFrac) }}>
          {activeLabel}
        </div>
      )}
    </div>
  );
}

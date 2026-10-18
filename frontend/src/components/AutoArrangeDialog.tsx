import { useState } from "react";
import { useEnterToConfirm, useEscapeToClose } from "../utils/modalKeys";
import { IconSparkle } from "./Icons";

// What Auto-arrange is asked before it rebuilds the pages: how many photos
// each page gets (a range - "1 to 4"), what puts photos together, how the
// page is set, whether sizes stay alike or the paper gets filled, and how
// much air between the photos. The answers are remembered, and Auto pick's
// "arrange afterwards" uses them without asking.
import type { PageLayout, PageSizes, PageStyle } from "../utils/pageTemplates";

export type GroupBy = "look" | "time" | "order";
export type { PageLayout, PageSizes, PageStyle };

export interface ArrangeOptions {
  minPerPage: number;
  maxPerPage: number;
  groupBy: GroupBy;
  layout: PageLayout;
  style: PageStyle;
  sizes: PageSizes;
  gapMm: number;
}

export const MAX_PER_PAGE = 9;
export const DEFAULT_ARRANGE: ArrangeOptions = {
  minPerPage: 2,
  maxPerPage: 6,
  groupBy: "look",
  layout: "best",
  style: "balanced",
  sizes: "fill",
  gapMm: 6,
};
const KEY = "pm:auto-arrange";

function clampCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PER_PAGE ? value : fallback;
}

export function loadArrangeOptions(): ArrangeOptions {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_ARRANGE;
    const parsed = JSON.parse(raw) as Partial<ArrangeOptions> & { perPage?: "auto" | number };
    // Before the range there was one "per page" pick: a number or Auto (2–6).
    const legacy = typeof parsed.perPage === "number" ? parsed.perPage : null;
    const minPerPage = clampCount(parsed.minPerPage ?? legacy, DEFAULT_ARRANGE.minPerPage);
    const maxPerPage = clampCount(parsed.maxPerPage ?? legacy, DEFAULT_ARRANGE.maxPerPage);
    return {
      minPerPage: Math.min(minPerPage, maxPerPage),
      maxPerPage: Math.max(minPerPage, maxPerPage),
      groupBy: parsed.groupBy === "time" || parsed.groupBy === "order" ? parsed.groupBy : "look",
      layout: parsed.layout === "rows" || parsed.layout === "columns" ? parsed.layout : "best",
      style: parsed.style === "fitted" || parsed.style === "edge" ? parsed.style : "balanced",
      sizes: parsed.sizes === "even" ? "even" : "fill",
      gapMm: parsed.gapMm === 3 || parsed.gapMm === 12 ? parsed.gapMm : 6,
    };
  } catch {
    return DEFAULT_ARRANGE;
  }
}

function saveArrangeOptions(options: ArrangeOptions) {
  try {
    localStorage.setItem(KEY, JSON.stringify(options));
  } catch {
    // Not remembered, then; the dialog still works.
  }
}

const COUNTS = Array.from({ length: MAX_PER_PAGE }, (_, i) => i + 1);
const GROUP_BY: { value: GroupBy; label: string; title: string }[] = [
  { value: "look", label: "Look", title: "Photos that look alike share a page" },
  { value: "time", label: "Time", title: "In the order they were taken; a new page where the shooting paused" },
  { value: "order", label: "Filmstrip", title: "In the filmstrip's order" },
];
const LAYOUT: { value: PageLayout; label: string; title: string }[] = [
  { value: "best", label: "Best fit", title: "Rows or columns, whichever covers more of the page" },
  { value: "rows", label: "Rows", title: "Rows across the page" },
  { value: "columns", label: "Columns", title: "Columns down the page" },
];
const STYLE: { value: PageStyle; label: string; title: string }[] = [
  { value: "balanced", label: "Balanced", title: "Photos keep their shape and order" },
  { value: "fitted", label: "Fitted", title: "Photos may change places so the page fills better" },
  { value: "edge", label: "Edge to edge", title: "The page is filled to the margin; photos are trimmed a little" },
];
const SIZES: { value: PageSizes; label: string; title: string }[] = [
  { value: "fill", label: "Fill the page", title: "The split that covers the most paper, even if one photo ends up bigger" },
  { value: "even", label: "Even", title: "Photos on a page stay about the same size" },
];
const SPACING: { value: number; label: string }[] = [
  { value: 3, label: "Tight" },
  { value: 6, label: "Normal" },
  { value: 12, label: "Airy" },
];

function describe(options: ArrangeOptions): string {
  const { minPerPage: lo, maxPerPage: hi, style } = options;
  const how = style === "edge" ? " Edge to edge." : style === "fitted" ? " Fitted." : "";
  if (lo === hi) return (lo === 1 ? "One photo per page." : `${lo} photos per page.`) + how;
  return `${lo} to ${hi} photos per page, as they fit.` + how;
}

export function AutoArrangeDialog({
  count,
  replaces,
  onClose,
  onArrange,
  closing = false,
}: {
  count: number;
  // Something is on the canvas already and will be replaced.
  replaces: boolean;
  onClose: () => void;
  onArrange: (options: ArrangeOptions) => void;
  closing?: boolean;
}) {
  const [options, setOptions] = useState<ArrangeOptions>(loadArrangeOptions);
  useEscapeToClose(!closing, onClose);
  const confirm = () => {
    saveArrangeOptions(options);
    onArrange(options);
  };
  useEnterToConfirm(!closing, confirm);
  const set = (patch: Partial<ArrangeOptions>) => setOptions((o) => ({ ...o, ...patch }));
  // The range stays a range: picking a floor above the ceiling lifts the
  // ceiling with it, and the other way round.
  const setMin = (n: number) => setOptions((o) => ({ ...o, minPerPage: n, maxPerPage: Math.max(n, o.maxPerPage) }));
  const setMax = (n: number) => setOptions((o) => ({ ...o, maxPerPage: n, minPerPage: Math.min(n, o.minPerPage) }));

  const segmented = <T extends string | number>(
    label: string,
    items: { value: T; label: string; title?: string }[],
    current: T,
    pick: (value: T) => void
  ) => (
    <span className="segmented" role="group" aria-label={label}>
      {items.map((o) => (
        <button key={String(o.value)} type="button" className={current === o.value ? "active" : ""} onClick={() => pick(o.value)} title={o.title}>
          {o.label}
        </button>
      ))}
    </span>
  );

  return (
    <div className={`modal-overlay${closing ? " pm-closing" : ""}`}>
      <div className="modal auto-arrange-modal" role="dialog" aria-modal="true" aria-label="Auto-arrange">
        <div className="auto-pick-head">
          <h3>
            <IconSparkle size={15} /> Auto-arrange
          </h3>
          <span className="auto-pick-hint">
            {replaces ? "Everything on the canvas is replaced; Undo takes it back." : "The pages are laid out for their photos."}
          </span>
        </div>
        <div className="auto-pick-body">
          <div className="auto-pick-row">
            <span className="auto-pick-label">At least</span>
            {segmented("Fewest photos per page", COUNTS.map((n) => ({ value: n, label: String(n) })), options.minPerPage, setMin)}
          </div>
          <div className="auto-pick-row">
            <span className="auto-pick-label">At most</span>
            {segmented("Most photos per page", COUNTS.map((n) => ({ value: n, label: String(n) })), options.maxPerPage, setMax)}
          </div>
          <div className="auto-pick-row auto-arrange-summary">
            <span className="auto-pick-label" aria-hidden="true" />
            <span className="auto-pick-muted">{describe(options)}</span>
          </div>
          <div className="auto-pick-row">
            <span className="auto-pick-label">Group by</span>
            {segmented("Group by", GROUP_BY, options.groupBy, (groupBy) => set({ groupBy }))}
          </div>
          <div className="auto-pick-row">
            <span className="auto-pick-label">Layout</span>
            {segmented("Layout", LAYOUT, options.layout, (layout) => set({ layout }))}
          </div>
          <div className="auto-pick-row">
            <span className="auto-pick-label">Style</span>
            {segmented("Style", STYLE, options.style, (style) => set({ style }))}
          </div>
          <div className="auto-pick-row">
            <span className="auto-pick-label">Sizes</span>
            {segmented("Sizes", SIZES, options.sizes, (sizes) => set({ sizes }))}
          </div>
          <div className="auto-pick-row">
            <span className="auto-pick-label">Spacing</span>
            {segmented("Spacing", SPACING, options.gapMm, (gapMm) => set({ gapMm }))}
          </div>
        </div>
        <div className="auto-pick-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <span className="auto-pick-foot-actions">
            <button className="btn primary" onClick={confirm} autoFocus>
              Arrange {count} photo{count === 1 ? "" : "s"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

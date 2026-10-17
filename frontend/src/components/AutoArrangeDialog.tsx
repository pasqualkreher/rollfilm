import { useState } from "react";
import { useEnterToConfirm, useEscapeToClose } from "../utils/modalKeys";
import { IconSparkle } from "./Icons";

// What Auto-arrange is asked before it rebuilds the pages: how many photos
// each page gets, what puts photos together, and how much air between them.
// The answers are remembered, and Auto pick's "arrange afterwards" uses them
// without asking.
export type PerPage = "auto" | 1 | 2 | 3 | 4 | 6;
export type GroupBy = "look" | "time" | "order";

export interface ArrangeOptions {
  perPage: PerPage;
  groupBy: GroupBy;
  gapMm: number;
}

export const DEFAULT_ARRANGE: ArrangeOptions = { perPage: "auto", groupBy: "look", gapMm: 6 };
const KEY = "pm:auto-arrange";

export function loadArrangeOptions(): ArrangeOptions {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_ARRANGE;
    const parsed = JSON.parse(raw) as Partial<ArrangeOptions>;
    const perPage = parsed.perPage;
    return {
      perPage: perPage === "auto" || perPage === 1 || perPage === 2 || perPage === 3 || perPage === 4 || perPage === 6 ? perPage : "auto",
      groupBy: parsed.groupBy === "time" || parsed.groupBy === "order" ? parsed.groupBy : "look",
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

const PER_PAGE: { value: PerPage; label: string }[] = [
  { value: "auto", label: "Auto (2–6)" },
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
  { value: 6, label: "6" },
];
const GROUP_BY: { value: GroupBy; label: string; title: string }[] = [
  { value: "look", label: "Look", title: "Photos that look alike share a page" },
  { value: "time", label: "Time", title: "In the order they were taken" },
  { value: "order", label: "Filmstrip", title: "In the filmstrip's order" },
];
const SPACING: { value: number; label: string }[] = [
  { value: 3, label: "Tight" },
  { value: 6, label: "Normal" },
  { value: 12, label: "Airy" },
];

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
            <span className="auto-pick-label">Per page</span>
            <span className="segmented" role="group" aria-label="Photos per page">
              {PER_PAGE.map((o) => (
                <button key={String(o.value)} type="button" className={options.perPage === o.value ? "active" : ""} onClick={() => set({ perPage: o.value })}>
                  {o.label}
                </button>
              ))}
            </span>
          </div>
          <div className="auto-pick-row">
            <span className="auto-pick-label">Group by</span>
            <span className="segmented" role="group" aria-label="Group by">
              {GROUP_BY.map((o) => (
                <button key={o.value} type="button" className={options.groupBy === o.value ? "active" : ""} onClick={() => set({ groupBy: o.value })} title={o.title}>
                  {o.label}
                </button>
              ))}
            </span>
          </div>
          <div className="auto-pick-row">
            <span className="auto-pick-label">Spacing</span>
            <span className="segmented" role="group" aria-label="Spacing">
              {SPACING.map((o) => (
                <button key={o.value} type="button" className={options.gapMm === o.value ? "active" : ""} onClick={() => set({ gapMm: o.value })}>
                  {o.label}
                </button>
              ))}
            </span>
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

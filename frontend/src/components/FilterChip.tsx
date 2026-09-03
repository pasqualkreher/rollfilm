import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconChevronDown } from "./Icons";

interface Props {
  // Chip text: the filter's name while inactive ("Color", "Date"), the chosen
  // value once set - so the closed chip always says something useful.
  label: ReactNode;
  // Tints the chip with the accent-soft "filter engaged" look.
  active?: boolean;
  title?: string;
  // Which edge the panel hangs from. A chip parked at the right end of a
  // toolbar needs its panel to grow leftwards, or it is simply cut off by the
  // window.
  align?: "left" | "right";
  // Which way the panel opens. A chip in a bar at the BOTTOM of the screen
  // (the canvas print view's toolbar) must open upwards for the same reason.
  drop?: "down" | "up";
  // Popover content. A function gets `close`, for a panel whose job is done
  // once something in it has been chosen or finished.
  children: ReactNode | ((close: () => void) => ReactNode);
}

// A quiet toolbar chip that opens a small popover - the shared pattern for
// filters whose control is too loud to sit inline in the bar (color swatch
// row, date-range pickers). Same look and behaviour as the TagFilter button.
export function FilterChip({ label, active = false, title, align = "left", drop = "down", children }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape, like a native dropdown.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      // Dropdown menus render through a portal on <body> (so modals can't
      // clip them), which puts them OUTSIDE this wrapper in the DOM even when
      // they belong to a dropdown inside this popover. Without this guard,
      // picking a Camera/Lens/Album/Rating option closed the chip on
      // mousedown - unmounting the menu before its option ever got the click.
      if ((e.target as Element | null)?.closest?.(".dropdown-menu")) return;
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="filter-chip" ref={wrapRef}>
      <button
        type="button"
        className={`tag-filter-btn${active ? " active" : ""}`}
        title={title}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tag-filter-btn-label">{label}</span>
        <span className="tag-filter-caret">
          <IconChevronDown size={11} />
        </span>
      </button>
      {open && (
        <div
          className={`filter-chip-pop${align === "right" ? " filter-chip-pop--right" : ""}${
            drop === "up" ? " filter-chip-pop--up" : ""
          }`}
        >
          {typeof children === "function" ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

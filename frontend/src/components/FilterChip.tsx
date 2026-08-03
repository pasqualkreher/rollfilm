import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconChevronDown } from "./Icons";

interface Props {
  // Chip text: the filter's name while inactive ("Color", "Date"), the chosen
  // value once set - so the closed chip always says something useful.
  label: ReactNode;
  // Tints the chip with the accent-soft "filter engaged" look.
  active?: boolean;
  title?: string;
  // Start out open. Only the initial state - the chip owns it from then on.
  // Used when a pinned panel is unpinned: the same filters were on screen a
  // moment ago, so they shouldn't vanish just because they moved back into the
  // popover.
  initialOpen?: boolean;
  // Popover content.
  children: ReactNode;
}

// A quiet toolbar chip that opens a small popover - the shared pattern for
// filters whose control is too loud to sit inline in the bar (color swatch
// row, date-range pickers). Same look and behaviour as the TagFilter button.
export function FilterChip({ label, active = false, title, initialOpen = false, children }: Props) {
  const [open, setOpen] = useState(initialOpen);
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
      {open && <div className="filter-chip-pop">{children}</div>}
    </div>
  );
}

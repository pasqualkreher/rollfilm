import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { IconChevronDown } from "./Icons";

export interface DropdownOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

interface Props {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  // Button text while no option matches `value` (e.g. options still loading).
  placeholder?: ReactNode;
  disabled?: boolean;
  title?: string;
  className?: string;
  // Serves as the accessible name of the button (the visual label usually
  // sits outside, e.g. the filter row's caption).
  ariaLabel?: string;
}

// The app's dropdown: a quiet button that opens an anchored popover menu right
// under (or, when there is no room, above) the trigger - replacing native
// <select>, whose OS menu renders detached from the control and ignores the
// app's styling. Same look and behaviour as the TagFilter/FilterChip popovers:
// outside click or Escape closes, the selected option is tinted.
export function Dropdown({
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  title,
  className,
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  // Flipped upward when the menu would run off the bottom of the viewport
  // (e.g. dropdowns on a bottom action bar).
  const [openUp, setOpenUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
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

  // Measure after the menu renders: flip up when it overflows the viewport
  // bottom, and start the list scrolled to the selected option.
  useLayoutEffect(() => {
    if (!open || !menuRef.current || !wrapRef.current) return;
    const menu = menuRef.current;
    const anchor = wrapRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - anchor.bottom;
    const spaceAbove = anchor.top;
    setOpenUp(menu.offsetHeight + 8 > spaceBelow && spaceAbove > spaceBelow);
    menu
      .querySelector<HTMLElement>(".dropdown-option.selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [open]);

  return (
    <div className={`dropdown${className ? ` ${className}` : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="tag-filter-btn dropdown-btn"
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="tag-filter-btn-label">{selected?.label ?? placeholder ?? ""}</span>
        <span className="tag-filter-caret">
          <IconChevronDown size={11} />
        </span>
      </button>
      {open && (
        <div
          className={`dropdown-menu${openUp ? " dropdown-menu--up" : ""}`}
          role="listbox"
          ref={menuRef}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`dropdown-option${o.value === value ? " selected" : ""}`}
              disabled={o.disabled}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

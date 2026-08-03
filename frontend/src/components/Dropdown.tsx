import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  // Button text when there is nothing to pick at all. An option-less menu
  // would open as an empty sliver of border and shadow, so the button states
  // the situation instead and stays shut (same as TagFilter's "No tags").
  emptyLabel?: ReactNode;
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
//
// The menu renders through a portal with fixed positioning, so an
// overflow-hidden ancestor (modals clip their rounded corners) can't cut it
// off. The anchor doesn't move while open - any scroll or resize closes the
// menu instead of trying to chase it.
export function Dropdown({
  value,
  options,
  onChange,
  placeholder,
  emptyLabel,
  disabled = false,
  title,
  className,
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  // Screen position of the portalled menu; null on the measuring first frame
  // (rendered invisibly, placed by the layout effect before paint).
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const selected = options.find((o) => o.value === value);
  const isEmpty = options.length === 0;

  function close() {
    setOpen(false);
    setPos(null);
  }

  // The options can drain away while the menu is open (the last album deleted
  // in another view) - drop the menu rather than leave an empty box behind.
  useEffect(() => {
    if (isEmpty) close();
  }, [isEmpty]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    // The fixed-positioned menu would detach from its trigger if anything
    // scrolls or resizes underneath - close instead (scrolling inside the
    // menu's own list is fine).
    function onScroll(e: Event) {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  // Measure after the menu renders (pre-paint): anchor it to the trigger,
  // flip above when it would overflow the viewport bottom, keep it inside the
  // right edge, and start the list scrolled to the selected option.
  useLayoutEffect(() => {
    if (!open || !menuRef.current || !wrapRef.current) return;
    const menu = menuRef.current;
    const anchor = wrapRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - anchor.bottom;
    const spaceAbove = anchor.top;
    const up = menu.offsetHeight + 8 > spaceBelow && spaceAbove > spaceBelow;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - 8));
    setPos({
      left,
      minWidth: anchor.width,
      ...(up
        ? { bottom: window.innerHeight - anchor.top + 6 }
        : { top: anchor.bottom + 6 }),
    });
    menu
      .querySelector<HTMLElement>(".dropdown-option.selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [open]);

  return (
    <div className={`dropdown${className ? ` ${className}` : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="tag-filter-btn dropdown-btn"
        disabled={disabled || isEmpty}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="tag-filter-btn-label">
          {selected?.label ?? (isEmpty ? emptyLabel ?? placeholder : placeholder) ?? ""}
        </span>
        <span className="tag-filter-caret">
          <IconChevronDown size={11} />
        </span>
      </button>
      {open &&
        !isEmpty &&
        createPortal(
          <div
            className="dropdown-menu"
            style={pos ?? { visibility: "hidden", left: 0, top: 0 }}
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
                  close();
                }}
              >
                {o.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}

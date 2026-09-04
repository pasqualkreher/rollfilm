import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown } from "./Icons";

export interface DropdownOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  // What typing in a searchable menu matches against. Defaults to the label
  // when that is plain text; options with a richer label (icons, stars)
  // pass the words a user would type for them.
  search?: string;
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
  // Typeable: the open menu carries a search box that narrows the options as
  // you type, Enter picks the first match, and typing on the closed button
  // opens the menu with that first letter already in the box.
  searchable?: boolean;
}

function searchText(o: DropdownOption): string {
  if (o.search !== undefined) return o.search;
  return typeof o.label === "string" || typeof o.label === "number" ? String(o.label) : "";
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
  searchable = false,
}: Props) {
  const [open, setOpen] = useState(false);
  // Searchable menus: what has been typed, and which of the matching options
  // the arrow keys have landed on (Enter picks it).
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
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
    setQuery("");
    setCursor(0);
  }

  function openWith(initialQuery = "") {
    setQuery(initialQuery);
    setCursor(0);
    setOpen(true);
  }

  const needle = query.trim().toLowerCase();
  const visible =
    searchable && needle
      ? options.filter((o) => searchText(o).toLowerCase().includes(needle))
      : options;

  function pick(o: DropdownOption) {
    if (o.disabled) return;
    onChange(o.value);
    close();
  }

  // Keys inside the search box: arrows walk the matches, Enter takes the one
  // under the cursor (the first match by default), Escape is handled globally.
  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const enabled = visible.filter((o) => !o.disabled);
      if (enabled.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setCursor((c) => (c + step + enabled.length) % enabled.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const enabled = visible.filter((o) => !o.disabled);
      const target = enabled[Math.min(cursor, enabled.length - 1)];
      if (target) pick(target);
    }
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
    // The box takes the keyboard straight away; the caret goes to the end so
    // a letter typed on the closed button continues, not restarts, the word.
    const box = searchRef.current;
    if (box) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
  }, [open]);

  // Keep the arrow-key cursor's option in view as it walks the list.
  useEffect(() => {
    if (!open || !searchable) return;
    menuRef.current
      ?.querySelector<HTMLElement>(".dropdown-option.cursor")
      ?.scrollIntoView({ block: "nearest" });
  }, [open, searchable, cursor, query]);

  // Which option the keyboard cursor sits on, by value (only among the
  // enabled matches, so it never lands on something unpickable).
  const enabledVisible = visible.filter((o) => !o.disabled);
  const cursorValue =
    searchable && enabledVisible.length > 0
      ? enabledVisible[Math.min(cursor, enabledVisible.length - 1)].value
      : null;

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
        onClick={() => (open ? close() : openWith())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openWith();
          } else if (
            searchable &&
            !open &&
            e.key.length === 1 &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.altKey &&
            e.key !== " "
          ) {
            // Start typing on the closed button: open with that letter.
            e.preventDefault();
            openWith(e.key);
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
            {searchable && (
              <input
                ref={searchRef}
                type="text"
                className="dropdown-search"
                placeholder="Type to find…"
                value={query}
                aria-label={ariaLabel ? `Find ${ariaLabel.toLowerCase()}` : "Find"}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
                onKeyDown={onSearchKey}
              />
            )}
            {visible.length === 0 && <div className="dropdown-empty">No match</div>}
            {visible.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`dropdown-option${o.value === value ? " selected" : ""}${
                  o.value === cursorValue ? " cursor" : ""
                }`}
                disabled={o.disabled}
                onClick={() => pick(o)}
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

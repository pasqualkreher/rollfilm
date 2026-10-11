import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown } from "./Icons";
import { Presence } from "./Presence";
import { MOTION } from "../utils/usePresence";
import { useMenuKeys } from "../utils/useMenuKeys";

export interface DropdownOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  // What typing in a searchable menu matches against. Defaults to the label
  // when that is plain text; options with a richer label (icons, stars)
  // pass the words a user would type for them.
  search?: string;
  // What the closed button shows for this option when that should be
  // shorter than the menu's wording ("Newest" for "Newest first", "3+" for
  // three stars): the button's own icon already says what the value is, so
  // the field can stay narrow in the pinned filter row.
  short?: ReactNode;
}

interface Props {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  // Button text while no option matches `value` (e.g. options still loading).
  placeholder?: ReactNode;
  // A glyph in front of the label that stays whatever is picked.
  icon?: ReactNode;
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
  icon,
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
  }

  function openWith(initialQuery = "") {
    setQuery(initialQuery);
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

  // The keyboard (utils/useMenuKeys): arrows, Home/End, Enter, Escape, and
  // typed letters where there is no search box to type into. The cursor
  // starts on the chosen option, the way a popup button opens on its value.
  const enabledVisible = visible.filter((o) => !o.disabled);
  const { cursor: cursorValue, setCursor } = useMenuKeys({
    open: open && !isEmpty,
    ids: enabledVisible.map((o) => o.value),
    initial: enabledVisible.some((o) => o.value === value) ? value : enabledVisible[0]?.value ?? null,
    labelOf: searchable ? undefined : (id) => searchText(options.find((o) => o.value === id)!),
    onPick: (id) => {
      const o = options.find((x) => x.value === id);
      if (o) pick(o);
    },
    onClose: close,
  });
  // Narrowing the matches moves the cursor to the first of them.
  const firstVisible = enabledVisible[0]?.value ?? null;
  useEffect(() => {
    if (open && searchable) setCursor(firstVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

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
    // The fixed-positioned menu would detach from its trigger if anything
    // scrolls or resizes underneath - close instead (scrolling inside the
    // menu's own list is fine).
    function onScroll(e: Event) {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
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
  // Which option the keyboard cursor sits on, by value (only among the
  // enabled matches, so it never lands on something unpickable).
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
        {icon}
        <span className="tag-filter-btn-label">
          {selected?.short ?? selected?.label ?? (isEmpty ? emptyLabel ?? placeholder : placeholder) ?? ""}
        </span>
        <span className="tag-filter-caret">
          <IconChevronDown size={11} />
        </span>
      </button>
      {/* The portal stays mounted (empty while shut) so Presence can hold the
          menu through its exit; the frame it freezes keeps the measured
          position, so the closing menu does not jump. .is-placed starts the
          pop only once the invisible measuring frame is over. */}
      {createPortal(
        <Presence open={open && !isEmpty} ms={MOTION.pop}>
          {open && !isEmpty && (
            <div
              className={`dropdown-menu${pos ? " is-placed" : ""}${pos && "bottom" in pos ? " dropdown-menu--up" : ""}`}
              style={pos ?? { visibility: "hidden", left: 0, top: 0 }}
              role="listbox"
              ref={menuRef}
            >
              {searchable && (
                <input
                  ref={searchRef}
                  type="text"
                  className="dropdown-search"
                  // A text input is 20 characters wide by nature and the menu
                  // has no width of its own, so it would grow to the box
                  // instead of the box filling the menu. size=1 takes that
                  // claim away; the CSS stretches it to the menu's width.
                  size={1}
                  placeholder="Type to find…"
                  value={query}
                  aria-label={ariaLabel ? `Find ${ariaLabel.toLowerCase()}` : "Find"}
                  onChange={(e) => setQuery(e.target.value)}
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
                  data-menu-id={o.value}
                  onMouseEnter={() => !o.disabled && setCursor(o.value)}
                  onClick={() => pick(o)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </Presence>,
        document.body
      )}
    </div>
  );
}

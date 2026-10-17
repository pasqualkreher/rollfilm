import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown } from "./Icons";
import { Presence } from "./Presence";
import { MOTION } from "../utils/usePresence";
import { tagLeaf, tagTreeRows } from "../utils/tagPaths";

interface Props {
  // All tag names the user can filter by.
  options: string[];
  // Currently-selected tags (AND semantics - a photo must have all of them).
  value: string[];
  onChange: (tags: string[]) => void;
  // Button text while nothing is selected ("Any" reads right for filtering;
  // pickers reusing this component pass their own, e.g. "Pick tags…").
  emptyLabel?: string;
  title?: string;
  // Drawn before the label - pickers in a form pass one, the compact filter
  // bars go without.
  icon?: ReactNode;
}

// Multi-select tag filter: a compact button that opens a checkbox popover.
// Selecting several tags narrows the grid to photos carrying all of them.
//
// Like Dropdown, the popover renders through a portal with fixed positioning:
// inside a dialog's scrolling body it would be clipped and scroll the dialog
// instead of its own list. Its list is capped to the room on screen.
export function TagFilter({
  options,
  value,
  onChange,
  emptyLabel = "Any",
  title = "Filter by tags",
  icon,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  // Screen position of the portalled popover; null on the measuring frame.
  const [pos, setPos] = useState<CSSProperties | null>(null);

  // Opening starts with an empty search: what was typed last time narrowed
  // last time's pick, not this one.
  useEffect(() => {
    if (open) setQuery("");
    else setPos(null);
  }, [open]);

  // Close on outside click / Escape, like a native dropdown.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    // The fixed popover would detach from its button if anything scrolls or
    // resizes underneath - close instead (its own list may scroll).
    function onScroll(e: Event) {
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onResize() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // Place it before paint: under the button, or above when there is more
  // room there; the list gets the height that is left on screen.
  useLayoutEffect(() => {
    if (!open || !popRef.current || !wrapRef.current) return;
    const pop = popRef.current;
    const anchor = wrapRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - anchor.bottom - 14;
    const spaceAbove = anchor.top - 14;
    const up = pop.offsetHeight > spaceBelow && spaceAbove > spaceBelow;
    const room = up ? spaceAbove : spaceBelow;
    const list = pop.querySelector<HTMLElement>(".tag-filter-list");
    const rest = list ? pop.offsetHeight - list.offsetHeight : 0;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - pop.offsetWidth - 8));
    setPos({
      left,
      ...(up ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }),
      ["--tag-list-max" as string]: `${Math.max(96, Math.min(260, room - rest))}px`,
    });
  }, [open]);

  // Picking a tag spends the search: the box empties and takes the focus
  // back, so the next tag is one more word away - and the full list is in
  // view again for the eye.
  function toggle(tag: string) {
    onChange(value.includes(tag) ? value.filter((t) => t !== tag) : [...value, tag]);
    setQuery("");
    searchRef.current?.focus();
  }

  // The list is the tag tree: "Travel/Italy/Rome" sits indented under Italy
  // under Travel, and a parent no photo carries on its own is still a row -
  // ticking it finds everything filed under it (the backend matches the
  // prefix). A search shows the matching paths flat, parents and all.
  const rows = useMemo(() => tagTreeRows(options), [options]);
  const needle = query.trim().toLowerCase();
  const filtered = needle ? rows.filter((r) => r.path.toLowerCase().includes(needle)) : rows;

  const label =
    value.length === 0 ? emptyLabel : value.length === 1 ? tagLeaf(value[0]) : `${value.length} tags`;

  return (
    <div className="tag-filter" ref={wrapRef}>
      <button
        type="button"
        className={`tag-filter-btn${value.length ? " active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={title}
        disabled={options.length === 0}
      >
        {icon}
        <span className="tag-filter-btn-label">{options.length === 0 ? "No tags" : label}</span>
        <span className="tag-filter-caret"><IconChevronDown size={11} /></span>
      </button>

      {createPortal(
      <Presence open={open && options.length > 0} ms={MOTION.pop}>
        {open && options.length > 0 && (
          <div
            className="tag-filter-pop"
            style={pos ?? { visibility: "hidden", left: 0, top: 0 }}
            ref={popRef}
          >
            {/* Always typeable, however short the list - the fingers land on
                the keyboard before the eye finds the row. */}
            <input
              type="text"
              className="tag-filter-search"
              placeholder="Find a tag…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter takes the first match - type, Enter, type, Enter.
                if (e.key === "Enter" && filtered.length > 0) {
                  e.preventDefault();
                  toggle(filtered[0].path);
                }
              }}
              ref={searchRef}
              autoFocus
            />
            <div className="tag-filter-list">
              {filtered.length === 0 ? (
                <div className="tag-filter-empty">No matching tags</div>
              ) : (
                filtered.map((row) => (
                  <label
                    key={row.path}
                    className={`tag-filter-item${row.own ? "" : " tag-filter-item--implied"}`}
                    style={needle ? undefined : { paddingLeft: 6 + row.depth * 16 }}
                    title={row.path}
                  >
                    <input
                      type="checkbox"
                      checked={value.includes(row.path)}
                      onChange={() => toggle(row.path)}
                    />
                    <span>{needle ? row.path : row.leaf}</span>
                  </label>
                ))
              )}
            </div>
            {value.length > 0 && (
              <button type="button" className="tag-filter-clear" onClick={() => onChange([])}>
                Clear tags
              </button>
            )}
          </div>
        )}
      </Presence>,
      document.body,
      )}
    </div>
  );
}

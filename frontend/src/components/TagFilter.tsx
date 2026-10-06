import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

  // Opening starts with an empty search: what was typed last time narrowed
  // last time's pick, not this one.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // Close on outside click / Escape, like a native dropdown.
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

      <Presence open={open && options.length > 0} ms={MOTION.pop}>
        {open && options.length > 0 && (
          <div className="tag-filter-pop">
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
      </Presence>
    </div>
  );
}

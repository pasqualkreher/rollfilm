import { useEffect, useRef, useState } from "react";
import { IconChevronDown } from "./Icons";

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
}

// Multi-select tag filter: a compact button that opens a checkbox popover.
// Selecting several tags narrows the grid to photos carrying all of them.
export function TagFilter({ options, value, onChange, emptyLabel = "Any", title = "Filter by tags" }: Props) {
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

  const filtered = query.trim()
    ? options.filter((t) => t.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  const label =
    value.length === 0 ? emptyLabel : value.length === 1 ? value[0] : `${value.length} tags`;

  return (
    <div className="tag-filter" ref={wrapRef}>
      <button
        type="button"
        className={`tag-filter-btn${value.length ? " active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={title}
        disabled={options.length === 0}
      >
        <span className="tag-filter-btn-label">{options.length === 0 ? "No tags" : label}</span>
        <span className="tag-filter-caret"><IconChevronDown size={11} /></span>
      </button>

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
                toggle(filtered[0]);
              }
            }}
            ref={searchRef}
            autoFocus
          />
          <div className="tag-filter-list">
            {filtered.length === 0 ? (
              <div className="tag-filter-empty">No matching tags</div>
            ) : (
              filtered.map((tag) => (
                <label key={tag} className="tag-filter-item">
                  <input type="checkbox" checked={value.includes(tag)} onChange={() => toggle(tag)} />
                  <span>{tag}</span>
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
    </div>
  );
}

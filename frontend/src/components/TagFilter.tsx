import { useEffect, useRef, useState } from "react";

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

  function toggle(tag: string) {
    onChange(value.includes(tag) ? value.filter((t) => t !== tag) : [...value, tag]);
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
        <span className="tag-filter-caret">▾</span>
      </button>

      {open && options.length > 0 && (
        <div className="tag-filter-pop">
          {options.length > 8 && (
            <input
              type="text"
              className="tag-filter-search"
              placeholder="Find a tag…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          )}
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

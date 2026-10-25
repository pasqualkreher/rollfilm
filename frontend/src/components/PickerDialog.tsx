import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useEscapeToClose } from "../utils/modalKeys";
import { useMenuKeys } from "../utils/useMenuKeys";

export interface PickerItem {
  id: string;
  label: ReactNode;
  // What typing matches against (the plain name).
  search: string;
  // A small trailing figure, the album's or canvas's photo count.
  count?: number;
}

export interface PickerGroup {
  heading?: string;
  items: PickerItem[];
  // A "New …" row at the group's foot, where the list can grow.
  newLabel?: string;
  onNew?: () => void;
}

interface Props {
  title: string;
  groups: PickerGroup[];
  onPick: (id: string) => void;
  onClose: () => void;
  // Set by <Presence> while the dialog animates out.
  closing?: boolean;
}

const NEW_PREFIX = "__new__:";

// The long list behind a menu's "More…": every preset, album, canvas or tag
// with a search box over it, so a library with fifty albums picks one by
// typing three letters instead of scrolling a menu. Arrow keys, Enter and
// typed letters as in the menus (utils/useMenuKeys); Escape closes. The
// caller runs the pick and closes the dialog.
export function PickerDialog({ title, groups, onPick, onClose, closing = false }: Props) {
  const [needle, setNeedle] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  useEscapeToClose(!closing, onClose);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const q = needle.trim().toLowerCase();
  const visible = useMemo(
    () =>
      groups
        .map((g) => ({ ...g, items: q ? g.items.filter((i) => i.search.toLowerCase().includes(q)) : g.items }))
        .filter((g) => g.items.length > 0 || (!q && g.newLabel)),
    [groups, q]
  );
  const ids = visible.flatMap((g, gi) => [
    ...g.items.map((i) => i.id),
    ...(g.newLabel && !q ? [`${NEW_PREFIX}${gi}`] : []),
  ]);
  const labelOf = (id: string) =>
    id.startsWith(NEW_PREFIX)
      ? visible[Number(id.slice(NEW_PREFIX.length))]?.newLabel ?? ""
      : visible.flatMap((g) => g.items).find((i) => i.id === id)?.search ?? "";
  const pick = (id: string) => {
    if (id.startsWith(NEW_PREFIX)) visible[Number(id.slice(NEW_PREFIX.length))]?.onNew?.();
    else onPick(id);
  };
  // The typed letters go to the search box, not to the menu's own typing.
  const { lit, setCursor } = useMenuKeys({
    open: !closing,
    ids,
    initial: ids[0] ?? null,
    labelOf: undefined,
    onPick: pick,
    onClose,
  });
  // The lit row stays in view while the arrow keys move it.
  useEffect(() => {
    if (!lit) return;
    listRef.current?.querySelector<HTMLElement>(`[data-menu-id="${CSS.escape(lit)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [lit]);

  return (
    <div className={`modal-overlay${closing ? " pm-closing" : ""}`}>
      <div className="modal pair-delete-modal picker-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="pair-delete-body">
          <h3>{title}</h3>
          <input
            ref={inputRef}
            className="dropdown-search picker-search"
            type="search"
            value={needle}
            placeholder="Search…"
            aria-label="Search"
            onChange={(e) => setNeedle(e.target.value)}
            onKeyDown={(e) => {
              // Enter takes the lit row; the arrows are the list's (useMenuKeys).
              if (e.key === "Enter" && lit) {
                e.preventDefault();
                pick(lit);
              }
            }}
          />
          <div className="picker-list" ref={listRef} role="listbox">
            {visible.length === 0 && <div className="dropdown-group-label">No match</div>}
            {visible.map((g, gi) => (
              <div key={g.heading ?? gi}>
                {g.heading && <div className="dropdown-group-label">{g.heading}</div>}
                {g.items.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    role="option"
                    aria-selected={lit === i.id}
                    data-menu-id={i.id}
                    className={`dropdown-option picker-row${lit === i.id ? " cursor" : ""}`}
                    onMouseEnter={() => setCursor(i.id, true)}
                    onClick={() => onPick(i.id)}
                  >
                    <span className="picker-row-label">{i.label}</span>
                    {i.count !== undefined && <span className="picker-row-count">{i.count}</span>}
                  </button>
                ))}
                {g.newLabel && !q && (
                  <button
                    type="button"
                    role="option"
                    aria-selected={lit === `${NEW_PREFIX}${gi}`}
                    data-menu-id={`${NEW_PREFIX}${gi}`}
                    className={`dropdown-option picker-row${lit === `${NEW_PREFIX}${gi}` ? " cursor" : ""}`}
                    onMouseEnter={() => setCursor(`${NEW_PREFIX}${gi}`, true)}
                    onClick={() => g.onNew?.()}
                  >
                    <span className="picker-row-label">{g.newLabel}</span>
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

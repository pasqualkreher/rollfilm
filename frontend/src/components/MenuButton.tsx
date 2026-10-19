import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Presence } from "./Presence";
import { MOTION } from "../utils/usePresence";
import { useMenuKeys } from "../utils/useMenuKeys";

// A row of an action menu: something to pick, a heading over a group of
// them, or a rule between groups.
export type MenuEntry =
  | {
      id: string;
      label: ReactNode;
      // What typing matches against when the label is not plain text.
      search?: string;
      disabled?: boolean;
      // A row that removes something: drawn in the danger colour.
      danger?: boolean;
    }
  | { heading: string }
  | { sep: true };

export interface MenuButtonHandle {
  // Open the menu at a point instead of under the button (a right-click).
  openAt(x: number, y: number): void;
}

interface Props {
  entries: MenuEntry[];
  onPick: (id: string) => void;
  // What the trigger button shows.
  children: ReactNode;
  // The trigger's classes ("btn btn-sm" for a labelled button, a bare class
  // for an icon-only one).
  className?: string;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
  // Which edge of the trigger the menu lines up with.
  align?: "start" | "end";
}

function isPick(e: MenuEntry): e is Extract<MenuEntry, { id: string }> {
  return "id" in e;
}

function searchText(e: Extract<MenuEntry, { id: string }>): string {
  if (e.search !== undefined) return e.search;
  return typeof e.label === "string" || typeof e.label === "number" ? String(e.label) : "";
}

// An action menu on a button - "+ New mask", a row's "⋯" - the counterpart of
// Dropdown (which picks a value and shows it). Same popover, same look
// (.dropdown-menu / .dropdown-option), same keyboard (utils/useMenuKeys:
// arrows, Home/End, Enter, Escape, typed letters), the same portal with fixed
// positioning so no overflow-hidden ancestor clips it, and the same rule that
// a scroll or resize underneath closes it rather than chasing the anchor.
// Headings and rules group the rows the way the system's menus do.
export const MenuButton = forwardRef<MenuButtonHandle, Props>(function MenuButton(
  { entries, onPick, children, className, title, ariaLabel, disabled = false, align = "start" },
  ref
) {
  const [open, setOpen] = useState(false);
  // Where the menu was asked for: under the button, or at a right-click.
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  function close() {
    setOpen(false);
    setPos(null);
    setAt(null);
  }

  useImperativeHandle(ref, () => ({
    openAt(x: number, y: number) {
      setAt({ x, y });
      setOpen(true);
    },
  }));

  const picks = entries.filter(isPick);
  const enabled = picks.filter((e) => !e.disabled);

  function pick(id: string) {
    const e = picks.find((x) => x.id === id);
    if (!e || e.disabled) return;
    close();
    onPick(id);
  }

  const { lit: cursor, setCursor } = useMenuKeys({
    open,
    ids: enabled.map((e) => e.id),
    initial: null,
    labelOf: (id) => {
      const e = picks.find((x) => x.id === id);
      return e ? searchText(e) : "";
    },
    onPick: pick,
    onClose: close,
  });

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    }
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

  // Place it once it has a size: under the button (flipped above when the
  // room below is short), or at the point it was asked for, nudged back
  // inside the window.
  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    const menu = menuRef.current;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    if (at) {
      const left = Math.max(8, Math.min(at.x, window.innerWidth - w - 8));
      const top = Math.max(8, Math.min(at.y, window.innerHeight - h - 8));
      setPos({ left, top });
      return;
    }
    const anchor = btnRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const spaceBelow = window.innerHeight - anchor.bottom;
    const up = h + 8 > spaceBelow && anchor.top > spaceBelow;
    const wanted = align === "end" ? anchor.right - w : anchor.left;
    const left = Math.max(8, Math.min(wanted, window.innerWidth - w - 8));
    setPos({
      left,
      ...(up ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }),
    });
  }, [open, at, align]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={className}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (open) close();
          else setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
      </button>
      {createPortal(
        <Presence open={open} ms={MOTION.pop}>
          {open && (
            <div
              className={`dropdown-menu menu-button-menu${pos ? " is-placed" : ""}${pos && "bottom" in pos ? " dropdown-menu--up" : ""}`}
              style={pos ?? { visibility: "hidden", left: 0, top: 0 }}
              role="menu"
              ref={menuRef}
              // A menu opened by a right-click must not pass the click on to
              // what is under it.
              onContextMenu={(e) => e.preventDefault()}
            >
              {entries.map((e, i) => {
                if ("sep" in e) return <div key={`sep-${i}`} className="dropdown-sep" role="separator" />;
                if ("heading" in e)
                  return (
                    <div key={`h-${i}`} className="dropdown-group-label" role="presentation">
                      {e.heading}
                    </div>
                  );
                return (
                  <button
                    key={e.id}
                    type="button"
                    role="menuitem"
                    className={`dropdown-option${e.id === cursor ? " cursor" : ""}${e.danger ? " dropdown-option--danger" : ""}`}
                    disabled={e.disabled}
                    data-menu-id={e.id}
                    onMouseEnter={() => !e.disabled && setCursor(e.id, true)}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      pick(e.id);
                    }}
                  >
                    {e.label}
                  </button>
                );
              })}
            </div>
          )}
        </Presence>,
        document.body
      )}
    </>
  );
});

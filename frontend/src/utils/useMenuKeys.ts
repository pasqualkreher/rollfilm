import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

// The keyboard of a menu, the way the system's menus have it: the arrow keys
// walk the rows (and wrap), Home and End jump, Enter or Space takes the row
// under the cursor, Escape closes, typing a letter jumps to the row that
// starts with it (more letters narrow it, the same letter again cycles), and
// Right / Left open and close a submenu where the menu has one. One hook for
// every custom menu in the app - the dropdowns, the grid's right-click menu -
// so they all answer the same keys the same way.
//
// The hook does not need the focus: while the menu is open it listens on the
// window (captured), so the trigger button may keep the focus and a text box
// inside the menu (a searchable dropdown) keeps the letters for itself when
// `labelOf` is left out. The keys it takes are stopped there, so a page's own
// shortcuts (the grid's arrows, the culling digits) stay quiet under a menu.

export interface MenuKeysOptions {
  // Listening while true. A menu with a submenu open passes `paused` instead
  // of closing, so its cursor is still there when the submenu goes.
  open: boolean;
  paused?: boolean;
  // The rows that can be picked, in order.
  ids: string[];
  // The row the cursor starts on when the menu opens (the chosen entry).
  initial?: string | null;
  // The text a row is found by when typing. Left out, typing is not taken.
  labelOf?: (id: string) => string;
  onPick: (id: string) => void;
  onClose: () => void;
  onRight?: (id: string) => void;
  onLeft?: () => void;
}

// How long a typed prefix is kept before the next letter starts afresh.
const TYPEAHEAD_MS = 1000;

function isTextBox(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

export function useMenuKeys(options: MenuKeysOptions) {
  const [cursor, setCursorState] = useState<string | null>(null);
  // Whether the pointer put the cursor there. The pointer's row is painted
  // by :hover, in the same frame the pointer arrives; painting it again from
  // state would lag a render behind and stay lit after the pointer has left.
  // So `lit` is only the keyboard's cursor, while `cursor` is what Enter takes
  // either way.
  const [byPointer, setByPointer] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const latest = useRef(options);
  latest.current = options;

  const setCursor = (id: string | null, pointer = false) => {
    cursorRef.current = id;
    setCursorState(id);
    setByPointer(pointer);
  };

  // A fresh cursor on every opening.
  const wasOpen = useRef(false);
  if (options.open && !wasOpen.current) {
    cursorRef.current = options.initial ?? null;
    setCursorState(cursorRef.current);
    setByPointer(false);
  }
  wasOpen.current = options.open;

  useEffect(() => {
    if (!options.open) return;
    let typed = "";
    let typedAt = 0;

    const onKey = (e: KeyboardEvent) => {
      const o = latest.current;
      if (o.paused || e.metaKey || e.ctrlKey || e.altKey) return;
      const ids = o.ids;
      const at = cursorRef.current ? ids.indexOf(cursorRef.current) : -1;
      const move = (i: number) => {
        if (ids.length === 0) return;
        setCursor(ids[(i + ids.length) % ids.length]);
      };
      let handled = true;
      switch (e.key) {
        case "ArrowDown":
          move(at < 0 ? 0 : at + 1);
          break;
        case "ArrowUp":
          move(at < 0 ? ids.length - 1 : at - 1);
          break;
        case "Home":
          move(0);
          break;
        case "End":
          move(ids.length - 1);
          break;
        case "Enter":
        case " ":
          // A space typed into a text box inside the menu (a searchable
          // dropdown, the picker's search) is part of the search, not a pick.
          if (e.key === " " && isTextBox(e.target)) {
            handled = false;
            break;
          }
          if (cursorRef.current) o.onPick(cursorRef.current);
          break;
        case "Escape":
          o.onClose();
          break;
        case "ArrowRight":
          if (o.onRight && cursorRef.current) o.onRight(cursorRef.current);
          else handled = false;
          break;
        case "ArrowLeft":
          if (o.onLeft) o.onLeft();
          else handled = false;
          break;
        default: {
          if (!o.labelOf || e.key.length !== 1 || e.key === " ") {
            handled = false;
            break;
          }
          const now = performance.now();
          typed = now - typedAt < TYPEAHEAD_MS ? typed + e.key.toLowerCase() : e.key.toLowerCase();
          typedAt = now;
          const labelOf = o.labelOf;
          const matches = (id: string) => labelOf(id).toLowerCase().startsWith(typed);
          // The same letter again walks on to the next row starting with it;
          // a longer prefix goes to the first row that has it.
          const cycling = typed.length > 1 && typed.split("").every((c) => c === typed[0]);
          const needle = cycling ? typed[0] : typed;
          const from = cycling ? at + 1 : 0;
          const found =
            ids.slice(from).find((id) => labelOf(id).toLowerCase().startsWith(needle)) ??
            (cycling ? ids.find((id) => labelOf(id).toLowerCase().startsWith(needle)) : ids.find(matches));
          if (found) setCursor(found);
        }
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [options.open]);

  // The row under the cursor stays in view in a scrolling menu.
  useEffect(() => {
    if (!options.open || !cursor || byPointer) return;
    document
      .querySelector<HTMLElement>(`[data-menu-id="${CSS.escape(cursor)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [options.open, cursor, byPointer]);

  return { cursor, lit: byPointer ? null : cursor, setCursor };
}

// For a menu whose rows are real links or buttons (the burger menu): the
// arrows move the focus between them, so Enter and Space are the row's own.
// Put on the element that holds both the trigger and the rows.
export function moveFocusInMenu(e: ReactKeyboardEvent<HTMLElement>, selector: string) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector));
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (e.key === "ArrowDown") next = (at + 1) % items.length;
  else if (e.key === "ArrowUp") next = at <= 0 ? items.length - 1 : at - 1;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = items.length - 1;
  else return;
  e.preventDefault();
  items[next].focus();
}

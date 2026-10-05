import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { isModalOpen } from "./modalKeys";

// Grid selection works like the desktop: a plain click opens the photo,
// Cmd/Ctrl-click (Ctrl on Windows and Linux) toggles it in the selection,
// Shift-click applies the toggle to the whole run since the last picked photo.
// There is no separate "select mode" to enter first - the selection simply
// exists as soon as one photo is picked, and the bulk bar follows it.

interface ModifierKeys {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

// True when a click on a tile means "select" rather than "open".
export function isSelectClick(e: ModifierKeys): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

// The platform's toggle-select key, for hints and tooltips.
export const modKeyLabel = isMac ? "⌘" : "Ctrl";

// A command shortcut the way the platform writes it, for tooltips: "⌘Z" and
// "⇧⌘Z" on a Mac, "Ctrl+Z" and "Ctrl+Shift+Z" everywhere else.
export function shortcutLabel(key: string, shift = false): string {
  return isMac ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
}

// A control that keeps the keyboard for itself: a text box, a dropdown. A
// checkbox or radio does not - clicking one leaves the focus on it, and the
// tiles' own checkboxes are how a selection is built (and, in the import
// review, how photos are ticked), so the grid's keys have to go on working
// from there. Counting them as text boxes left Escape and Cmd/Ctrl+A dead
// right after a click on one.
export function takesTyping(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && !/^(checkbox|radio)$/.test((el as HTMLInputElement).type);
}

// The colour labels that have a key, as in Lightroom: 6 red, 7 yellow, 8 green,
// 9 blue. The other labels are set from the swatches.
export const COLOR_KEYS = { "6": "red", "7": "yellow", "8": "green", "9": "blue" } as const;
export type KeyedColor = (typeof COLOR_KEYS)[keyof typeof COLOR_KEYS];

// Cmd/Ctrl+A selects everything in the grid and Escape clears the selection -
// the two keys every file browser answers to. Text boxes keep both keys for
// themselves (select the text, back out of the field). Escape is only claimed
// while something is selected, so a page can still use it to leave the view.
// E, with exactly one photo selected, opens that photo in the editor - the
// same key the lightbox answers to - and pages through the grid's order.
export function useSelectionKeys(opts: {
  onSelectAll: () => void;
  onClear?: () => void;
  hasSelection?: boolean;
  edit?: { selected: Set<string>; order: string[] };
  // Culling keys, on whatever is selected: 0-5 set the stars, 6-9 a colour
  // label (COLOR_KEYS), Delete / Backspace deletes.
  onRate?: (rating: number) => void;
  onColor?: (label: KeyedColor) => void;
  onDelete?: () => void;
}) {
  const navigate = useNavigate();
  // The pages pass fresh closures every render; reading them through a ref
  // keeps the single window listener from being torn down each time.
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && takesTyping(target)) return;
      // A dialog over the grid owns the keyboard.
      if (isModalOpen()) return;
      const { onSelectAll, onClear, hasSelection, edit, onRate, onColor, onDelete } = latest.current;
      // A key a focused control has already used (a dropdown opening on a
      // typed letter) is not also a culling key.
      const plain = !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.altKey;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
        // Also keeps Electron's Edit → Select All from highlighting page text.
        e.preventDefault();
        onSelectAll();
      } else if (e.key === "Escape" && onClear && hasSelection) {
        onClear();
      } else if (plain && hasSelection && onRate && e.key.length === 1 && e.key >= "0" && e.key <= "5") {
        e.preventDefault();
        onRate(Number(e.key));
      } else if (plain && hasSelection && onColor && e.key in COLOR_KEYS) {
        e.preventDefault();
        onColor(COLOR_KEYS[e.key as keyof typeof COLOR_KEYS]);
      } else if (plain && hasSelection && onDelete && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        onDelete();
      } else if (
        (e.key === "e" || e.key === "E") &&
        !e.metaKey && !e.ctrlKey && !e.altKey &&
        edit?.selected.size === 1
      ) {
        const [id] = edit.selected;
        e.preventDefault();
        navigate(`/image/${id}/edit`, { state: { imageIds: edit.order } });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);
}

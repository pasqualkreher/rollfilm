import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

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

// The platform's toggle-select key, for hints and tooltips.
export const modKeyLabel = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

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
}) {
  const navigate = useNavigate();
  // The pages pass fresh closures every render; reading them through a ref
  // keeps the single window listener from being torn down each time.
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const { onSelectAll, onClear, hasSelection, edit } = latest.current;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
        // Also keeps Electron's Edit → Select All from highlighting page text.
        e.preventDefault();
        onSelectAll();
      } else if (e.key === "Escape" && onClear && hasSelection) {
        onClear();
      } else if (
        (e.key === "e" || e.key === "E") &&
        !e.metaKey && !e.ctrlKey && !e.altKey &&
        edit?.selected.size === 1 &&
        target?.tagName !== "BUTTON"
      ) {
        const [id] = edit.selected;
        e.preventDefault();
        navigate(`/image/${id}`, { state: { imageIds: edit.order, edit: true } });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);
}

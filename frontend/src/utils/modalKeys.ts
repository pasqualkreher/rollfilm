import { useEffect, useRef } from "react";

// True while a dialog is on screen. The pages' window-level shortcuts (paging,
// rating, select all) ask this first: with a dialog up the keyboard belongs to
// the dialog, and a digit or an arrow must not reach the photo behind it.
export function isModalOpen(): boolean {
  return document.querySelector(".modal-overlay") !== null;
}

// The open dialogs, bottom to top. One captured listener serves them all and
// hands Escape to the topmost only - two dialogs each listening on their own
// would both close on one press (the prompt over the export dialog).
const stack: Array<{ current: () => void }> = [];

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || stack.length === 0) return;
  // An open dropdown inside the dialog takes this Escape for itself.
  if (document.querySelector(".dropdown-menu")) return;
  // Captured and stopped, so a lightbox or menu underneath with its own
  // Escape handler doesn't also close.
  e.stopPropagation();
  e.preventDefault();
  stack[stack.length - 1].current();
}

// Enter runs the dialog's default action, like the native ones - from
// anywhere in the dialog where the key is not already spoken for: a button
// (its own click, which an auto-focused default handles by itself), a text
// area (a new line), a link, a field that took the key for itself (it
// prevents the default). Only the topmost dialog answers, and never while a
// menu is open over it.
const enterStack: Array<{ current: () => void }> = [];

export function useEnterToConfirm(open: boolean, onConfirm: () => void) {
  const latest = useRef(onConfirm);
  latest.current = onConfirm;
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Enter" || e.defaultPrevented || e.isComposing) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (enterStack[enterStack.length - 1] !== latest) return;
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body) {
        const tag = t.tagName;
        if (tag === "BUTTON" || tag === "TEXTAREA" || tag === "A" || tag === "SELECT" || t.isContentEditable) return;
        const role = t.getAttribute("role");
        if (role === "option" || role === "menuitem" || role === "button") return;
      }
      if (document.querySelector(".dropdown-menu, .ctx-menu")) return;
      e.preventDefault();
      latest.current();
    }
    enterStack.push(latest);
    // Bubbling, not captured: a field's own Enter handler runs first and can
    // take the key (preventDefault) before this sees it.
    window.addEventListener("keydown", onKey);
    return () => {
      enterStack.splice(enterStack.indexOf(latest), 1);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
}

// Escape closes the dialog, like the native ones. `onClose` may decline (a
// dialog that is busy simply does nothing).
export function useEscapeToClose(open: boolean, onClose: () => void) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!open) return;
    stack.push(latest);
    if (stack.length === 1) window.addEventListener("keydown", onKey, true);
    return () => {
      stack.splice(stack.indexOf(latest), 1);
      if (stack.length === 0) window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
}

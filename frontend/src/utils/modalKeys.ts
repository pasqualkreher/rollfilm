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

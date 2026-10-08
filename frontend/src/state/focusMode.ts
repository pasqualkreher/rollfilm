// Focus mode: the app's top bar goes away and whatever is on screen takes
// the height it leaves - the library grid, an album, the photo editor, the
// canvas editor, all the same. One switch for the whole app, not a button
// per view: the desktop shell's View menu (Focus, Cmd/Ctrl+F) and the same
// keys in the web build toggle it, F does too where a view has no text to
// type into (the editors), and Esc steps out of it there.
//
// Only the bar goes: the editors keep their own tools, so you go on working
// with more of the picture in front of you. The canvas view's print mode is
// the one exception - there focus is a presentation, and its own chrome goes
// as well (CanvasEditor.tsx).
import { useEffect, useSyncExternalStore } from "react";

let on = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isFocusMode() {
  return on;
}

export function setFocusMode(next: boolean) {
  if (next === on) return;
  on = next;
  for (const l of listeners) l();
}

export function toggleFocusMode() {
  setFocusMode(!on);
}

export function useFocusMode() {
  return useSyncExternalStore(subscribe, isFocusMode);
}

// While focus mode is on, <html data-focus> hides the app's top bar and lets
// every full-window workspace start at the very top (index.css). Counted,
// so the global switch and the canvas print view's presentation (which also
// takes the bar) don't turn it back on when only one of them ends.
let active = 0;

export function useFocusChrome(wanted: boolean) {
  useEffect(() => {
    if (!wanted) return;
    active += 1;
    document.documentElement.setAttribute("data-focus", "");
    // With the bar gone the macOS traffic lights would float over the
    // picture: they go with it (a no-op off macOS and in the web build).
    window.photoManager?.setWindowButtonsVisible?.(false);
    return () => {
      active -= 1;
      if (active === 0) {
        document.documentElement.removeAttribute("data-focus");
        window.photoManager?.setWindowButtonsVisible?.(true);
      }
    };
  }, [wanted]);
}

// The app-wide switch, mounted once (App.tsx): applies the chrome, listens
// to the desktop shell's menu item and, where there is no native menu to
// take the keys (the web build, Windows, Linux), to Cmd/Ctrl+F itself.
// Esc is the editors' own business: each has a ladder of things to step
// out of (crop, selection, ...) and focus mode is one rung of it.
export function useFocusModeSwitch() {
  const focus = useFocusMode();
  useFocusChrome(focus);
  useEffect(() => {
    const offMenu = window.photoManager?.onToggleFocus?.(toggleFocusMode);
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        toggleFocusMode();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      offMenu?.();
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}

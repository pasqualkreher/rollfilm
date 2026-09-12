import { useEffect } from "react";
import { IconFocus } from "./Icons";

// Focus mode (F) - the app's top bar goes away and the workspace takes the
// height it leaves. Only that bar: the editors keep their own tools, so you
// can go on working with more of the picture in front of you. The canvas
// view is the one exception - there focus mode is a presentation, and its
// own chrome goes too. These are the pieces they share: the way in and out,
// and the app's top bar going.

// While any focus mode is on, <html data-focus> hides the app's top bar and
// lets every full-window workspace start at the very top (index.css). Counted,
// so two at once (the canvas editor's, then its print view's) don't turn the
// bar back on when only the inner one ends.
let active = 0;

export function useFocusChrome(on: boolean) {
  useEffect(() => {
    if (!on) return;
    active += 1;
    document.documentElement.setAttribute("data-focus", "");
    return () => {
      active -= 1;
      if (active === 0) document.documentElement.removeAttribute("data-focus");
    };
  }, [on]);
}

// The way in, for a toolbar - and, where the toolbar stays put in focus mode,
// the way back out as well: the same button, lit, toggling.
export function FocusButton({
  onClick,
  active,
  className,
}: {
  onClick: () => void;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`btn btn-sm focus-btn${active ? " active" : ""}${className ? ` ${className}` : ""}`}
      onClick={onClick}
      aria-pressed={active}
      title={active ? "Leave focus mode (F)" : "Focus mode: put the app's top bar away (F)"}
      aria-label={active ? "Leave focus mode" : "Focus mode"}
    >
      <IconFocus size={14} /> Focus
    </button>
  );
}

// The way back for the canvas view, where focus mode takes that view's own
// chrome as well: one quiet pill at the bottom of the picture, the only
// control left. F does the same from the keyboard. The parent must be
// positioned; the pill centres itself along its bottom edge.
export function FocusToggle({
  onToggle,
  className,
}: {
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`focus-toggle${className ? ` ${className}` : ""}`}
      onClick={onToggle}
      title="Leave focus mode (F)"
      aria-label="Leave focus mode"
    >
      <IconFocus size={13} /> Focus
    </button>
  );
}

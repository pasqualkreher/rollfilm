import { cloneElement, isValidElement, useRef, type ReactNode } from "react";
import { usePresence } from "../utils/usePresence";

// Exit animations for conditionally rendered surfaces. Wrap the usual
// `{open && <div className="menu">…</div>}` in <Presence open={open}> and the
// element stays on screen for `ms` after `open` goes false, carrying the
// `pm-closing` class (a DOM element) or a `closing` prop (a component, which
// puts pm-closing on its own root) so the CSS can run the reverse animation.
//
// While it is leaving, Presence renders the last frame it showed while open -
// not what the children would render now. That matters: a selection bar that
// is closing because the selection just emptied would otherwise say
// "0 selected" on its way out, and a menu whose anchor position was cleared on
// close would jump to the corner. Handlers on the frozen frame are stale, but
// the closing CSS also switches pointer events off, so nothing can press them.
//
// Reopening during the exit cancels it in place: same element, no remount.
export function Presence({
  open,
  ms,
  children,
}: {
  open: boolean;
  // Exit duration; must match the CSS (utils/usePresence.ts MOTION).
  ms: number;
  children: ReactNode;
}) {
  const { present, closing } = usePresence(open, ms);
  const last = useRef<ReactNode>(null);
  if (open) last.current = children;
  if (!present) return null;
  if (!closing) return <>{children}</>;

  const el = last.current;
  if (!isValidElement(el)) return <>{el}</>;
  const props = el.props as { className?: string };
  const patched =
    typeof el.type === "string"
      ? cloneElement(el, { className: [props.className, "pm-closing"].filter(Boolean).join(" ") } as object)
      : cloneElement(el, { closing: true } as object);
  return <>{patched}</>;
}

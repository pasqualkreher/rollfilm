import { useEffect, useSyncExternalStore } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

// Where the app is in its own history, for the global Back/Forward pair in
// the top bar. React Router's history keeps the entry's position in
// window.history.state.idx (it writes {usr, key, idx} on every push/replace),
// so the position survives a reload; what the entries ARE is only known for
// the ones this session has seen. The store keeps both: the position for the
// enabled/disabled state of the two buttons, the paths so a view can tell
// what the previous entry was (the editor uses it to leave cleanly - see
// leaveEditor in pages/ImageDetail.tsx).
//
// Forward is only known within the session: after a reload the position is
// still there but how far the stack reaches beyond it is not, so Forward
// starts out disabled and comes alive with the first Back.

interface NavHistoryState {
  idx: number;
  maxIdx: number;
  // Pathnames by position, for the entries seen in this session.
  paths: Record<number, string>;
}

function currentIdx(): number {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" ? idx : 0;
}

let state: NavHistoryState = { idx: currentIdx(), maxIdx: currentIdx(), paths: {} };
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function record(pathname: string, type: "PUSH" | "REPLACE" | "POP") {
  const idx = currentIdx();
  const paths = { ...state.paths, [idx]: pathname };
  let maxIdx = state.maxIdx;
  if (type === "PUSH") {
    // A push cuts off everything that was ahead - Forward has nowhere to go.
    for (const key of Object.keys(paths)) {
      if (Number(key) > idx) delete paths[Number(key)];
    }
    maxIdx = idx;
  } else if (idx > maxIdx) {
    maxIdx = idx;
  }
  state = { idx, maxIdx, paths };
  emit();
}

// Mounted once inside the router (App): feeds the store from every location
// change, including the first render.
export function NavHistoryTracker() {
  const location = useLocation();
  const type = useNavigationType();
  useEffect(() => {
    record(location.pathname, type);
  }, [location, type]);
  return null;
}

export function useNavHistory() {
  const s = useSyncExternalStore(subscribe, () => state);
  return {
    canGoBack: s.idx > 0,
    canGoForward: s.idx < s.maxIdx,
    // undefined when the previous entry was made before this session (a reload).
    previousPath: s.paths[s.idx - 1] as string | undefined,
  };
}

// ---- Leave guards ----------------------------------------------------------
// Work that must finish before Back/Forward moves the app: the photo editor
// registers its save here, so leaving it through the top bar (or the
// shortcuts) writes the edits with the wait popup up, the same as its own
// View button - instead of leaving them to the silent unmount autosave.

type LeaveGuard = () => Promise<void>;
const guards = new Set<LeaveGuard>();

export function useLeaveGuard(guard: LeaveGuard | null) {
  useEffect(() => {
    if (!guard) return;
    guards.add(guard);
    return () => {
      guards.delete(guard);
    };
  }, [guard]);
}

export async function runLeaveGuards(): Promise<void> {
  // Snapshot: a guard may unregister itself while it runs.
  for (const guard of [...guards]) {
    try {
      await guard();
    } catch {
      // A failed save must not trap the user in the view - the unmount
      // fallback gets another try, and the row keeps its last saved state.
    }
  }
}

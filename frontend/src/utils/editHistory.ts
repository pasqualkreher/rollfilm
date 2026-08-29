import { useCallback, useEffect, useRef, useState } from "react";

// Undo/redo for the develop panel.
//
// The editor keeps its edit state in a dozen separate useStates, so this works
// on SNAPSHOTS of the whole edit rather than on a log of operations: every
// entry is one complete ImageEdits value, and undo just puts an older one back.
// That way a new control can be added to the editor without also having to
// teach the history how to reverse it.
//
// Entries are coalesced: a slider drag fires a change per pixel of travel, and
// stepping back through those one at a time is not undo, it is rewinding. A
// snapshot is only committed once the edits have been still for COALESCE_MS, so
// one drag, one brush stroke or one wheel spin lands as a single step.
const COALESCE_MS = 400;
// Snapshots hold whole mask/curve trees, so the stack is capped rather than
// left to grow for as long as the editor is open. ~100 steps is far past what
// anyone walks back through by hand.
const LIMIT = 100;

export interface EditHistory {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

/**
 * `current`/`key` are the live edit state and a cheap identity for it (the
 * editor already stringifies its edits once per change - pass that). `apply`
 * puts a snapshot back into the editor's state. History starts over whenever
 * `resetKey` changes, i.e. when the editor is pointed at another photo.
 */
export function useEditHistory<T>(
  current: T,
  key: string,
  apply: (value: T) => void,
  resetKey: string | number
): EditHistory {
  const stack = useRef<{ key: string; value: T }[]>([{ key, value: current }]);
  const index = useRef(0);
  // The key we just restored: the recording effect sees that change like any
  // other and has to know not to record it as a fresh edit.
  const restored = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Refs so the callbacks below never go stale without having to be rebuilt on
  // every keystroke of an edit.
  const latest = useRef({ key, value: current });
  latest.current = { key, value: current };
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const [, bump] = useState(0);

  // Commit whatever is on screen right now, dropping any redo branch. Called on
  // the coalesce timer, and again before an undo so the change you just made is
  // always the one that comes off first - even if it is still within the
  // coalescing window.
  const commit = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const now = latest.current;
    if (stack.current[index.current]?.key === now.key) return;
    const kept = stack.current.slice(0, index.current + 1);
    kept.push({ key: now.key, value: now.value });
    stack.current = kept.length > LIMIT ? kept.slice(kept.length - LIMIT) : kept;
    index.current = stack.current.length - 1;
    bump((n) => n + 1);
  }, []);

  useEffect(() => {
    if (restored.current === key) {
      restored.current = null;
      return;
    }
    if (stack.current[index.current]?.key === key) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(commit, COALESCE_MS);
  }, [key, commit]);

  // Another photo: the old stack describes edits that are not on screen any
  // more, so applying one of them would paste them onto this photo.
  useEffect(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    stack.current = [latest.current];
    index.current = 0;
    restored.current = null;
    bump((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const step = useCallback(
    (dir: -1 | 1) => {
      commit();
      const next = index.current + dir;
      if (next < 0 || next >= stack.current.length) return;
      index.current = next;
      const entry = stack.current[next];
      restored.current = entry.key;
      applyRef.current(entry.value);
      bump((n) => n + 1);
    },
    [commit]
  );

  const undo = useCallback(() => step(-1), [step]);
  const redo = useCallback(() => step(1), [step]);

  return {
    // An uncommitted change (still inside the coalescing window) is undoable
    // too - commit() folds it into the stack first.
    canUndo: index.current > 0 || stack.current[index.current]?.key !== key,
    canRedo: index.current < stack.current.length - 1,
    undo,
    redo,
  };
}

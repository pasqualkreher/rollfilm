import { useCallback, useEffect, useRef, useState } from "react";

// Status state that clears itself after a moment - the app-wide behavior for
// the "Saved." / result notes a button press flashes next to itself.
// Drop-in for useState<T | null>: setting a value arms the timer, setting
// null (e.g. when a new action starts) cancels it.
//
// An error is set with { keep: true } and arms no timer: it stays until the
// next action replaces or clears it. A failure that took itself away after
// four seconds was gone before anyone looking elsewhere had read it.
export type TransientSetter<T> = (value: T | null, opts?: { keep?: boolean }) => void;

export function useTransientValue<T>(ms = 4000): [T | null, TransientSetter<T>] {
  const [value, setValueState] = useState<T | null>(null);
  const timer = useRef<number | null>(null);

  const cancel = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const setValue = useCallback<TransientSetter<T>>(
    (next, opts) => {
      cancel();
      setValueState(next);
      if (next !== null && !opts?.keep) {
        timer.current = window.setTimeout(() => setValueState(null), ms);
      }
    },
    [ms]
  );

  useEffect(() => cancel, []);
  return [value, setValue];
}

export function useTransientMessage(ms = 4000) {
  return useTransientValue<string>(ms);
}

// Same idea for boolean "Saved." indicators: switching one on arms the timer
// that switches it back off.
export function useTransientFlag(ms = 4000): [boolean, (on: boolean) => void] {
  const [value, setValue] = useTransientValue<true>(ms);
  const setFlag = useCallback((on: boolean) => setValue(on ? true : null), [setValue]);
  return [value === true, setFlag];
}

import { useCallback, useEffect, useRef, useState } from "react";

// Status state that clears itself after a moment - the app-wide behavior for
// the "Saved." / result / error notes a button press flashes next to itself.
// Drop-in for useState<T | null>: setting a value arms the timer, setting
// null (e.g. when a new action starts) cancels it.
export function useTransientValue<T>(
  ms = 4000
): [T | null, (value: T | null) => void] {
  const [value, setValueState] = useState<T | null>(null);
  const timer = useRef<number | null>(null);

  const cancel = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const setValue = useCallback(
    (next: T | null) => {
      cancel();
      setValueState(next);
      if (next !== null) {
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

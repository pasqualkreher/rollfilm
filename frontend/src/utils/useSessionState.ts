import { useCallback, useState } from "react";

// useState that outlives the component for the length of the session. A page
// that unmounts when a photo is opened (an album's grid -> the photo view)
// lost everything held in plain useState, so coming back dropped the filters
// the user had just set. Values are kept per key in memory - gone on quit.
const store = new Map<string, unknown>();

export function useSessionState<T>(key: string, initial: T): [T, (value: T) => void] {
  const read = () => (store.has(key) ? (store.get(key) as T) : initial);
  const [value, setValue] = useState<T>(read);
  // The same mounted page moving on to another key (album A -> album B):
  // pick up that key's value instead of carrying this one across.
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    setSeenKey(key);
    setValue(read());
  }
  const set = useCallback(
    (next: T) => {
      store.set(key, next);
      setValue(next);
    },
    [key]
  );
  return [value, set];
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const STORAGE_KEY = "photo-manager.selects";

interface SelectsState {
  ids: string[];
  count: number;
  has: (id: string) => boolean;
  add: (ids: string | string[]) => void;
  remove: (id: string) => void;
  toggle: (id: string) => void;
  clear: () => void;
}

const SelectsContext = createContext<SelectsState | null>(null);

function load(): string[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * "Selects" - a working set of image ids the user is gathering to act on (edit,
 * export, etc). Kept in sessionStorage (not localStorage) so a half-built set
 * survives a page reload but is cleared when the app closes - and, since
 * switching library folders relaunches the app, it never carries stale ids from
 * a previous library into a new one. Lifted above <Routes> so it stays put
 * while navigating between Library, albums, and image detail.
 */
export function SelectsProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<string[]>(load);

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  }, [ids]);

  const add = useCallback((incoming: string | string[]) => {
    const list = Array.isArray(incoming) ? incoming : [incoming];
    setIds((prev) => {
      const seen = new Set(prev);
      const next = [...prev];
      for (const id of list) {
        if (!seen.has(id)) {
          seen.add(id);
          next.push(id);
        }
      }
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setIds((prev) => prev.filter((x) => x !== id));
  }, []);

  const toggle = useCallback((id: string) => {
    setIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const clear = useCallback(() => setIds([]), []);

  const value = useMemo<SelectsState>(
    () => ({ ids, count: ids.length, has: (id) => ids.includes(id), add, remove, toggle, clear }),
    [ids, add, remove, toggle, clear]
  );

  return <SelectsContext.Provider value={value}>{children}</SelectsContext.Provider>;
}

export function useSelects(): SelectsState {
  const ctx = useContext(SelectsContext);
  if (!ctx) throw new Error("useSelects must be used within SelectsProvider");
  return ctx;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";

// Where the tray lived before it was stored with the library: read once more
// to carry a running session's tray over, then removed.
const LEGACY_STORAGE_KEY = "photo-manager.selects";
// How long until another try when the stored tray could not be fetched.
const RELOAD_MS = 2000;

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

function takeLegacy(): string[] {
  try {
    const raw = sessionStorage.getItem(LEGACY_STORAGE_KEY);
    sessionStorage.removeItem(LEGACY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * "Selects" - a working set of image ids the user is gathering to act on (edit,
 * export, etc). Stored with the library (the backend's /selects, in the
 * library's own database), so the tray is still there after the app was
 * closed, goes into the backup, and belongs to that library: another library
 * folder has its own, and ids can never leak from one into the other. Lifted
 * above <Routes> so it stays put while navigating between Library, albums,
 * and image detail.
 */
export function SelectsProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<string[]>([]);
  // Nothing is written back before the stored tray has arrived - a change
  // made in that first moment would otherwise replace it with itself alone.
  const [loaded, setLoaded] = useState(false);
  // The list the server holds, as last sent or received (null: unknown, the
  // next change sends again).
  const stored = useRef<string | null>(null);
  // Saves go out one after the other, so a late answer can't put an older
  // list over a newer one.
  const saving = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;
    function load() {
      api.selects
        .get()
        .then(({ ids: fromLibrary }) => {
          if (stopped) return;
          stored.current = JSON.stringify(fromLibrary);
          // Whatever was added before the answer came joins the stored tray.
          const legacy = takeLegacy();
          setIds((prev) => Array.from(new Set([...fromLibrary, ...legacy, ...prev])));
          setLoaded(true);
        })
        .catch(() => {
          // The backend not answering yet is no reason to give the tray up.
          if (!stopped) timer = window.setTimeout(load, RELOAD_MS);
        });
    }
    load();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const sent = JSON.stringify(ids);
    if (sent === stored.current) return;
    stored.current = sent;
    const run = saving.current.then(() => api.selects.set(ids));
    saving.current = run.then(
      () => undefined,
      () => {
        // Not stored: the next change sends the whole list again.
        stored.current = null;
      }
    );
    // The server drops photos that are gone for good or in the Trash; take
    // its list over unless the tray has changed again in the meantime. A
    // failed save is left unhandled on purpose - it surfaces as the app's
    // "That didn't work" notice (components/UnhandledErrors).
    void run.then((kept) => {
      const answer = JSON.stringify(kept.ids);
      if (answer === sent) return;
      setIds((current) => {
        if (JSON.stringify(current) !== sent) return current;
        stored.current = answer;
        return kept.ids;
      });
    });
  }, [ids, loaded]);

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

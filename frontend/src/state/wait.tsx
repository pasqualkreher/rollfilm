import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// A full-screen "please wait" popup for actions the user must sit out - saving
// edits, bulk resets, deletes and the like. withWait() blocks every click and
// key press app-wide while the wrapped promise runs and shows a spinner with a
// label. The overlay mounts immediately (input is blocked from the first
// moment) but only fades in after a short delay, so operations that finish
// quickly never flash a popup.
//
// Usage: const { withWait } = useWait();
//        await withWait("Saving…", () => api.images.saveEdits(id, edits));
interface WaitApi {
  withWait: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
}

const WaitContext = createContext<WaitApi | null>(null);

export function useWait(): WaitApi {
  const ctx = useContext(WaitContext);
  if (!ctx) throw new Error("useWait must be used within WaitProvider");
  return ctx;
}

export function WaitProvider({ children }: { children: ReactNode }) {
  // Overlapping waits (a second action fired from an effect, nested wraps)
  // stack here - the overlay stays up until the last one resolves and always
  // shows the most recent label.
  const [entries, setEntries] = useState<{ id: number; label: string }[]>([]);
  const nextId = useRef(0);

  const withWait = useCallback(async function run<T>(
    label: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const id = nextId.current++;
    setEntries((prev) => [...prev, { id, label }]);
    try {
      return await fn();
    } finally {
      setEntries((prev) => prev.filter((e) => e.id !== id));
    }
  }, []);

  const active = entries.length > 0;
  const label = active ? entries[entries.length - 1].label : null;

  // Swallow every key press while blocked (captured, so shortcuts and Escape
  // handlers underneath never fire) - the overlay div already eats all clicks.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);

  return (
    <WaitContext.Provider value={{ withWait }}>
      {children}
      {active && (
        <div className="wait-overlay" role="alertdialog" aria-modal="true" aria-busy="true" aria-label={label ?? "Working"}>
          <div className="wait-overlay-box" role="status" aria-live="polite">
            <span className="wait-overlay-spinner" aria-hidden="true" />
            <span>{label}</span>
          </div>
        </div>
      )}
    </WaitContext.Provider>
  );
}

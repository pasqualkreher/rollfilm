import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Presence } from "../components/Presence";
import { Spinner } from "../components/Spinner";

// A full-screen "please wait" popup for actions the user must sit out - saving
// edits, bulk resets, deletes and the like. withWait() blocks every click and
// key press app-wide while the wrapped promise runs and shows a spinner with a
// label. The overlay mounts immediately (input is blocked from the first
// moment) but only fades in after a short delay, so operations that finish
// quickly never flash a popup.
//
// Usage: const { withWait } = useWait();
//        await withWait("Saving…", () => api.images.saveEdits(id, edits));
//
// Bulk actions over many photos use withBatches() instead: the same popup,
// plus "x of X" and a Cancel button. The work is sent in slices, one request
// after the other; Cancel lets the slice in flight finish and sends no more -
// everything done up to then stays done.
//        const { done, cancelled } = await withBatches("Tagging photos…", ids,
//          (slice) => api.images.bulkAddTags(slice, [tag]));
export interface BatchOutcome<R> {
  // The ids whose slice went through (all of them unless cancelled).
  done: string[];
  // One entry per slice, in order.
  results: R[];
  cancelled: boolean;
}

// An entry of several ids is one unit - a RAW+JPEG pair - that is counted as
// one photo and never split across two slices.
export type BatchItem = string | string[];

interface WaitApi {
  withWait: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  withBatches: <R>(
    label: string,
    items: BatchItem[],
    run: (ids: string[]) => Promise<R>
  ) => Promise<BatchOutcome<R>>;
}

interface WaitEntry {
  id: number;
  label: string;
  progress?: { done: number; total: number };
  // Present on cancellable waits; `cancelling` once it has been pressed.
  cancel?: () => void;
  cancelling?: boolean;
}

// A slice should take about this long: short enough that the count moves and
// Cancel answers promptly, long enough that a big selection is not thousands
// of round-trips. The slice size follows the measured time per photo, since a
// rating costs microseconds and an auto-develop most of a second.
const BATCH_TARGET_MS = 400;
const BATCH_FIRST = 5;
const BATCH_MAX = 200;

const WaitContext = createContext<WaitApi | null>(null);

export function useWait(): WaitApi {
  const ctx = useContext(WaitContext);
  if (!ctx) throw new Error("useWait must be used within WaitProvider");
  return ctx;
}

// The popup itself. It mounts at opacity 0 and gets .is-shown a frame later,
// which starts the delayed fade-in (index.css .wait-overlay); Presence adds
// .pm-closing for the fade-out, which starts from wherever the fade-in got
// to - so a wait that is over before the delay never shows at all.
function WaitOverlay({ entry, closing = false }: { entry: WaitEntry; closing?: boolean }) {
  const { label, progress, cancel, cancelling } = entry;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div
      className={`wait-overlay${shown ? " is-shown" : ""}${closing ? " pm-closing" : ""}`}
      role="alertdialog"
      aria-modal="true"
      aria-busy="true"
      aria-label={label}
    >
      <div className="wait-overlay-box" role="status" aria-live="polite">
        <Spinner size="lg" />
        <span>
          {label}
          {progress && (
            <span className="wait-overlay-progress">
              {/* As wide as the total from the start, so the box does not
                  grow as the count gains digits. */}
              <span
                className="wait-overlay-count"
                style={{ minWidth: `${progress.total.toLocaleString().length}ch` }}
              >
                {progress.done.toLocaleString()}
              </span>{" "}
              of {progress.total.toLocaleString()}
            </span>
          )}
        </span>
        {cancel && (
          <button
            type="button"
            className="btn btn-sm wait-overlay-cancel"
            onClick={cancel}
            disabled={cancelling}
            title="Stop here. Everything done so far is kept."
          >
            {cancelling ? "Stopping…" : "Cancel"}
          </button>
        )}
      </div>
    </div>
  );
}

export function WaitProvider({ children }: { children: ReactNode }) {
  // Overlapping waits (a second action fired from an effect, nested wraps)
  // stack here - the overlay stays up until the last one resolves and always
  // shows the most recent label.
  const [entries, setEntries] = useState<WaitEntry[]>([]);
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

  const withBatches = useCallback(async function run<R>(
    label: string,
    items: BatchItem[],
    fn: (ids: string[]) => Promise<R>
  ): Promise<BatchOutcome<R>> {
    const id = nextId.current++;
    const units = items.map((item) => (Array.isArray(item) ? item : [item]));
    let cancelled = false;
    const patch = (change: Partial<WaitEntry>) =>
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...change } : e)));
    const cancel = () => {
      cancelled = true;
      patch({ cancelling: true });
    };
    setEntries((prev) => [
      ...prev,
      // One slice's worth of photos gets no count and no Cancel: there is
      // nothing in between to stop at.
      units.length > BATCH_FIRST
        ? { id, label, progress: { done: 0, total: units.length }, cancel }
        : { id, label },
    ]);
    const done: string[] = [];
    const results: R[] = [];
    try {
      let at = 0;
      let size = BATCH_FIRST;
      while (at < units.length && !cancelled) {
        const slice = units.slice(at, at + size);
        const ids = slice.flat();
        const started = performance.now();
        results.push(await fn(ids));
        const perUnit = (performance.now() - started) / slice.length;
        done.push(...ids);
        at += slice.length;
        if (units.length > BATCH_FIRST) patch({ progress: { done: at, total: units.length } });
        size = Math.max(1, Math.min(BATCH_MAX, Math.round(BATCH_TARGET_MS / Math.max(perUnit, 0.01))));
      }
      return { done, results, cancelled: cancelled && at < units.length };
    } finally {
      setEntries((prev) => prev.filter((e) => e.id !== id));
    }
  }, []);

  const active = entries.length > 0;
  const top = active ? entries[entries.length - 1] : null;
  const cancelTop = top?.cancel;

  // Swallow every key press while blocked (captured, so shortcuts and Escape
  // handlers underneath never fire) - the overlay div already eats all clicks.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      e.preventDefault();
      // The one key that means something here: Escape is the Cancel button.
      if (e.key === "Escape") cancelTop?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, cancelTop]);

  return (
    <WaitContext.Provider value={{ withWait, withBatches }}>
      {children}
      <Presence open={active} ms={150}>
        {top && <WaitOverlay entry={top} />}
      </Presence>
    </WaitContext.Provider>
  );
}

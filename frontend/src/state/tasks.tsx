import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { nudgeWaitingThumbs } from "../utils/thumbNudge";

// A tiny global "a blocking task is running" flag. Long-running maintenance
// actions in Settings (sync / rebuild thumbnails / wipe / restore) set a label
// here; while it's non-null the top-nav is locked (you can't switch tabs and
// unmount the page mid-task) and a spinner is shown.
//
// Beside it, and blocking nothing: the pictures of a bulk edit (preset, auto
// develop, reset). The edit itself returns as soon as the rows are written and
// the backend re-renders in the background; `trackRenders` follows those
// renders, so the title bar can say how far they are until the last one is
// through. `cancelRenders` stops them there: a bulk edit is only as far as its
// pictures are, so the photos not rendered yet go back to how they were.
interface TasksState {
  busyLabel: string | null;
  setBusyLabel: (label: string | null) => void;
  renders: RenderProgress | null;
  trackRenders: (imageIds: string[]) => void;
  cancelRenders: () => Promise<void>;
  cancellingRenders: boolean;
}

export interface RenderProgress {
  done: number;
  total: number;
}

const RENDER_POLL_MS = 600;

const TasksContext = createContext<TasksState | null>(null);

export function TasksProvider({ children }: { children: ReactNode }) {
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [renders, setRenders] = useState<RenderProgress | null>(null);
  const [cancellingRenders, setCancellingRenders] = useState(false);
  const queryClient = useQueryClient();
  // Every photo being followed since the queue was last empty: a second bulk
  // edit while the first still renders adds to the same count.
  const trackedRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<number | null>(null);
  // The count shown is of renders, not of photos followed: a bulk edit only
  // queues the photos whose look it changed. So the total is what was through
  // before plus what is waiting, taken again whenever photos were added.
  const countRef = useRef({ total: 0, left: 0, added: false });

  const poll = useCallback(async () => {
    timerRef.current = null;
    const ids = Array.from(trackedRef.current);
    let pending = 0;
    try {
      pending = (await api.images.renderStatus(ids)).pending;
    } catch {
      // The backend is gone or restarting: there is nothing left to follow.
    }
    const count = countRef.current;
    // Photos added while the request was out have not been asked about yet.
    const unasked = trackedRef.current.size > ids.length;
    if (pending <= 0 && !unasked) {
      trackedRef.current = new Set();
      countRef.current = { total: 0, left: 0, added: false };
      setRenders(null);
      // Tiles sitting out a retry backoff ask again now instead of when their
      // timer runs out - the picture they wait for is there.
      nudgeWaitingThumbs();
      return;
    }
    if (count.added) {
      count.total = count.total - count.left + pending;
      count.added = unasked;
    }
    count.left = pending;
    if (pending > 0) setRenders({ done: count.total - pending, total: count.total });
    timerRef.current = window.setTimeout(poll, unasked ? 0 : RENDER_POLL_MS);
  }, []);

  const trackRenders = useCallback(
    (imageIds: string[]) => {
      if (imageIds.length === 0) return;
      for (const id of imageIds) trackedRef.current.add(id);
      countRef.current.added = true;
      if (timerRef.current === null) timerRef.current = window.setTimeout(poll, 0);
    },
    [poll]
  );

  const cancelRenders = useCallback(async () => {
    const ids = Array.from(trackedRef.current);
    if (ids.length === 0) return;
    setCancellingRenders(true);
    try {
      await api.images.cancelRenders(ids);
      // What is left are the few a worker already had in hand: count again.
      countRef.current.added = true;
      // The photos taken back out hold their earlier edit again.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["images"] }),
        queryClient.invalidateQueries({ queryKey: ["tags"] }),
        queryClient.invalidateQueries({ queryKey: ["albums"] }),
      ]);
    } catch {
      // The backend is gone or restarting: the poll notices and clears the count.
    } finally {
      setCancellingRenders(false);
    }
  }, [queryClient]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  return (
    <TasksContext.Provider
      value={{ busyLabel, setBusyLabel, renders, trackRenders, cancelRenders, cancellingRenders }}
    >
      {children}
    </TasksContext.Provider>
  );
}

export function useTasks(): TasksState {
  const ctx = useContext(TasksContext);
  if (!ctx) throw new Error("useTasks must be used within TasksProvider");
  return ctx;
}

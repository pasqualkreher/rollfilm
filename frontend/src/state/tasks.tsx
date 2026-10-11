import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ExportJobProgress } from "../api/types";
import { nudgeWaitingThumbs } from "../utils/thumbNudge";

// Everything that is running, in one list, for the one place that shows it:
// the task dock in the title bar (App.tsx, TaskDock). A task is a label, an
// optional count and - where the work can be stopped between two steps - a
// way to stop it. Nothing here blocks the app: the pages stay usable while a
// task runs, and the dock is where the user sees it and ends it.
//
// Four ways in:
//   runTask(spec, fn)        - one promise, tracked until it settles
//   runBatches(spec, …)      - a bulk action sent in slices, with a count and a
//                              Stop that lets the slice in flight finish
//   trackPolledJob(spec)     - a job the backend runs on its own, followed by
//                              polling until it reports itself done
//   useExternalTask(task)    - a task whose state lives elsewhere (an import
//                              session, the Immich sync) and is mirrored here
// plus trackRenders / trackCopyJob for the two jobs the bulk edits start.
//
// A task with a fixed id cannot start twice: startTask returns null while one
// with the same id runs, and runTask / runBatches throw TaskBusyError. The
// pages disable their buttons on hasTask(id), so this is the safety net.

export type TaskKind =
  | "batch"
  | "renders"
  | "copies"
  | "export"
  | "copy"
  | "editor-save"
  | "import"
  | "maintenance"
  | "sidecar"
  | "immich"
  | "merge"
  | "scan"
  | "plain";

// What a task leaves in the dock for a moment once it is through: a word and,
// where there is something to open, a link ("Show in Finder").
export interface TaskFinish {
  label: string;
  action?: { label: string; run: () => void };
  error?: boolean;
}

export interface Task {
  id: string;
  kind: TaskKind;
  label: string;
  done?: number;
  total?: number;
  // null: no Stop button. The dock marks the task `cancelling` while the
  // promise runs; a task that keeps going after that (a backend job that
  // stops between photos) is taken down by its own tracker.
  cancel: (() => void | Promise<unknown>) | null;
  // The Stop button's word and hover text; "Stop" when left out.
  cancelLabel?: string;
  stopTitle?: string;
  cancelling: boolean;
  // The nav is locked while a task with this runs (the editor's final save:
  // switching pages would unmount the editor mid-write).
  locksNav?: boolean;
  // Hover text on the label.
  title?: string;
  finished?: TaskFinish;
  startedAt: number;
}

export type TaskSpec = Pick<Task, "kind" | "label"> &
  Partial<Pick<Task, "id" | "done" | "total" | "cancel" | "cancelLabel" | "stopTitle" | "locksNav" | "title">>;

type TaskPatch = Partial<Pick<Task, "label" | "done" | "total" | "cancel" | "cancelLabel" | "stopTitle" | "title" | "cancelling">>;

export interface TaskHandle {
  id: string;
  update: (patch: TaskPatch) => void;
  // With a result the task stays in the dock as a chip for a moment; without
  // one it is gone at once.
  finish: (result?: TaskFinish) => void;
}

export class TaskBusyError extends Error {
  constructor(label: string) {
    super(`Wait for "${label}" to finish.`);
    this.name = "TaskBusyError";
  }
}

export interface BatchOutcome<R> {
  // The ids whose slice went through (all of them unless stopped).
  done: string[];
  // One entry per slice, in order.
  results: R[];
  cancelled: boolean;
}

// An entry of several ids is one unit - a RAW+JPEG pair - that is counted as
// one photo and never split across two slices.
export type BatchItem = string | string[];

export interface ExportJobOpts {
  jobId: string;
  total: number;
  // Once the server reports the job ready: write the download, or say where
  // the files went. What it returns stays in the dock as a chip for a moment.
  onReady: (p: ExportJobProgress) => Promise<TaskFinish | undefined> | TaskFinish | undefined;
}

export interface PolledJobSpec extends TaskSpec {
  poll: () => Promise<{ active: boolean; done?: number; total?: number }>;
  intervalMs?: number;
}

interface TasksState {
  tasks: Task[];
  hasTask: (id: string) => boolean;
  startTask: (spec: TaskSpec) => TaskHandle | null;
  runTask: <T>(spec: TaskSpec & { progress?: () => Promise<{ done: number; total: number }> }, fn: () => Promise<T>) => Promise<T>;
  runBatches: <R>(spec: TaskSpec, items: BatchItem[], run: (ids: string[]) => Promise<R>) => Promise<BatchOutcome<R>>;
  trackPolledJob: (spec: PolledJobSpec) => TaskHandle | null;
  cancelTask: (id: string) => Promise<void>;
  dismissTask: (id: string) => void;
  upsertTask: (task: Omit<Task, "cancelling" | "startedAt"> & Partial<Pick<Task, "cancelling">>) => void;
  removeTask: (id: string) => void;
  trackRenders: (imageIds: string[]) => void;
  cancelRenders: () => Promise<void>;
  trackCopyJob: (jobId: string, total: number) => void;
  trackExportJob: (opts: ExportJobOpts) => void;
}

const RENDER_POLL_MS = 600;
const EXPORT_POLL_MS = 400;
const POLL_MS = 1000;
// How long a finished task's chip stays.
const FINISH_MS = 10000;

// A slice should take about this long: short enough that the count moves and
// Stop answers promptly, long enough that a big selection is not thousands of
// round-trips. The slice size follows the measured time per photo, since a
// rating costs microseconds and an auto-develop most of a second.
const BATCH_TARGET_MS = 400;
const BATCH_FIRST = 5;
const BATCH_MAX = 200;

const TasksContext = createContext<TasksState | null>(null);

export const RENDERS_TASK_ID = "renders";

export function TasksProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // The list lives in a ref (the trackers below mutate it from timers and
  // promise callbacks) and is copied into state for rendering.
  const tasksRef = useRef<Task[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const seqRef = useRef(0);
  const finishTimers = useRef(new Map<string, number>());
  const publish = useCallback(() => setTasks([...tasksRef.current]), []);

  const find = useCallback((id: string) => tasksRef.current.find((t) => t.id === id), []);

  const removeTask = useCallback(
    (id: string) => {
      const timer = finishTimers.current.get(id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        finishTimers.current.delete(id);
      }
      if (!find(id)) return;
      tasksRef.current = tasksRef.current.filter((t) => t.id !== id);
      publish();
    },
    [find, publish]
  );

  const patchTask = useCallback(
    (id: string, patch: TaskPatch | Partial<Task>) => {
      const t = find(id);
      if (!t) return;
      Object.assign(t, patch);
      publish();
    },
    [find, publish]
  );

  const startTask = useCallback(
    (spec: TaskSpec): TaskHandle | null => {
      const id = spec.id ?? `${spec.kind}:${++seqRef.current}`;
      const running = find(id);
      if (running && !running.finished) return null;
      if (running) removeTask(id);
      const task: Task = {
        ...spec,
        id,
        cancel: spec.cancel ?? null,
        cancelling: false,
        startedAt: Date.now(),
      };
      tasksRef.current = [...tasksRef.current, task];
      publish();
      return {
        id,
        update: (patch) => patchTask(id, patch),
        finish: (result) => {
          if (!result) {
            removeTask(id);
            return;
          }
          patchTask(id, { finished: result, cancel: null, cancelling: false, done: undefined, total: undefined });
          finishTimers.current.set(
            id,
            window.setTimeout(() => removeTask(id), FINISH_MS)
          );
        },
      };
    },
    [find, patchTask, publish, removeTask]
  );

  const runTask = useCallback(
    async function run<T>(
      spec: TaskSpec & { progress?: () => Promise<{ done: number; total: number }> },
      fn: () => Promise<T>
    ): Promise<T> {
      const handle = startTask(spec);
      if (!handle) throw new TaskBusyError(find(spec.id!)?.label ?? spec.label);
      let timer: number | null = null;
      if (spec.progress) {
        const progress = spec.progress;
        const tick = async () => {
          timer = null;
          try {
            const p = await progress();
            handle.update({ done: p.done, total: p.total });
          } catch {
            // The backend is gone or restarting: the promise below settles.
          }
          if (find(handle.id)) timer = window.setTimeout(tick, POLL_MS);
        };
        timer = window.setTimeout(tick, POLL_MS);
      }
      try {
        return await fn();
      } finally {
        if (timer !== null) window.clearTimeout(timer);
        // Stop the poll's next tick, if one was scheduled meanwhile.
        handle.finish();
      }
    },
    [find, startTask]
  );

  const runBatches = useCallback(
    async function run<R>(
      spec: TaskSpec,
      items: BatchItem[],
      fn: (ids: string[]) => Promise<R>
    ): Promise<BatchOutcome<R>> {
      const units = items.map((item) => (Array.isArray(item) ? item : [item]));
      let cancelled = false;
      // One slice's worth of photos gets no count and no Stop: there is
      // nothing in between to stop at.
      const counted = units.length > BATCH_FIRST;
      const handle = startTask({
        ...spec,
        done: counted ? 0 : undefined,
        total: counted ? units.length : undefined,
        cancel: counted
          ? () => {
              cancelled = true;
            }
          : null,
        stopTitle: spec.stopTitle ?? "Stop here. Everything done so far is kept.",
      });
      if (!handle) throw new TaskBusyError(find(spec.id!)?.label ?? spec.label);
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
          if (counted) handle.update({ done: at, total: units.length });
          size = Math.max(1, Math.min(BATCH_MAX, Math.round(BATCH_TARGET_MS / Math.max(perUnit, 0.01))));
        }
        return { done, results, cancelled: cancelled && at < units.length };
      } finally {
        handle.finish();
      }
    },
    [find, startTask]
  );

  const trackPolledJob = useCallback(
    (spec: PolledJobSpec): TaskHandle | null => {
      const { poll, intervalMs = POLL_MS, ...rest } = spec;
      const handle = startTask(rest);
      if (!handle) return null;
      const tick = async () => {
        if (!find(handle.id)) return;
        let active = true;
        try {
          const p = await poll();
          active = p.active;
          if (p.done !== undefined) handle.update({ done: p.done, total: p.total });
        } catch {
          // The backend is gone or restarting: there is nothing left to follow.
          active = false;
        }
        if (!active) {
          handle.finish();
          return;
        }
        window.setTimeout(tick, intervalMs);
      };
      void tick();
      return handle;
    },
    [find, startTask]
  );

  const cancelTask = useCallback(
    async (id: string) => {
      const t = find(id);
      if (!t || !t.cancel || t.cancelling) return;
      patchTask(id, { cancelling: true });
      try {
        await t.cancel();
      } catch {
        // The tracker notices a backend that is gone and takes the task down.
      }
    },
    [find, patchTask]
  );

  const dismissTask = useCallback(
    (id: string) => {
      if (find(id)?.finished) removeTask(id);
    },
    [find, removeTask]
  );

  // A task mirrored from elsewhere: added or brought up to date in place. The
  // function fields change identity every render of their source, so only a
  // change in what is shown publishes - or the source would re-render itself
  // without end.
  const upsertTask = useCallback(
    (task: Omit<Task, "cancelling" | "startedAt"> & Partial<Pick<Task, "cancelling">>) => {
      const t = find(task.id);
      if (!t) {
        tasksRef.current = [
          ...tasksRef.current,
          { ...task, cancelling: task.cancelling ?? false, startedAt: Date.now() },
        ];
        publish();
        return;
      }
      const visible: (keyof Task)[] = ["label", "done", "total", "cancelLabel", "stopTitle", "title", "locksNav", "cancelling"];
      const hadCancel = t.cancel !== null;
      t.cancel = task.cancel;
      let changed = hadCancel !== (task.cancel !== null);
      for (const key of visible) {
        const next = task[key as keyof typeof task];
        // A source that does not track its own Stop leaves the dock's mark.
        if (key === "cancelling" && next === undefined) continue;
        if (t[key] !== next) {
          (t as unknown as Record<string, unknown>)[key] = next;
          changed = true;
        }
      }
      if (changed) publish();
    },
    [find, publish]
  );

  const hasTask = useCallback((id: string) => tasks.some((t) => t.id === id && !t.finished), [tasks]);

  // --- the pictures of a bulk edit -----------------------------------------
  // The edit itself returns as soon as the rows are written and the backend
  // re-renders in the background; this follows those renders until the last
  // one is through. Stop ends it there: a bulk edit is only as far as its
  // pictures are, so the photos not rendered yet go back to how they were.
  //
  // Every photo being followed since the queue was last empty: a second bulk
  // edit while the first still renders adds to the same count.
  const trackedRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<number | null>(null);
  // The count shown is of renders, not of photos followed: a bulk edit only
  // queues the photos whose look it changed. So the total is what was through
  // before plus what is waiting, taken again whenever photos were added.
  const countRef = useRef({ total: 0, left: 0, added: false });

  const cancelRenders = useCallback(async () => {
    const ids = Array.from(trackedRef.current);
    if (ids.length === 0) return;
    patchTask(RENDERS_TASK_ID, { cancelling: true });
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
      patchTask(RENDERS_TASK_ID, { cancelling: false });
    }
  }, [patchTask, queryClient]);

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
      removeTask(RENDERS_TASK_ID);
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
    if (pending > 0) {
      upsertTask({
        id: RENDERS_TASK_ID,
        kind: "renders",
        label: "Rendering",
        done: count.total - pending,
        total: count.total,
        cancel: cancelRenders,
        cancelling: find(RENDERS_TASK_ID)?.cancelling ?? false,
        title: "The edited photos are being rendered in the background. You can keep working.",
        stopTitle: "Stop. Photos already rendered keep the edit, the rest stay as they were.",
      });
    }
    timerRef.current = window.setTimeout(poll, unasked ? 0 : RENDER_POLL_MS);
  }, [cancelRenders, find, removeTask, upsertTask]);

  const trackRenders = useCallback(
    (imageIds: string[]) => {
      if (imageIds.length === 0) return;
      for (const id of imageIds) trackedRef.current.add(id);
      countRef.current.added = true;
      if (timerRef.current === null) timerRef.current = window.setTimeout(poll, 0);
    },
    [poll]
  );

  // --- the copy job --------------------------------------------------------
  // A server-side job writes one copy after the other; followed the same way,
  // and Stop ends it between photos - the copies written so far stay. After
  // "Apply … and save copy" the edited photos re-render at the same time: the
  // copy task stands in for both (the dock hides the render task under it)
  // and its Stop stops both.
  const copyTimerRef = useRef<number | null>(null);

  const trackCopyJob = useCallback(
    (jobId: string, total: number) => {
      const id = `copies:${jobId}`;
      const cancel = async () => {
        try {
          await api.images.copyJobCancel(jobId);
        } catch {
          // The poll notices a backend that is gone and takes the task down.
        }
        if (trackedRef.current.size > 0) void cancelRenders();
      };
      const task = (done: number) => ({
        id,
        kind: "copies" as const,
        label: "Saving copy",
        done: Math.min(done + 1, total),
        total,
        cancel,
        cancelling: find(id)?.cancelling ?? false,
        title:
          trackedRef.current.size > 0
            ? "The edit is applied and the copies are saved in the background. You can keep working."
            : "The copies are being saved in the background. You can keep working.",
        stopTitle:
          trackedRef.current.size > 0
            ? "Stop. Copies already made and photos already rendered stay; the rest go back."
            : "Stop after the copy being written. The copies already made stay.",
      });
      upsertTask(task(0));
      const pollCopies = async () => {
        copyTimerRef.current = null;
        let finished = true;
        try {
          const p = await api.images.copyJobProgress(jobId);
          finished = p.state !== "running";
          upsertTask(task(p.done));
        } catch {
          // The backend is gone or restarting: there is nothing left to follow.
        }
        if (!finished) {
          copyTimerRef.current = window.setTimeout(pollCopies, RENDER_POLL_MS);
          return;
        }
        removeTask(id);
        // The copies sit in the grid next to their originals now.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["images"] }),
          queryClient.invalidateQueries({ queryKey: ["tags"] }),
        ]);
        nudgeWaitingThumbs();
      };
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(pollCopies, RENDER_POLL_MS);
    },
    [cancelRenders, find, queryClient, removeTask, upsertTask]
  );

  // --- an export job ---------------------------------------------------------
  // The server renders (or zips) in a worker thread; followed here from the
  // moment the dialog closed. Stop ends it between photos. When it is ready,
  // `onReady` writes the download or names the folder, and the chip it
  // returns stays in the dock for a moment.
  const trackExportJob = useCallback(
    ({ jobId, total, onReady }: ExportJobOpts) => {
      const handle = startTask({
        id: `export:${jobId}`,
        kind: "export",
        label: "Exporting",
        done: 0,
        total,
        cancel: async () => {
          try {
            await api.images.exportCancel(jobId);
          } catch {
            // The poll notices a backend that is gone and takes the task down.
          }
        },
        title: "The photos are rendered in the background. You can keep working.",
        stopTitle: "Stop. What was written so far stays.",
      });
      if (!handle) return;
      const tick = async () => {
        let p: ExportJobProgress;
        try {
          p = await api.images.exportProgress(jobId);
        } catch (e) {
          handle.finish({ label: (e as Error).message || "Export failed", error: true });
          return;
        }
        if (p.state === "running") {
          handle.update({ done: p.done, total: p.total });
          window.setTimeout(tick, EXPORT_POLL_MS);
          return;
        }
        if (p.state === "cancelled") {
          handle.finish({ label: "Export stopped" });
          return;
        }
        if (p.state === "error") {
          handle.finish({ label: p.error ?? "Export failed", error: true });
          return;
        }
        // Ready: the download is written now (nothing to stop any more).
        handle.update({ label: "Saving export…", done: undefined, total: undefined, cancel: null });
        try {
          handle.finish((await onReady(p)) ?? undefined);
        } catch (e) {
          handle.finish({ label: (e as Error).message || "Export failed", error: true });
        }
      };
      window.setTimeout(tick, EXPORT_POLL_MS);
    },
    [startTask]
  );

  // What the desktop shell asks before quitting (electron/main.js
  // outstandingWork): the tasks that live in this window and would be cut
  // off - not the backend's own jobs, which it counts itself.
  useEffect(() => {
    const own: TaskKind[] = ["batch", "editor-save", "export", "copy", "plain"];
    window.__rollfilmTasks = () =>
      tasksRef.current.filter((t) => !t.finished && own.includes(t.kind)).map((t) => t.label);
    return () => {
      delete window.__rollfilmTasks;
    };
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      for (const timer of finishTimers.current.values()) window.clearTimeout(timer);
    },
    []
  );

  return (
    <TasksContext.Provider
      value={{
        tasks, hasTask, startTask, runTask, runBatches, trackPolledJob, cancelTask, dismissTask,
        upsertTask, removeTask, trackRenders, cancelRenders, trackCopyJob, trackExportJob,
      }}
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

// A task whose state lives elsewhere, mirrored in the dock while `task` is
// non-null and taken down when it goes or the component does.
export function useExternalTask(task: (Omit<Task, "cancelling" | "startedAt"> & Partial<Pick<Task, "cancelling">>) | null) {
  const { upsertTask, removeTask } = useTasks();
  const idRef = useRef<string | null>(null);
  useEffect(() => {
    if (task) {
      if (idRef.current && idRef.current !== task.id) removeTask(idRef.current);
      idRef.current = task.id;
      upsertTask(task);
    } else if (idRef.current) {
      removeTask(idRef.current);
      idRef.current = null;
    }
  });
  useEffect(
    () => () => {
      if (idRef.current) removeTask(idRef.current);
    },
    [removeTask]
  );
}

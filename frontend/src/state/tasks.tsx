import { createContext, useContext, useState, type ReactNode } from "react";

// A tiny global "a blocking task is running" flag. Long-running maintenance
// actions in Settings (sync / rebuild thumbnails / wipe / restore) set a label
// here; while it's non-null the top-nav is locked (you can't switch tabs and
// unmount the page mid-task) and a spinner is shown.
interface TasksState {
  busyLabel: string | null;
  setBusyLabel: (label: string | null) => void;
}

const TasksContext = createContext<TasksState | null>(null);

export function TasksProvider({ children }: { children: ReactNode }) {
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  return <TasksContext.Provider value={{ busyLabel, setBusyLabel }}>{children}</TasksContext.Provider>;
}

export function useTasks(): TasksState {
  const ctx = useContext(TasksContext);
  if (!ctx) throw new Error("useTasks must be used within TasksProvider");
  return ctx;
}

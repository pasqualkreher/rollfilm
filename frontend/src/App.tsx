import { useEffect, useRef } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api/client";
import { Library } from "./pages/Library";
import { ImportWizard } from "./pages/ImportWizard";
import { Albums } from "./pages/Albums";
import { AlbumDetail } from "./pages/AlbumDetail";
import { ImageDetail } from "./pages/ImageDetail";
import { Settings } from "./pages/Settings";
import { Selects } from "./pages/Selects";
import { Trash } from "./pages/Trash";
import { MapView } from "./pages/MapView";
import { Help } from "./pages/Help";
import { SearchBar } from "./components/SearchBar";
import { WelcomeGuide } from "./components/WelcomeGuide";
import { ImportSessionProvider, useImportSession } from "./state/importSession";
import { SelectsProvider, useSelects } from "./state/selects";
import { TasksProvider, useTasks } from "./state/tasks";

// Source-root scans run in the background (started from Settings or the
// automatic startup scan) and commit their new photos when they finish. This
// watches them from anywhere in the app and refreshes the photo queries when a
// scan completes or a source's photo count changes - without it, the Library
// only updated on react-query's refetch-on-window-focus, i.e. after switching
// windows and back.
function SourceScanWatcher() {
  const queryClient = useQueryClient();
  const { data: sources } = useQuery({
    queryKey: ["sources"],
    queryFn: () => api.sources.list(),
    // Poll fast while a scan is running, slowly otherwise (also picks up the
    // startup auto-scan and drives being plugged in/out).
    refetchInterval: (query) =>
      (query.state.data ?? []).some((s) => s.scanning) ? 1500 : 10_000,
  });

  const prev = useRef<{ scanning: boolean; count: number } | null>(null);
  useEffect(() => {
    if (!sources) return;
    const scanning = sources.some((s) => s.scanning);
    const count = sources.reduce((sum, s) => sum + s.image_count, 0);
    const p = prev.current;
    prev.current = { scanning, count };
    if (p && ((p.scanning && !scanning) || p.count !== count)) {
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["image"] });
    }
  }, [sources, queryClient]);

  return null;
}

function ImportNavLink() {
  const { isUploading, uploadProgress } = useImportSession();
  return (
    <NavLink to="/import">
      Import{isUploading ? ` (${uploadProgress ?? 0}%)` : ""}
    </NavLink>
  );
}

function SelectsNavLink() {
  const { count } = useSelects();
  return (
    <NavLink to="/selects">
      Selects{count > 0 ? ` (${count})` : ""}
    </NavLink>
  );
}

// Top bar: while a blocking Settings task runs, the nav is locked (you can't
// switch tabs) and a spinner + label shows what's happening.
function TopBar() {
  const { busyLabel } = useTasks();
  const locked = busyLabel !== null;
  return (
    <div className="top-bar">
      <span className="brand">Photo Manager</span>
      <nav
        className={`nav-links${locked ? " nav-links--locked" : ""}`}
        aria-disabled={locked}
        title={locked ? "Please wait until the current task finishes" : undefined}
      >
        <NavLink to="/" end>
          Library
        </NavLink>
        <NavLink to="/albums">Albums</NavLink>
        <NavLink to="/map">Map</NavLink>
        <ImportNavLink />
        <SelectsNavLink />
        <NavLink to="/trash">Trash</NavLink>
        <NavLink to="/settings">Settings</NavLink>
        <NavLink to="/help">Help</NavLink>
      </nav>
      {locked && (
        <span className="nav-task" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {busyLabel}
        </span>
      )}
      <SearchBar />
    </div>
  );
}

export default function App() {
  return (
    <TasksProvider>
      <SelectsProvider>
        <ImportSessionProvider>
          <div className="app-shell">
            <SourceScanWatcher />
            <TopBar />

            <Routes>
            <Route path="/" element={<Library />} />
            <Route path="/import" element={<ImportWizard />} />
            <Route path="/albums" element={<Albums />} />
            <Route path="/albums/:id" element={<AlbumDetail />} />
            <Route path="/image/:id" element={<ImageDetail />} />
            <Route path="/map" element={<MapView />} />
            <Route path="/selects" element={<Selects />} />
            <Route path="/trash" element={<Trash />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/help" element={<Help />} />
            </Routes>

            <WelcomeGuide />
          </div>
        </ImportSessionProvider>
      </SelectsProvider>
    </TasksProvider>
  );
}

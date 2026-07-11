import { NavLink, Route, Routes } from "react-router-dom";
import { Library } from "./pages/Library";
import { ImportWizard } from "./pages/ImportWizard";
import { Albums } from "./pages/Albums";
import { AlbumDetail } from "./pages/AlbumDetail";
import { ImageDetail } from "./pages/ImageDetail";
import { Settings } from "./pages/Settings";
import { Selects } from "./pages/Selects";
import { MapView } from "./pages/MapView";
import { Help } from "./pages/Help";
import { SearchBar } from "./components/SearchBar";
import { WelcomeGuide } from "./components/WelcomeGuide";
import { ImportSessionProvider, useImportSession } from "./state/importSession";
import { SelectsProvider, useSelects } from "./state/selects";
import { TasksProvider, useTasks } from "./state/tasks";

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
            <TopBar />

            <Routes>
            <Route path="/" element={<Library />} />
            <Route path="/import" element={<ImportWizard />} />
            <Route path="/albums" element={<Albums />} />
            <Route path="/albums/:id" element={<AlbumDetail />} />
            <Route path="/image/:id" element={<ImageDetail />} />
            <Route path="/map" element={<MapView />} />
            <Route path="/selects" element={<Selects />} />
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

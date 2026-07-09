import { NavLink, Route, Routes } from "react-router-dom";
import { Library } from "./pages/Library";
import { ImportWizard } from "./pages/ImportWizard";
import { Albums } from "./pages/Albums";
import { AlbumDetail } from "./pages/AlbumDetail";
import { ImageDetail } from "./pages/ImageDetail";
import { Settings } from "./pages/Settings";
import { Selects } from "./pages/Selects";
import { MapView } from "./pages/MapView";
import { SearchBar } from "./components/SearchBar";
import { ImportSessionProvider, useImportSession } from "./state/importSession";
import { SelectsProvider, useSelects } from "./state/selects";

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

export default function App() {
  return (
    <SelectsProvider>
      <ImportSessionProvider>
        <div className="app-shell">
          <div className="top-bar">
            <span className="brand">Photo Manager</span>
            <nav className="nav-links">
              <NavLink to="/" end>
                Library
              </NavLink>
              <NavLink to="/albums">Albums</NavLink>
              <NavLink to="/map">Map</NavLink>
              <ImportNavLink />
              <SelectsNavLink />
              <NavLink to="/settings">Settings</NavLink>
            </nav>
            <SearchBar />
          </div>

          <Routes>
            <Route path="/" element={<Library />} />
            <Route path="/import" element={<ImportWizard />} />
            <Route path="/albums" element={<Albums />} />
            <Route path="/albums/:id" element={<AlbumDetail />} />
            <Route path="/image/:id" element={<ImageDetail />} />
            <Route path="/map" element={<MapView />} />
            <Route path="/selects" element={<Selects />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </ImportSessionProvider>
    </SelectsProvider>
  );
}

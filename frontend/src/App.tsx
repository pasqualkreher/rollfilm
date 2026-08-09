import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api/client";
import { Library } from "./pages/Library";
import { SearchBar } from "./components/SearchBar";
import { IconChart, IconGear, IconHelp, IconMail } from "./components/Icons";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { DialogProvider } from "./components/AppDialogs";
import { ImportSessionProvider, useImportSession } from "./state/importSession";
import { SelectsProvider, useSelects } from "./state/selects";
import { TasksProvider, useTasks } from "./state/tasks";
import { WaitProvider } from "./state/wait";

// Every screen except the Library is code-split. The app used to ship as one
// bundle, so each launch parsed and compiled the photo editor (by far the
// biggest module), the whole Settings page, Help, and Leaflet along with the
// map - before the library it was about to show could paint. None of that is
// needed to look at photos, and most launches never touch any of it.
//
// The Library itself stays eagerly imported: it is what the app opens on, and
// splitting it would only trade compile time for a loading flash on the one
// route that must be there immediately.
//
// These are named exports, hence the unwrapping - React.lazy wants a module
// whose `default` is the component.
const page = <T extends Record<string, unknown>, K extends keyof T>(
  load: () => Promise<T>,
  name: K
) => lazy(() => load().then((m) => ({ default: m[name] as React.ComponentType })));

const importWizard = () => import("./pages/ImportWizard");
const imageDetail = () => import("./pages/ImageDetail");

const ImportWizard = page(importWizard, "ImportWizard");
const ImageDetail = page(imageDetail, "ImageDetail");
const Albums = page(() => import("./pages/Albums"), "Albums");
const AlbumDetail = page(() => import("./pages/AlbumDetail"), "AlbumDetail");
const SmartAlbumDetail = page(() => import("./pages/SmartAlbumDetail"), "SmartAlbumDetail");
const Settings = page(() => import("./pages/Settings"), "Settings");
const Stats = page(() => import("./pages/Stats"), "Stats");
const Selects = page(() => import("./pages/Selects"), "Selects");
const Trash = page(() => import("./pages/Trash"), "Trash");
const MapView = page(() => import("./pages/MapView"), "MapView");
const Help = page(() => import("./pages/Help"), "Help");

// Splitting a route moves its cost from startup to the first navigation, which
// would be the wrong trade for the two screens the Library leads to constantly:
// opening a photo is the single most common thing anyone does here, and a fresh
// launch with an empty library goes straight to Import. So fetch those two
// chunks once the app has settled - off the startup critical path, and long
// before the click that needs them. Everything else loads when it is asked for.
function usePrefetchLikelyRoutes() {
  useEffect(() => {
    const warm = () => {
      void imageDetail();
      void importWizard();
    };
    const idle = window.requestIdleCallback;
    if (idle) {
      const handle = idle(warm, { timeout: 3000 });
      return () => window.cancelIdleCallback?.(handle);
    }
    const timer = window.setTimeout(warm, 1500);
    return () => window.clearTimeout(timer);
  }, []);
}

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

// Smart start: with an empty library the only useful first move is importing,
// so a fresh app launch lands on the Import tab instead of an empty grid.
// Runs exactly once per app start, and only if the user is still sitting on
// the default Library route by the time the probe answers - a deep link or an
// early manual navigation is never overridden.
function EmptyLibraryRedirect() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sessionId, isUploading } = useImportSession();
  const ran = useRef(false);
  const { data } = useQuery({
    queryKey: ["images", "startup-probe"],
    queryFn: () => api.images.list({ view_mode: "combined" }, { limit: 1, offset: 0 }),
    staleTime: Infinity,
  });
  useEffect(() => {
    if (ran.current || !data) return;
    ran.current = true;
    if (data.length === 0 && location.pathname === "/" && !sessionId && !isUploading) {
      navigate("/import", { replace: true });
    }
  }, [data, location.pathname, sessionId, isUploading, navigate]);
  return null;
}

function ImportNavLink({ onNavigate }: { onNavigate?: () => void }) {
  const { isUploading, effectiveUploadPct, sessionId } = useImportSession();
  // While uploading show live progress - the same number as the wizard's
  // progress bar (see effectiveUploadPct), so the two can never disagree.
  // A staged-but-unreviewed batch gets a dot so it's obvious from anywhere
  // that photos are waiting for review. Non-breaking spaces keep the suffix
  // glued to the label - a narrow tab row must not wrap it onto its own line.
  const suffix = isUploading ? `\u00A0(${effectiveUploadPct ?? 0}%)` : sessionId ? "\u00A0•" : "";
  return (
    <NavLink
      to="/import"
      onClick={onNavigate}
      title={
        !isUploading && sessionId
          ? "An import batch is staged and waiting for your review"
          : undefined
      }
    >
      Import{suffix}
    </NavLink>
  );
}

function SelectsNavLink({ onNavigate }: { onNavigate?: () => void }) {
  const { count } = useSelects();
  return (
    <NavLink to="/selects" onClick={onNavigate}>
      {/* Non-breaking space: the count must never wrap onto its own line. */}
      Selects{count > 0 ? `\u00A0(${count})` : ""}
    </NavLink>
  );
}

// The core photo modules shown as the wide-window tab row. Settings and Help
// are deliberately not tabs: they're utility pages, shown as small icon
// buttons on the far right of the bar (like every pro imaging app), so the
// module switcher stays about the photos.
function ModuleLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <NavLink to="/" end onClick={onNavigate}>
        Library
      </NavLink>
      <NavLink to="/albums" onClick={onNavigate}>Albums</NavLink>
      <NavLink to="/map" onClick={onNavigate}>Map</NavLink>
      <ImportNavLink onNavigate={onNavigate} />
      <SelectsNavLink onNavigate={onNavigate} />
      <NavLink to="/trash" onClick={onNavigate}>Trash</NavLink>
    </>
  );
}

// Full list for the burger-menu dropdown on narrow windows, where the icon
// buttons may be the only other way to Settings/Help and text reads better.
function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <ModuleLinks onNavigate={onNavigate} />
      <NavLink to="/settings" onClick={onNavigate}>Settings</NavLink>
      <NavLink to="/help" onClick={onNavigate}>Help</NavLink>
    </>
  );
}

// "Where am I" label shown next to the burger button while the full nav row is
// collapsed away on narrow windows.
const PAGE_TITLES: Array<[string, string]> = [
  ["/albums", "Albums"],
  ["/map", "Map"],
  ["/import", "Import"],
  ["/selects", "Selects"],
  ["/trash", "Trash"],
  ["/settings", "Settings"],
  ["/help", "Help"],
  ["/image", "Photo"],
];

function currentPageTitle(pathname: string): string {
  for (const [prefix, title] of PAGE_TITLES) {
    if (pathname.startsWith(prefix)) return title;
  }
  return "Library";
}

// Top bar: while a blocking Settings task runs, the nav is locked (you can't
// switch tabs) and a spinner + label shows what's happening. On narrow windows
// the tab row collapses into a burger menu instead of wrapping onto extra rows.
function TopBar() {
  const { busyLabel } = useTasks();
  const locked = busyLabel !== null;
  const location = useLocation();
  const { isUploading, sessionId } = useImportSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the burger menu on an outside click or Escape (link clicks close it
  // via onNavigate).
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div className="top-bar">
      {/* Three zones: left (brand/nav/status) and right (version/icons) carry
          equal flex weight, so the search field between them sits exactly on
          the bar's midpoint - and shrinks instead of overlapping when a zone
          needs the room. */}
      <div className="top-bar-side top-bar-side--left">
      <span className="brand">
        {/* BASE_URL ("./" in builds) keeps the path working under file:// in Electron,
    where an absolute "/rollfilm.svg" would point at the filesystem root. */}
        <img src={`${import.meta.env.BASE_URL}rollfilm.svg`} alt="" style={{ height: 18, width: 18, marginRight: 7 }} />
        Rollfilm
      </span>
      <nav
        className={`nav-links${locked ? " nav-links--locked" : ""}`}
        aria-disabled={locked}
        title={locked ? "Please wait until the current task finishes" : undefined}
      >
        <ModuleLinks />
      </nav>
      <div
        className={`nav-burger-wrap${locked ? " nav-links--locked" : ""}`}
        ref={menuRef}
        aria-disabled={locked}
        title={locked ? "Please wait until the current task finishes" : undefined}
      >
        <button
          className="nav-burger"
          aria-label="Menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {/* Crisp SVG hamburger instead of the ☰ glyph, whose weight varies by
              platform font and looked out of place in the slimmed-down bar. */}
          <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
            <path d="M0 1h14M0 6h14M0 11h14" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          {/* Activity dot: an upload/staged batch is easy to miss while its
              nav link is hidden inside the collapsed menu. */}
          {(isUploading || sessionId) && <span className="nav-burger-dot" aria-hidden />}
        </button>
        <span className="nav-current">{currentPageTitle(location.pathname)}</span>
        {menuOpen && (
          <nav className="nav-menu" role="menu">
            <NavLinks onNavigate={() => setMenuOpen(false)} />
          </nav>
        )}
      </div>
      {locked && (
        <span className="nav-task" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {busyLabel}
        </span>
      )}
      <ImmichSyncIndicator />
      </div>
      <SearchBar />
      <div className="top-bar-side top-bar-side--right">
      <span className="app-version" title={`Rollfilm ${__APP_VERSION__}`}>
        v{__APP_VERSION__}
      </span>
      <nav
        className={`top-icon-links${locked ? " nav-links--locked" : ""}`}
        aria-label="Statistics, settings, help and contact"
      >
        <NavLink
          to="/stats"
          className={({ isActive }) => `top-icon-link${isActive ? " active" : ""}`}
          title="Statistics"
          aria-label="Statistics"
        >
          <IconChart size={16} />
        </NavLink>
        <NavLink
          to="/settings"
          className={({ isActive }) => `top-icon-link${isActive ? " active" : ""}`}
          title="Settings"
          aria-label="Settings"
        >
          <IconGear size={16} />
        </NavLink>
        <NavLink
          to="/help"
          className={({ isActive }) => `top-icon-link${isActive ? " active" : ""}`}
          title="Help"
          aria-label="Help"
        >
          <IconHelp size={16} />
        </NavLink>
        {/* Sits last, after Help: when the built-in help doesn't answer it,
            the next step is a human. The version rides along in the subject
            because the first question back is always "which version?" - and
            the person writing has no reason to know where to look it up. */}
        <a
          className="top-icon-link"
          href={`mailto:contact@rollfilm.org?subject=${encodeURIComponent(
            `Rollfilm v${__APP_VERSION__}`
          )}`}
          title="Contact — report a problem or send an idea"
          aria-label="Contact"
        >
          <IconMail size={16} />
        </a>
      </nav>
      </div>
    </div>
  );
}

// Quiet top-bar pill while Immich uploads run in the background, so the user
// knows a sync is happening (and why quitting would interrupt something) even
// though nothing blocks. Polls faster while active, lazily when idle.
function ImmichSyncIndicator() {
  const { data } = useQuery({
    queryKey: ["immich-activity"],
    queryFn: () => api.settings.immichActivity(),
    refetchInterval: (query) => ((query.state.data?.pending_uploads ?? 0) > 0 ? 3000 : 20000),
  });
  const pending = data?.pending_uploads ?? 0;
  if (pending === 0) return null;
  return (
    <span
      className="nav-task"
      role="status"
      aria-live="polite"
      title="Photos are uploading to Immich in the background. You'll be asked before quitting would interrupt this."
    >
      <span className="spinner" aria-hidden="true" />
      Immich sync: {pending} left
    </span>
  );
}

export default function App() {
  usePrefetchLikelyRoutes();
  return (
    <TasksProvider>
      <WaitProvider>
      <SelectsProvider>
        <ImportSessionProvider>
          <DialogProvider>
          <div className="app-shell">
            <SourceScanWatcher />
            <EmptyLibraryRedirect />
            <TopBar />

            {/* Same wording and styling as a page waiting on its own data, so a
                chunk that isn't in memory yet reads as the page loading rather
                than as the app blanking out. In practice it is rarely seen: the
                chunks come off local disk, and the two routes the Library leads
                to are prefetched while the app idles. */}
            <Suspense fallback={<div className="empty-state">Loading...</div>}>
            <Routes>
            <Route path="/" element={<Library />} />
            <Route path="/import" element={<ImportWizard />} />
            <Route path="/albums" element={<Albums />} />
            <Route path="/albums/:id" element={<AlbumDetail />} />
            <Route path="/smart-albums/:id" element={<SmartAlbumDetail />} />
            <Route path="/image/:id" element={<ImageDetail />} />
            <Route path="/map" element={<MapView />} />
            <Route path="/selects" element={<Selects />} />
            <Route path="/trash" element={<Trash />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/help" element={<Help />} />
            </Routes>
            </Suspense>

            <OnboardingWizard />
          </div>
          </DialogProvider>
        </ImportSessionProvider>
      </SelectsProvider>
      </WaitProvider>
    </TasksProvider>
  );
}

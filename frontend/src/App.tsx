import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Navigate,
  NavLink as RouterNavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  type NavLinkProps,
} from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api/client";
import { Library } from "./pages/Library";
import { SearchBar } from "./components/SearchBar";
import { IconChart, IconChevronLeft, IconChevronRight, IconGear, IconHelp, IconLandfill, IconMail, IconMenu, IconX } from "./components/Icons";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { DialogProvider } from "./components/AppDialogs";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UnhandledErrors } from "./components/UnhandledErrors";
import { ImportSessionProvider, useImportSession } from "./state/importSession";
import { TasksProvider, useTasks } from "./state/tasks";
import { WaitProvider } from "./state/wait";
import { Presence } from "./components/Presence";
import { MOTION } from "./utils/usePresence";
import { TooltipLayer } from "./components/TooltipLayer";
import { NavHistoryTracker, hasLeaveGuards, runLeaveGuards, useNavHistory } from "./state/navHistory";
import { isMac } from "./utils/selection";
import { useFocusModeSwitch } from "./state/focusMode";
import { Spinner, LoadingState } from "./components/Spinner";

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
const albums = () => import("./pages/Albums");
const canvases = () => import("./pages/Canvases");
const canvasDetail = () => import("./pages/CanvasDetail");
const canvasView = () => import("./pages/CanvasView");
const albumDetail = () => import("./pages/AlbumDetail");
const smartAlbumDetail = () => import("./pages/SmartAlbumDetail");
const settings = () => import("./pages/Settings");
const stats = () => import("./pages/Stats");
const trash = () => import("./pages/Trash");
const mapView = () => import("./pages/MapView");
const help = () => import("./pages/Help");

const ImportWizard = page(importWizard, "ImportWizard");
const ImageDetail = page(imageDetail, "ImageDetail");
const Albums = page(albums, "Albums");
const Canvases = page(canvases, "Canvases");
const CanvasDetail = page(canvasDetail, "CanvasDetail");
const CanvasView = page(canvasView, "CanvasView");
const AlbumDetail = page(albumDetail, "AlbumDetail");
const SmartAlbumDetail = page(smartAlbumDetail, "SmartAlbumDetail");
const Settings = page(settings, "Settings");
const Stats = page(stats, "Stats");
const Trash = page(trash, "Trash");
const MapView = page(mapView, "MapView");
const Help = page(help, "Help");

// Splitting a route moves its cost from startup to the first navigation, which
// would be the wrong trade for the two screens the Library leads to constantly:
// opening a photo is the single most common thing anyone does here, and a fresh
// launch with an empty library goes straight to Import. So fetch those two
// chunks once the app has settled - off the startup critical path, and long
// before the click that needs them. The remaining pages follow in a second
// idle slot: they come off local disk and together weigh less than one
// preview, and having them in memory is what makes the first click on Albums
// or Settings swap the view in a single frame rather than after a load.
function usePrefetchLikelyRoutes() {
  useEffect(() => {
    const idle = window.requestIdleCallback;
    const later = (fn: () => void, timeout: number, delay: number) =>
      idle
        ? { cancel: window.cancelIdleCallback!.bind(window, idle(fn, { timeout })) }
        : { cancel: window.clearTimeout.bind(window, window.setTimeout(fn, delay)) };
    let rest: { cancel: () => void } | null = null;
    const warmRest = () => {
      for (const load of [
        albums, settings, stats, help, trash, canvases,
        albumDetail, smartAlbumDetail, canvasDetail, canvasView, mapView,
      ]) {
        void load();
      }
    };
    const warm = () => {
      void imageDetail();
      void importWizard();
      rest = later(warmRest, 5000, 1500);
    };
    const first = later(warm, 3000, 1500);
    return () => {
      first.cancel();
      rest?.cancel();
    };
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

// Every link in the top bar. Leaving through one is leaving like Back does:
// whatever the current view still owes (the editor's save) runs to completion
// first, with the wait popup up - see state/navHistory.ts. With nothing owed
// it is a plain NavLink.
function NavLink({ onClick, ...props }: NavLinkProps) {
  const navigate = useNavigate();
  return (
    <RouterNavLink
      {...props}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || !hasLeaveGuards()) return;
        // Left to the browser: opening the link somewhere else leaves nothing.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        void runLeaveGuards().then(() => navigate(props.to));
      }}
    />
  );
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
          ? "Imported photos are waiting for your review"
          : undefined
      }
    >
      Import{suffix}
    </NavLink>
  );
}

// The core photo modules shown as the wide-window tab row. Settings and Help
// are deliberately not tabs: they're utility pages, shown as small icon
// buttons on the far right of the bar (like every pro imaging app), so the
// module switcher stays about the photos.
function ModuleLinks({ onNavigate }: { onNavigate?: () => void }) {
  // Smart albums live under their own route (/smart-albums/:id), so the
  // router's automatic prefix match for /albums would leave the Albums tab
  // unmarked while one is open. They're still albums to the user.
  const { pathname } = useLocation();
  const inSmartAlbum = pathname.startsWith("/smart-albums");
  return (
    <>
      <NavLink to="/" end onClick={onNavigate}>
        Library
      </NavLink>
      <NavLink
        to="/albums"
        onClick={onNavigate}
        className={({ isActive }) => (isActive || inSmartAlbum ? "active" : "")}
      >
        Albums
      </NavLink>
      <NavLink to="/canvas" onClick={onNavigate}>Canvas</NavLink>
      <NavLink to="/map" onClick={onNavigate}>Map</NavLink>
      <ImportNavLink onNavigate={onNavigate} />
    </>
  );
}

// Full list for the burger-menu dropdown on narrow windows, where the icon
// buttons may be the only other way to Settings/Help and text reads better.
// Trash lives with the icon buttons on wide windows, so it has to be listed
// here explicitly or the collapsed bar would lose it entirely.
function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <ModuleLinks onNavigate={onNavigate} />
      <NavLink to="/trash" onClick={onNavigate}>Trash</NavLink>
      <NavLink to="/settings" onClick={onNavigate}>Settings</NavLink>
      <NavLink to="/help" onClick={onNavigate}>Help</NavLink>
    </>
  );
}

// "Where am I" label shown next to the burger button while the full nav row is
// collapsed away on narrow windows.
const PAGE_TITLES: Array<[string, string]> = [
  ["/albums", "Albums"],
  ["/smart-albums", "Albums"],
  ["/canvas", "Canvas"],
  ["/map", "Map"],
  ["/import", "Import"],
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


// The app's one way back: a browser-style Back/Forward pair that steps through
// the history exactly as it was walked - Library to an album to a photo to
// the editor and back out the same way - instead of each view deciding where
// its own Back should lead. Views therefore carry no Back of their own
// (Escape stays as the keyboard way out where a view had one). Before a step,
// whatever the current view still owes (the editor's save) runs to
// completion - see state/navHistory.ts. Shortcuts: ⌘[ / ⌘] on macOS, Alt+←/→
// elsewhere, plus the mouse's back/forward buttons. They stay live in focus
// mode, where the bar itself is hidden.
function NavHistoryButtons({ locked }: { locked: boolean }) {
  const navigate = useNavigate();
  const { canGoBack, canGoForward } = useNavHistory();
  const canBack = canGoBack && !locked;
  const canForward = canGoForward && !locked;
  // A guard can take a moment (the save popup); a second press meanwhile
  // must not queue a second step.
  const steppingRef = useRef(false);
  const step = async (delta: -1 | 1) => {
    if (steppingRef.current) return;
    steppingRef.current = true;
    try {
      await runLeaveGuards();
      navigate(delta);
    } finally {
      steppingRef.current = false;
    }
  };
  // Read through a ref so the window listeners are wired once.
  const latest = useRef({ canBack, canForward, step });
  latest.current = { canBack, canForward, step };
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const chord = isMac
        ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
        : e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;
      if (!chord) return;
      const back = isMac ? e.key === "[" : e.key === "ArrowLeft";
      const forward = isMac ? e.key === "]" : e.key === "ArrowRight";
      if (!back && !forward) return;
      e.preventDefault();
      const { canBack, canForward, step } = latest.current;
      if (back && canBack) void step(-1);
      if (forward && canForward) void step(1);
    }
    // The extra mouse buttons: 3 is back, 4 is forward on every platform.
    function onMouseUp(e: MouseEvent) {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      const { canBack, canForward, step } = latest.current;
      if (e.button === 3 && canBack) void step(-1);
      if (e.button === 4 && canForward) void step(1);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);
  const backKey = isMac ? "⌘[" : "Alt+←";
  const forwardKey = isMac ? "⌘]" : "Alt+→";
  return (
    <div className="nav-history" role="group" aria-label="History">
      <button
        className="top-icon-link nav-history-btn"
        onClick={() => void step(-1)}
        disabled={!canBack}
        title={`Back (${backKey})`}
        aria-label="Back"
      >
        <IconChevronLeft size={16} />
      </button>
      <button
        className="top-icon-link nav-history-btn"
        onClick={() => void step(1)}
        disabled={!canForward}
        title={`Forward (${forwardKey})`}
        aria-label="Forward"
      >
        <IconChevronRight size={16} />
      </button>
    </div>
  );
}

// The logo, and what a click on it (logo or name) opens: the app's About
// window, the way a Mac app's name leads to "About" - version, website, the
// PayPal donate link and contact (the same lines as Settings > About). A modal
// of its own, portalled to the body: inside the bar it would sit in the
// window's drag region and under the bar's stacking context.
function BrandAbout() {
  const [open, setOpen] = useState(false);
  const platform = window.photoManager?.platform;

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="brand"
        aria-haspopup="dialog"
        title="About Rollfilm"
        onClick={() => setOpen(true)}
      >
        {/* BASE_URL ("./" in builds) keeps the path working under file:// in Electron,
    where an absolute "/rollfilm.svg" would point at the filesystem root. */}
        <img src={`${import.meta.env.BASE_URL}rollfilm.svg`} alt="" style={{ height: 18, width: 18, marginRight: 7 }} />
        Rollfilm
      </button>
      {createPortal(
        <Presence open={open} ms={MOTION.modal}>
          {open && (
            <div className="modal-overlay" onClick={() => setOpen(false)}>
              <div
                className="modal about-modal"
                role="dialog"
                aria-modal="true"
                aria-label="About Rollfilm"
                onClick={(e) => e.stopPropagation()}
              >
                <button type="button" className="modal-close about-modal-close" aria-label="Close" onClick={() => setOpen(false)}>
                  <IconX size={14} />
                </button>
                <img src={`${import.meta.env.BASE_URL}rollfilm.svg`} alt="" className="about-modal-logo" />
                <div className="about-modal-name">Rollfilm</div>
                <div className="about-modal-version">
                  Version {__APP_VERSION__}
                  {platform ? ` · ${platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform}` : " · web"}
                </div>
                {/* https links leave the app for the system browser (the
                    desktop shell routes every external URL to the OS). */}
                <a className="about-modal-site" href="https://rollfilm.org" target="_blank" rel="noreferrer">
                  rollfilm.org
                </a>
                <p className="about-modal-text">Rollfilm is free. If it is useful to you, a small donation keeps it going.</p>
                <a
                  className="btn primary about-modal-donate"
                  href="https://www.paypal.com/donate/?hosted_button_id=TE6RWWJ7JRPKN"
                  target="_blank"
                  rel="noreferrer"
                  autoFocus
                >
                  Donate via PayPal
                </a>
                <a
                  className="about-modal-contact"
                  href={`mailto:contact@rollfilm.org?subject=${encodeURIComponent(`Rollfilm v${__APP_VERSION__}`)}`}
                >
                  contact@rollfilm.org
                </a>
              </div>
            </div>
          )}
        </Presence>,
        document.body
      )}
    </>
  );
}

// Top bar: while a blocking Settings task runs, the nav is locked (you can't
// switch tabs) and a spinner + label shows what's happening. On narrow windows
// the tab row collapses into a burger menu instead of wrapping onto extra rows.
function TopBar() {
  const { busyLabel, renders, cancelRenders, cancellingRenders, copies, cancelCopyJob, cancellingCopies } =
    useTasks();
  const locked = busyLabel !== null;
  const location = useLocation();
  const { isUploading, sessionId } = useImportSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  // The bar's height goes on the root as a CSS variable (--top-bar-height,
  // index.css): it is where the full-window workspaces start.
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty("--top-bar-height", `${el.offsetHeight}px`);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--top-bar-height");
    };
  }, []);

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

  // The search field sits on the window's midpoint at full width, as in
  // fullscreen. Where the tabs reach past that spot (a window, with the
  // traffic-light inset) it moves only as far over as they need, and where
  // the room between tabs and icons is narrower than the field it shrinks to
  // fit. Only when even that would leave less than SEARCH_FOLD does the tab
  // row fold into the burger menu to make room; below SEARCH_MIN (a browser
  // tab, not the app) the field takes a row of its own. The edges measured
  // here - the left zone's content and the icon row - don't move when the
  // field does, and the fold is decided on the tab row's width (remembered
  // while it's hidden), so neither can oscillate.
  const barRef = useRef<HTMLDivElement | null>(null);
  const [searchRow, setSearchRow] = useState(false);
  const [searchCompact, setSearchCompact] = useState(false);
  const [navFolded, setNavFolded] = useState(false);
  useEffect(() => {
    const bar = barRef.current;
    const left = bar?.querySelector<HTMLElement>(".top-bar-side--left");
    const icons = bar?.querySelector<HTMLElement>(".top-icon-links");
    const tabs = left?.querySelector<HTMLElement>(".nav-links");
    const burger = left?.querySelector<HTMLElement>(".nav-burger-wrap");
    if (!bar || !left || !icons || !tabs || !burger) return;
    const SEARCH_WIDTH = 320;
    const SEARCH_COMPACT = 280; // below this the long placeholder gets cut off
    const SEARCH_FOLD = 120;
    const SEARCH_MIN = 90;
    let tabsWidth = 0;
    const measure = () => {
      const b = bar.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
      const mid = b.left + b.width / 2;
      const leftEdge = Math.max(
        b.left,
        ...Array.from(left.children)
          .map((c) => c.getBoundingClientRect())
          .filter((r) => r.width > 0)
          .map((r) => r.right)
      );
      const rightEdge = icons.getBoundingClientRect().left;
      const from = leftEdge + gap;
      const to = rightEdge - gap;
      // Where the left zone would end with the tab row showing: the burger
      // takes the tabs' place, so swap one width for the other.
      const shownTabs = tabs.getBoundingClientRect().width;
      if (shownTabs > 0) tabsWidth = shownTabs;
      const withTabs = shownTabs > 0 ? from : from - burger.getBoundingClientRect().width + tabsWidth;
      setNavFolded(to - withTabs < SEARCH_FOLD);
      const width = Math.min(SEARCH_WIDTH, to - from);
      const center = Math.min(Math.max(mid, from + width / 2), to - width / 2);
      bar.style.setProperty("--search-width", `${Math.floor(width)}px`);
      bar.style.setProperty("--search-x", `${Math.round(center - b.left)}px`);
      setSearchCompact(width < SEARCH_COMPACT);
      setSearchRow(width < SEARCH_MIN);
    };
    const ro = new ResizeObserver(measure);
    // Children come and go (task spinner, sync indicator) without the zone
    // changing size, so each one is watched too.
    const observeAll = () => {
      ro.disconnect();
      for (const el of [bar, left, icons, ...left.children]) ro.observe(el);
      measure();
    };
    observeAll();
    const mo = new MutationObserver(observeAll);
    mo.observe(left, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  // The app-wide focus mode (View menu, Cmd/Ctrl+F): the bar this component
  // draws is what it puts away.
  useFocusModeSwitch();

  // Cmd/Ctrl+Shift+F jumps into the search field (plain Cmd+F is focus mode).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || !e.shiftKey || e.key.toLowerCase() !== "f") return;
      const input = barRef.current?.querySelector<HTMLInputElement>(".search-bar input");
      if (!input) return;
      e.preventDefault();
      input.focus();
      input.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="top-bar-dock" ref={dockRef}>
    <div
      className={`top-bar${navFolded ? " top-bar--nav-folded" : ""}${searchRow ? " top-bar--search-row" : ""}`}
      ref={barRef}
    >
      {/* Left (brand/nav/status) and right (icons) zones; the search field is
          pinned to the window's midpoint between them (measured above), so it
          stays put whatever comes and goes on either side. */}
      <div className="top-bar-side top-bar-side--left">
      {/* The logo opens the bar, right after the traffic lights. */}
      <BrandAbout />
      <NavHistoryButtons locked={locked} />
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
          <IconMenu size={14} />
          {/* Activity dot: an upload/staged batch is easy to miss while its
              nav link is hidden inside the collapsed menu. */}
          {(isUploading || sessionId) && <span className="nav-burger-dot" aria-hidden />}
        </button>
        <span className="nav-current">{currentPageTitle(location.pathname)}</span>
        <Presence open={menuOpen} ms={MOTION.pop}>
          {menuOpen && (
            <nav className="nav-menu" role="menu">
              <NavLinks onNavigate={() => setMenuOpen(false)} />
            </nav>
          )}
        </Presence>
      </div>
      {locked && (
        <span className="nav-task" role="status" aria-live="polite">
          <Spinner />
          {busyLabel}
        </span>
      )}
      {/* The pictures of a bulk edit, rendering in the background: counted
          down here until the last one is through. Blocks nothing. Cancel stops
          it where it is - the photos not rendered yet lose the edit again. */}
      {renders && !locked && (
        <span className="nav-task">
          <span
            className="nav-task-label"
            role="status"
            title="The edited photos are being rendered in the background. You can keep working."
          >
            <Spinner />
            Rendering <span className="nav-task-count">{renders.done}</span> of {renders.total}
          </span>
          <button
            type="button"
            className="btn btn-sm ghost"
            onClick={cancelRenders}
            disabled={cancellingRenders}
            title="Stop. Photos already rendered keep the edit, the rest stay as they were."
          >
            Cancel
          </button>
        </span>
      )}
      {/* The copies of a bulk Save copy, written one after the other in the
          background. Cancel stops it between photos; the copies made stay. */}
      {copies && !locked && (
        <span className="nav-task">
          <span
            className="nav-task-label"
            role="status"
            title="The copies are being saved in the background. You can keep working."
          >
            <Spinner />
            Saving copy <span className="nav-task-count">{Math.min(copies.done + 1, copies.total)}</span> of {copies.total}
          </span>
          <button
            type="button"
            className="btn btn-sm ghost"
            onClick={cancelCopyJob}
            disabled={cancellingCopies}
            title="Stop after the copy being written. The copies already made stay."
          >
            Cancel
          </button>
        </span>
      )}
      <ImmichSyncIndicator />
      </div>
      <div className="top-bar-side top-bar-side--right">
      <nav
        className={`top-icon-links${locked ? " nav-links--locked" : ""}`}
        aria-label="Trash, statistics, settings, help and contact"
      >
        {/* Trash sits with the utility icons, not in the module tab row: it's
            housekeeping you visit occasionally, not a place you work in. First
            of the icons, so it stays next to the photo modules it acts on. */}
        <NavLink
          to="/trash"
          className={({ isActive }) => `top-icon-link${isActive ? " active" : ""}`}
          title="Trash"
          aria-label="Trash"
        >
          <IconLandfill size={16} />
        </NavLink>
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
          title="Contact: report a problem or send an idea"
          aria-label="Contact"
        >
          <IconMail size={16} />
        </a>
      </nav>
      </div>
      <SearchBar compact={searchCompact && !searchRow} />
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
      title="Photos are uploading to Immich in the background. You will be asked before quitting interrupts this."
    >
      <Spinner />
      Immich sync: {pending} left
    </span>
  );
}

// A crash while a page renders used to unmount the whole app - a white window
// with no way out but a restart. Caught here, the bars stay, the page says
// what happened, and going anywhere else clears it.
function PageBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary what="This page" resetKey={pathname}>
      {children}
    </ErrorBoundary>
  );
}

export default function App() {
  usePrefetchLikelyRoutes();
  return (
    <TasksProvider>
      <WaitProvider>
        <ImportSessionProvider>
          <DialogProvider>
          <div className="app-shell">
            <SourceScanWatcher />
            <NavHistoryTracker />
            <EmptyLibraryRedirect />
            <TopBar />
            <TooltipLayer />
            <UnhandledErrors />

            {/* Only ever seen on a cold first mount - a reload straight onto
                #/settings, or the empty-library redirect to Import before its
                chunk is warm. A navigation from one page to another runs as a
                transition (HashRouter's v7_startTransition), which keeps the
                current page up until the next one can render; and every page
                chunk is prefetched while the app idles anyway. Same wording
                and styling as a page waiting on its own data, so the rare
                sighting reads as the page loading rather than the app blanking
                out. */}
            <PageBoundary>
            <Suspense fallback={<LoadingState />}>
            <Routes>
            <Route path="/" element={<Library />} />
            <Route path="/import" element={<ImportWizard />} />
            <Route path="/albums" element={<Albums />} />
            <Route path="/albums/:id" element={<AlbumDetail />} />
            <Route path="/canvas" element={<Canvases />} />
            <Route path="/canvas/:id" element={<CanvasDetail />} />
            <Route path="/canvas/:id/view" element={<CanvasView />} />
            <Route path="/smart-albums/:id" element={<SmartAlbumDetail />} />
            {/* The editor is the photo view's second mode and its own history
                entry (/image/:id/edit): Back closes it, Forward reopens it.
                One route, so the view underneath stays mounted across the
                two. */}
            <Route path="/image/:id/:mode?" element={<ImageDetail />} />
            <Route path="/map" element={<MapView />} />
            <Route path="/trash" element={<Trash />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/help" element={<Help />} />
            {/* An address that leads nowhere lands in the library instead of
                on an empty window. */}
            <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </Suspense>
            </PageBoundary>

            <OnboardingWizard />
          </div>
          </DialogProvider>
        </ImportSessionProvider>
      </WaitProvider>
    </TasksProvider>
  );
}

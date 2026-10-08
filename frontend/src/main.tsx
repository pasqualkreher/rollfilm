import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// HashRouter (not BrowserRouter) so routing works when the built app is loaded
// from file:// inside Electron; it also works fine for the web/dev build.
import { HashRouter } from "react-router-dom";
import App from "./App";
import { LibrarySetup } from "./components/LibrarySetup";
import "./index.css";
import { initTheme } from "./state/theme";
import { initCorners } from "./state/corners";
import { initFont } from "./state/fonts";

// Apply the saved light/dark preference, corner style and typeface before the
// first paint.
initTheme();
initCorners();
initFont();

// Electron on macOS: the window has no title bar of its own, the traffic
// lights sit inside the app's top bar (index.css, data-titlebar rules). The
// attribute goes on before React renders so the bar never paints without its
// inset; fullscreen hides the lights, so the inset follows data-fullscreen.
//
// Fullscreen is read two ways and either one counts: the shell's word over
// IPC (enter/leave-full-screen), and the window itself - in fullscreen it is
// exactly the screen's size, with no menu bar left over, and Chromium
// reports the display mode as fullscreen. The shell's events have been seen
// to miss (the bar kept its inset in fullscreen), and the page can tell on
// its own.
if (window.photoManager?.platform === "darwin") {
  document.documentElement.setAttribute("data-titlebar", "inset");
  let shellSaysFullscreen = false;
  const fillsScreen = () =>
    window.innerWidth === window.screen.width && window.innerHeight === window.screen.height;
  const displayModeFullscreen = window.matchMedia("(display-mode: fullscreen)");
  const apply = () =>
    document.documentElement.toggleAttribute(
      "data-fullscreen",
      shellSaysFullscreen || displayModeFullscreen.matches || fillsScreen()
    );
  const setFs = (on: boolean) => {
    shellSaysFullscreen = on;
    apply();
  };
  window.photoManager.isFullScreen?.().then(setFs).catch(() => {});
  window.photoManager.onFullScreen?.(setFs);
  window.addEventListener("resize", apply);
  displayModeFullscreen.addEventListener("change", apply);
  apply();

  // The zoom (Cmd +/-) scales the page but not the traffic lights, so the
  // bar's inset and floor are divided by the factor in index.css (--zoom) to
  // stay the lights' native size. The shell reports the factor on load and
  // on every change (main.js syncZoomChrome).
  const setZoom = (factor: number) =>
    document.documentElement.style.setProperty("--zoom", String(factor > 0 ? factor : 1));
  window.photoManager.getZoom?.().then(setZoom).catch(() => {});
  window.photoManager.onZoom?.(setZoom);
}

const queryClient = new QueryClient({
  // gcTime: how long a page's data outlives the page. The default (5 min)
  // meant that coming back to Albums or Stats after a longer stay elsewhere
  // showed a spinner and repainted from nothing. Half an hour keeps every
  // area's last data in memory for the length of a normal session, so a
  // revisit paints at once and only refreshes in the background (staleTime).
  // The largest entries - the library index at ~100 bytes a row and the
  // per-photo records - stay in the low tens of MB.
  defaultOptions: { queries: { retry: 1, staleTime: 10_000, gcTime: 30 * 60_000 } },
});

// On the desktop first run the shell opens the window before a library (and
// therefore the backend) exists, so the app can't talk to the API yet. Ask the
// shell whether a library is configured: if not, show the in-app library-setup
// screen instead of the full app. In the web build there's no bridge, so the
// app renders directly.
function Root() {
  const [mode, setMode] = useState<"loading" | "setup" | "app">(() =>
    typeof window !== "undefined" && window.photoManager?.getLibraryRoot ? "loading" : "app"
  );

  useEffect(() => {
    if (mode !== "loading") return;
    window.photoManager!.getLibraryRoot()
      .then((root) => setMode(root ? "app" : "setup"))
      .catch(() => setMode("app"));
  }, [mode]);

  if (mode === "loading") return null;
  if (mode === "setup") return <LibrarySetup />;
  return (
    // v7_startTransition: a navigation is committed inside React.startTransition,
    // so while a lazily loaded page's chunk is still on its way the current
    // page stays mounted and usable instead of the Suspense fallback blanking
    // the window; old and new page then swap in one commit.
    <HashRouter future={{ v7_startTransition: true }}>
      <App />
    </HashRouter>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </React.StrictMode>
);

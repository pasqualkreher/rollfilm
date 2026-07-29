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

// Apply the saved light/dark preference and corner style before the first paint.
initTheme();
initCorners();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
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
    <HashRouter>
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

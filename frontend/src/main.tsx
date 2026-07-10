import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// HashRouter (not BrowserRouter) so routing works when the built app is loaded
// from file:// inside Electron; it also works fine for the web/dev build.
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./index.css";
import { initTheme } from "./state/theme";

// Apply the saved light/dark preference before the first paint.
initTheme();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <App />
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>
);

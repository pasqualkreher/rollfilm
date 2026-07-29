import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // Relative asset URLs so the built bundle loads from file:// inside Electron.
  base: "./",
  server: {
    host: true,
    port: 5173,
    // Fail loudly if 5173 is taken instead of silently drifting to 5174+.
    // Electron and `wait-on` both target 5173 by name (see electron/package.json),
    // so a drifted port would leave the desktop start hanging on wait-on forever.
    // `predev` (scripts/dev-clean.js) frees 5173 first, so this should always bind.
    strictPort: true,
  },
});

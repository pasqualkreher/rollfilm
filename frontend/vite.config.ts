import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs so the built bundle loads from file:// inside Electron.
  base: "./",
  server: {
    host: true,
    port: 5173,
  },
});

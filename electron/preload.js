// Bridges a tiny, explicit API into the renderer. Nothing else from Node/Electron
// is exposed (contextIsolation on). client.ts reads `apiBaseUrl` at load time;
// ExternalSources calls `pickFolder()` to add an existing photo folder.

const { contextBridge, ipcRenderer } = require("electron");

function readApiBase() {
  const prefix = "--pm-api-base=";
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

contextBridge.exposeInMainWorld("photoManager", {
  apiBaseUrl: readApiBase(),
  // Opens the native OS folder dialog; resolves to an absolute host path or null.
  pickFolder: () => ipcRenderer.invoke("pm:pick-folder"),
  // Current photo-library folder (chosen on first start).
  getLibraryRoot: () => ipcRenderer.invoke("pm:get-library-root"),
  // Pick a new library folder; on confirmation the app restarts itself.
  changeLibraryRoot: () => ipcRenderer.invoke("pm:change-library-root"),
  // Folder holding the database, thumbnails and staging (inside the library).
  getDataRoot: () => ipcRenderer.invoke("pm:get-data-root"),
  // First-start wizard: whether this launch is a genuine first run.
  isFirstRun: () => ipcRenderer.invoke("pm:is-first-run"),
  // Leftover app-data folders from the old app name, as { path, sizeBytes }[].
  scanLegacyData: () => ipcRenderer.invoke("pm:scan-legacy-data"),
  // Deletes those leftover folders; resolves with { removed, failed }.
  removeLegacyData: () => ipcRenderer.invoke("pm:remove-legacy-data"),
});

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
  // Current folder holding the database + thumbnails.
  getDataRoot: () => ipcRenderer.invoke("pm:get-data-root"),
  // Pick a new database/thumbnails folder; data is copied and the app restarts.
  changeDataRoot: () => ipcRenderer.invoke("pm:change-data-root"),
});

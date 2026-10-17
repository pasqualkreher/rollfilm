// Bridges a tiny, explicit API into the renderer. Nothing else from Node/Electron
// is exposed (contextIsolation on). client.ts reads `apiBaseUrl` at load time;
// ExternalSources calls `pickFolder()` to add an existing photo folder.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

// main.js hands the renderer its few facts through additionalArguments
// (--pm-api-base=…, --pm-total-memory-gb=…): process.argv is all a sandboxed
// preload reliably has. Anything it would have to ask the OS for stays in
// main: the Linux renderer sandbox has no /proc, and one throwing call here
// (0.1.94-0.1.96 read the RAM through process.getSystemMemoryInfo()) took the
// whole bridge away - the page then talked to localhost:8000 and every
// request "did not answer" (issue #4).
function readArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function readTotalMemoryGb() {
  const n = Number(readArg("pm-total-memory-gb"));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

contextBridge.exposeInMainWorld("photoManager", {
  apiBaseUrl: readArg("pm-api-base"),
  // "darwin" | "win32" | "linux": the context menu names Finder or Explorer by it.
  platform: process.platform,
  // Physical RAM in GB, measured by main (os.totalmem). The renderer's
  // navigator.deviceMemory clamps at 8, so an 8GB laptop and a 64GB
  // workstation looked the same to the preload budgets (utils/preload.ts) -
  // this is what tells them apart. undefined when main sent nothing.
  totalMemoryGb: readTotalMemoryGb(),
  // Opens the native OS folder dialog; resolves to an absolute host path or null.
  // `opts` ({ title, defaultPath }) is optional.
  pickFolder: (opts) => ipcRenderer.invoke("pm:pick-folder", opts),
  // Native multi-file dialog; resolves to [{ path, size }] or null when dismissed.
  pickFiles: () => ipcRenderer.invoke("pm:pick-files"),
  classifyPaths: (paths) => ipcRenderer.invoke("pm:classify-paths", paths),
  // Selects a file in Finder / Explorer / the file manager (its folder when
  // the file is gone). Resolves { ok, missing? } / { ok: false, error }.
  revealFile: (filePath) => ipcRenderer.invoke("pm:reveal-file", filePath),
  // Current photo-library folder (empty string until first-run setup picks one).
  getLibraryRoot: () => ipcRenderer.invoke("pm:get-library-root"),
  // First-run setup: pick the library folder and start the backend. Resolves
  // { ok, path } on success, { ok: false, canceled } if the picker was dismissed.
  setupLibrary: () => ipcRenderer.invoke("pm:setup-library"),
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
  // Prints a finished HTML document (the album canvas) to a PDF the user
  // picks a place for. Resolves { ok, path } / { ok: false, canceled | error }.
  exportPdf: (payload) => ipcRenderer.invoke("pm:export-pdf", payload),
  // Settings › Download backup: asks where, then resolves once the zip is
  // written - { ok, path } / { ok: false, canceled | error }.
  downloadBackup: (url) => ipcRenderer.invoke("pm:download-backup", url),
  // Report a problem › Show logs: the folder the backend and updater logs are in.
  getLogsDir: () => ipcRenderer.invoke("pm:get-logs-dir"),
  // Window chrome (macOS: the traffic lights live in the app's top bar).
  // Whether the window is fullscreen right now, and a subscription to changes;
  // the callback gets true/false, the return value unsubscribes.
  isFullScreen: () => ipcRenderer.invoke("pm:is-full-screen"),
  onFullScreen: (callback) => {
    const handler = (_event, on) => callback(Boolean(on));
    ipcRenderer.on("pm:fullscreen", handler);
    return () => ipcRenderer.removeListener("pm:fullscreen", handler);
  },
  // The page zoom factor (Cmd +/-, 1 = actual size) and a subscription to
  // changes; the top bar keeps the traffic lights' inset in native pixels.
  getZoom: () => ipcRenderer.invoke("pm:get-zoom"),
  onZoom: (callback) => {
    const handler = (_event, factor) => callback(Number(factor) || 1);
    ipcRenderer.on("pm:zoom", handler);
    return () => ipcRenderer.removeListener("pm:zoom", handler);
  },
  // Hide/show the traffic lights (focus mode takes the top bar away).
  setWindowButtonsVisible: (visible) => ipcRenderer.invoke("pm:set-window-buttons", visible),
  // View → Focus (Shift+Cmd+F) in the menu bar; the return value unsubscribes.
  onToggleFocus: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("pm:toggle-focus", handler);
    return () => ipcRenderer.removeListener("pm:toggle-focus", handler);
  },
  // The other menu-bar items (Settings…, Find, Import…, Help, About): one
  // word each, see main.js buildApplicationMenu. The return value unsubscribes.
  onMenu: (callback) => {
    const handler = (_event, command) => callback(String(command));
    ipcRenderer.on("pm:menu", handler);
    return () => ipcRenderer.removeListener("pm:menu", handler);
  },
  // The skin in force, so the shell's own paint and the native dialogs follow it.
  setTheme: (theme) => ipcRenderer.invoke("pm:set-theme", theme),
  // Dock / taskbar progress: 0-1 while a job runs, -1 clears it.
  setProgress: (fraction) => ipcRenderer.invoke("pm:set-progress", fraction),
  // The Go and Photo menus (and File → Export…) in the menu bar: one
  // { action, value? } per click, see main.js appMenuItem. Separate from onMenu
  // because these carry a value (a star count, a colour, a flag). The return
  // value unsubscribes.
  onAppMenu: (callback) => {
    const handler = (_event, msg) => {
      if (!msg || typeof msg.action !== "string") return;
      callback(msg.value === undefined ? { action: msg.action } : { action: msg.action, value: msg.value });
    };
    ipcRenderer.on("app-menu", handler);
    return () => ipcRenderer.removeListener("app-menu", handler);
  },
  // Drags the given originals out of the window to the Finder / Explorer /
  // desktop as real files. Call it from a dragstart handler (after
  // preventDefault): the OS drag has to start while the mouse is still down.
  // main.js refuses the whole drag if any path is not an existing file.
  startDrag: (paths) => ipcRenderer.send("start-drag", Array.isArray(paths) ? paths.map(String) : []),
});

// --- Files dropped on the window ----------------------------------------------
// Chromium's default for a file dropped on a page is to navigate to it: one
// stray drop of a JPEG from the Finder replaced the whole app with the photo.
// Drops that carry files are therefore taken here and handed to the page as
// absolute paths - the backend imports from paths, never from browser uploads
// - through a "pm:files-dropped" event with { paths } as its detail. Drops
// inside the app (a photo onto an album, a mask in its list) carry no files
// and are left entirely to the page's own handlers.
function droppedFiles(event) {
  const files = event.dataTransfer?.files;
  return files && files.length > 0 ? files : null;
}

document.addEventListener("dragover", (event) => {
  // Without this the drop below never fires for a file dragged in from outside;
  // only file drags are claimed, so in-app drag feedback stays the page's own.
  if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
});

document.addEventListener("drop", (event) => {
  const files = droppedFiles(event);
  // A drop zone in the page that took the files itself (and said so with
  // preventDefault - React's handlers run before this one) keeps them: the
  // same drop must not import twice.
  if (!files || event.defaultPrevented) return;
  event.preventDefault();
  const paths = [];
  for (const file of files) {
    // File.path went away in Electron 32; webUtils is the replacement. The
    // fallback only matters to a shell older than that.
    let filePath = "";
    try {
      filePath = webUtils?.getPathForFile ? webUtils.getPathForFile(file) : "";
    } catch {
      filePath = "";
    }
    if (!filePath && file.path) filePath = file.path;
    if (filePath) paths.push(filePath);
  }
  if (paths.length === 0) return;
  window.dispatchEvent(new CustomEvent("pm:files-dropped", { detail: { paths } }));
});

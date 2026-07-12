// Electron main process for the Photo Manager desktop app.
//
// Responsibilities:
//   1. Start the FastAPI backend natively as a child process, bound to
//      127.0.0.1 on a free port (dev: local .venv; packaged: bundled exe).
//   2. Point the backend at the user-chosen library folder and data folder
//      (DB + thumbnails); staging, model cache and logs stay in Electron's
//      userData (the standard app-data location).
//   3. Wait for /health, then open the window with the built React renderer.
//   4. Expose a native folder picker over IPC (the whole reason for going
//      desktop: any host path is directly readable by the native backend).

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const net = require("net");
const http = require("http");
const path = require("path");
const fs = require("fs");

// PM_DEV=1 loads the renderer from the Vite dev server instead of the built
// files (used by `npm run dev`). Backend source is always chosen by app.isPackaged.
const USE_DEV_SERVER = process.env.PM_DEV === "1";
const DEV_SERVER_URL = "http://localhost:5173";

let backendProc = null;
let apiPort = 0;
let apiBaseUrl = "";
let mainWindow = null;
let splashWindow = null;
// Absolute path to the user's photo library, chosen on first run (see
// ensureLibraryRoot).
let libraryRoot = "";
// Base folder for the database and thumbnails, also user-choosable (first run
// or Settings). Defaults to userData. Staging, model cache and logs always
// stay in userData — those are disposable system files.
let dataRoot = "";

// Small JSON config in userData that remembers the user's chosen library
// location across launches. Kept separate from the backend DB on purpose: it's
// read by the shell *before* the backend starts.
function configPath() {
  return path.join(app.getPath("userData"), "app-config.json");
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

// First-run gate: make the user pick where the photo library is stored before
// the backend starts. Returns the chosen absolute path, or null if the user
// chose to quit instead. On later launches the saved path is reused (unless it
// has since disappeared, e.g. an unplugged external drive, in which case we ask
// again).
async function ensureLibraryRoot() {
  const cfg = readConfig();
  if (cfg.libraryRoot && fs.existsSync(cfg.libraryRoot)) return cfg.libraryRoot;

  const missing = Boolean(cfg.libraryRoot); // saved but no longer present
  while (true) {
    const intro = await dialog.showMessageBox({
      type: "info",
      title: "Choose your photo library location",
      message: missing
        ? "Your photo library folder can't be found."
        : "Welcome to Photo Manager",
      detail: missing
        ? `The library was at:\n${cfg.libraryRoot}\n\nReconnect that drive/folder, or choose a new location. App data (database, thumbnails, caches) stays in the standard app-data folder.`
        : "Pick a folder where your photo library will be stored — for example a folder on an external drive or one you back up. App data (database, thumbnails, caches) is kept automatically in the standard app-data location.",
      buttons: ["Choose folder…", "Quit"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (intro.response === 1) return null;

    const picked = await dialog.showOpenDialog({
      title: "Choose your photo library folder",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Use this folder",
    });
    if (picked.canceled || picked.filePaths.length === 0) continue; // must choose

    const chosen = picked.filePaths[0];
    writeConfig({ ...readConfig(), libraryRoot: chosen });
    return chosen;
  }
}

// Where the DB + thumbnails live inside the chosen data folder. Kept in
// subfolders so a user-picked folder stays tidy and the DB never sits directly
// next to unrelated files.
function dbPathFor(root) {
  return path.join(root, "db", "library.db");
}
function thumbnailRootFor(root) {
  return path.join(root, "thumbnails");
}

// First-run companion to ensureLibraryRoot: where should the database and
// thumbnails live? Defaults to userData (the standard app-data folder); the
// user can pick e.g. an external drive instead. On later launches the saved
// choice is reused; if the saved folder disappeared we ask again. Returns the
// absolute path, or null if the user chose to quit.
async function ensureDataRoot(isFirstStart) {
  const cfg = readConfig();
  const fallback = app.getPath("userData");
  if (cfg.dataRoot && fs.existsSync(cfg.dataRoot)) return cfg.dataRoot;
  const missing = Boolean(cfg.dataRoot); // saved but no longer present

  // Existing installs (library already configured, no dataRoot saved) keep
  // their data where it is — in userData — without being prompted.
  if (!missing && !isFirstStart) return fallback;

  while (true) {
    const intro = await dialog.showMessageBox({
      type: "info",
      title: "Choose where app data is stored",
      message: missing
        ? "Your app-data folder can't be found."
        : "Where should the database and thumbnails be stored?",
      detail: missing
        ? `The database and thumbnails were at:\n${cfg.dataRoot}\n\nReconnect that drive/folder, choose a new location, or fall back to the standard app-data folder (starts with an empty library database).`
        : `The library database and thumbnail cache can live in the standard app-data folder, or in a folder you choose (e.g. next to your photo library or on a drive you back up).\n\nStandard location:\n${fallback}`,
      buttons: missing
        ? ["Choose folder…", "Use standard location", "Quit"]
        : ["Use standard location", "Choose folder…", "Quit"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    const labels = missing
      ? ["choose", "standard", "quit"]
      : ["standard", "choose", "quit"];
    const action = labels[intro.response];
    if (action === "quit") return null;
    if (action === "standard") {
      const cur = readConfig();
      delete cur.dataRoot;
      writeConfig(cur);
      return fallback;
    }

    const picked = await dialog.showOpenDialog({
      title: "Choose a folder for the database and thumbnails",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Use this folder",
    });
    if (picked.canceled || picked.filePaths.length === 0) continue;

    const chosen = picked.filePaths[0];
    writeConfig({ ...readConfig(), dataRoot: chosen });
    return chosen;
  }
}

// Best-effort move of the existing DB (and thumbnails) into a newly chosen
// data folder, so changing the location in Settings doesn't silently start an
// empty library. Called with the backend already stopped. Never overwrites a
// DB that already exists at the target (that folder was used before — reuse it).
function migrateDataRoot(oldRoot, newRoot) {
  const notes = [];
  const oldDb = dbPathFor(oldRoot);
  const newDb = dbPathFor(newRoot);
  if (fs.existsSync(newDb)) {
    notes.push("A library database already exists in the new folder and will be used as-is.");
    return notes;
  }
  if (fs.existsSync(oldDb)) {
    fs.mkdirSync(path.dirname(newDb), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = oldDb + suffix;
      if (fs.existsSync(src)) fs.copyFileSync(src, newDb + suffix);
    }
    notes.push("Your library database was copied to the new folder.");
  }
  const oldThumbs = thumbnailRootFor(oldRoot);
  const newThumbs = thumbnailRootFor(newRoot);
  if (fs.existsSync(oldThumbs) && !fs.existsSync(newThumbs)) {
    try {
      fs.cpSync(oldThumbs, newThumbs, { recursive: true });
      notes.push("Thumbnails were copied to the new folder.");
    } catch {
      notes.push("Thumbnails could not be copied — they will be rebuilt automatically.");
    }
  }
  return notes;
}

// Tiny frameless window shown from the moment the app launches until the main
// window is ready, so the user sees that something is happening while the
// backend boots (which can take a while on first start).
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 380,
    height: 200,
    frame: false,
    resizable: false,
    fullscreenable: false,
    center: true,
    icon: windowIconPath(),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, "splash.html"));
  splashWindow.on("closed", () => {
    splashWindow = null;
  });
}

function setSplashStatus(text) {
  if (!splashWindow) return;
  const js = `document.getElementById("status").textContent = ${JSON.stringify(text)};`;
  splashWindow.webContents.executeJavaScript(js).catch(() => {});
}

function closeSplash() {
  if (splashWindow) {
    splashWindow.destroy();
    splashWindow = null;
  }
}

// Icon handling: packaged builds get their icon from electron-builder
// (build/icon.png → .icns/.ico), but in dev Electron shows its default logo
// unless we set one explicitly (dock icon on macOS, window icon elsewhere).
function windowIconPath() {
  if (process.platform === "darwin") return undefined; // dock icon is set separately
  const p = path.join(__dirname, "build", "icon.png");
  return fs.existsSync(p) ? p : undefined;
}

function setDevDockIcon() {
  if (process.platform !== "darwin" || app.isPackaged || !app.dock) return;
  const p = path.join(__dirname, "build", "icon.png");
  if (fs.existsSync(p)) app.dock.setIcon(p);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function pingOnce(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Resolves with "ok" (healthy), "died" (backend process exited) or "timeout".
async function waitForHealth(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!backendProc || backendProc.exitCode !== null) return "died";
    if (await pingOnce(`${apiBaseUrl}/health`)) return "ok";
    await new Promise((r) => setTimeout(r, 500));
  }
  return "timeout";
}

function resolveBackendCommand() {
  const env = {
    ...process.env,
    PM_PORT: String(apiPort),
    PM_HOST: "127.0.0.1",
    // Staging, model cache and other system files default under userData...
    PM_DATA_DIR: app.getPath("userData"),
    // ...while the photo library, database and thumbnails live wherever the
    // user chose (each overrides just its own path in the backend config).
    LIBRARY_ROOT: libraryRoot,
    DB_PATH: dbPathFor(dataRoot),
    THUMBNAIL_CACHE_ROOT: thumbnailRootFor(dataRoot),
  };

  const isWin = process.platform === "win32";
  if (app.isPackaged) {
    // PyInstaller onedir bundle shipped via electron-builder extraResources.
    const exe = path.join(
      process.resourcesPath,
      "backend",
      isWin ? "photo-manager-backend.exe" : "photo-manager-backend"
    );
    // Point the backend at the portable exiftool staged next to it (the
    // standalone .exe on Windows, the Perl distribution elsewhere).
    env.EXIFTOOL_PATH = path.join(process.resourcesPath, "exiftool", isWin ? "exiftool.exe" : "exiftool");
    return { cmd: exe, args: [], cwd: path.dirname(exe), env };
  }

  // Dev: run from the backend source tree using its local virtualenv.
  const backendDir = path.join(__dirname, "..", "backend");
  const py = isWin
    ? path.join(backendDir, ".venv", "Scripts", "python.exe")
    : path.join(backendDir, ".venv", "bin", "python");
  return { cmd: py, args: ["run_server.py"], cwd: backendDir, env };
}

// Backend output goes to a log file in userData (a packaged app has no
// terminal, so without this a backend crash leaves nothing to diagnose).
// The previous launch's log is kept as backend.previous.log.
function backendLogPath() {
  return path.join(app.getPath("userData"), "logs", "backend.log");
}

function openBackendLogStream() {
  const logFile = backendLogPath();
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  try {
    if (fs.existsSync(logFile)) {
      fs.renameSync(logFile, path.join(path.dirname(logFile), "backend.previous.log"));
    }
  } catch {
    /* rotating is best-effort */
  }
  return fs.createWriteStream(logFile, { flags: "a" });
}

function startBackend() {
  const { cmd, args, cwd, env } = resolveBackendCommand();
  const log = openBackendLogStream();
  log.write(`[main] ${new Date().toISOString()} launching: ${cmd} ${args.join(" ")}\n`);
  backendProc = spawn(cmd, args, { cwd, env });

  backendProc.stdout.on("data", (d) => {
    process.stdout.write(`[backend] ${d}`);
    log.write(d);
  });
  backendProc.stderr.on("data", (d) => {
    process.stderr.write(`[backend] ${d}`);
    log.write(d);
  });
  backendProc.on("error", (err) => {
    log.write(`[main] failed to launch backend: ${err.message}\n`);
    dialog.showErrorBox(
      "Backend failed to start",
      `Could not launch the backend process:\n\n${cmd}\n\n${err.message}\n\nLog file:\n${backendLogPath()}`
    );
  });
  backendProc.on("exit", (code, signal) => {
    process.stderr.write(`[backend] exited (code=${code}, signal=${signal})\n`);
    log.write(`[main] backend exited (code=${code}, signal=${signal})\n`);
    log.end();
    backendProc = null;
  });
}

function stopBackend() {
  if (backendProc && backendProc.exitCode === null) {
    backendProc.kill("SIGTERM");
    backendProc = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Photo Manager",
    show: false, // shown once ready-to-show, replacing the splash without a blank flash
    icon: windowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // so preload can read additionalArguments from process.argv
      // Hand the renderer the backend URL synchronously (client.ts reads it at load).
      additionalArguments: [`--pm-api-base=${apiBaseUrl}`],
    },
  });

  if (USE_DEV_SERVER) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  }

  mainWindow.once("ready-to-show", () => {
    closeSplash();
    if (mainWindow) mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Native folder picker: the app's core new capability. Returns an absolute host
// path the native backend can read directly (no Docker mounts involved).
ipcMain.handle("pm:pick-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a photo folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Settings page: current library location, read-only.
ipcMain.handle("pm:get-library-root", () => libraryRoot);

// Settings page: pick a new library folder. The backend only reads
// LIBRARY_ROOT at launch, so after saving the new path the app relaunches
// itself (the user confirms this first).
ipcMain.handle("pm:change-library-root", async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a new photo library folder",
    defaultPath: libraryRoot || undefined,
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Use this folder",
  });
  if (picked.canceled || picked.filePaths.length === 0) return { changed: false };

  const chosen = picked.filePaths[0];
  if (chosen === libraryRoot) return { changed: false };

  const confirm = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "Change library folder",
    message: "Restart Photo Manager with the new library folder?",
    detail:
      `New location:\n${chosen}\n\n` +
      "Your photos are not moved automatically. If the new folder doesn't already " +
      "contain your library files, move them there first (or start a fresh library). " +
      "App data (database, thumbnails, caches) stays where it is.",
    buttons: ["Restart now", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (confirm.response !== 0) return { changed: false };

  writeConfig({ ...readConfig(), libraryRoot: chosen });
  app.relaunch();
  app.quit();
  return { changed: true, path: chosen };
});

// Settings page: current data folder (database + thumbnails), read-only.
ipcMain.handle("pm:get-data-root", () => dataRoot);

// Settings page: pick a new folder for the database and thumbnails. The
// backend reads DB_PATH/THUMBNAIL_CACHE_ROOT at launch only, so we stop it,
// copy the existing data over, save the choice and relaunch.
ipcMain.handle("pm:change-data-root", async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a new folder for the database and thumbnails",
    defaultPath: dataRoot || undefined,
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Use this folder",
  });
  if (picked.canceled || picked.filePaths.length === 0) return { changed: false };

  const chosen = picked.filePaths[0];
  if (chosen === dataRoot) return { changed: false };

  const confirm = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "Change app-data folder",
    message: "Restart Photo Manager with the new app-data folder?",
    detail:
      `New location:\n${chosen}\n\n` +
      "Your library database and thumbnails are copied to the new folder " +
      "(the old copies are left in place as a backup). Your photo library " +
      "folder is not affected.",
    buttons: ["Restart now", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (confirm.response !== 0) return { changed: false };

  // Stop the backend before copying so the SQLite files aren't mid-write.
  stopBackend();
  try {
    migrateDataRoot(dataRoot, chosen);
  } catch (err) {
    dialog.showErrorBox(
      "Could not copy app data",
      `Copying the database/thumbnails to the new folder failed:\n\n${err.message}\n\nThe app-data folder was not changed.`
    );
    app.relaunch();
    app.quit();
    return { changed: false };
  }
  const cfg = readConfig();
  if (chosen === app.getPath("userData")) delete cfg.dataRoot;
  else cfg.dataRoot = chosen;
  writeConfig(cfg);
  app.relaunch();
  app.quit();
  return { changed: true, path: chosen };
});

app.whenReady().then(async () => {
  setDevDockIcon();
  createSplash();

  // Block on the first-run library-location prompt before anything else - the
  // backend needs LIBRARY_ROOT set when it starts.
  const isFirstStart = !readConfig().libraryRoot;
  setSplashStatus(isFirstStart ? "Checking library folder…" : "Loading…");
  libraryRoot = await ensureLibraryRoot();
  if (!libraryRoot) {
    closeSplash();
    app.quit();
    return;
  }
  dataRoot = await ensureDataRoot(isFirstStart);
  if (!dataRoot) {
    closeSplash();
    app.quit();
    return;
  }

  apiPort = await getFreePort();
  apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  console.log(`[main] starting backend, expecting ${apiBaseUrl}`);
  // The slow-first-launch hint only makes sense when no library was configured
  // yet (true first run); on later launches a plain "Loading…" is enough.
  setSplashStatus(
    isFirstStart
      ? "Starting backend… the first launch can take a few minutes"
      : "Loading…",
  );
  startBackend();

  // First launch of a packaged build is genuinely slow (Gatekeeper scans the
  // bundle, torch imports, DB migrations run), so on timeout offer to keep
  // waiting instead of giving up — and point at the log file either way.
  let result = await waitForHealth();
  while (result !== "ok") {
    if (result === "died") {
      closeSplash();
      const choice = await dialog.showMessageBox({
        type: "error",
        title: "Backend did not start",
        message: "The Photo Manager backend stopped unexpectedly.",
        detail: `The log usually shows why:\n${backendLogPath()}`,
        buttons: ["Open log folder", "Quit"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (choice.response === 0) shell.showItemInFolder(backendLogPath());
      app.quit();
      return;
    }
    // timeout — backend is still running, just not ready yet
    const choice = await dialog.showMessageBox({
      type: "warning",
      title: "Backend is taking a while",
      message: "The Photo Manager backend is still starting.",
      detail:
        "The first launch can take several minutes (macOS verifies the app and the " +
        `image engine loads). You can keep waiting or quit.\n\nLog file:\n${backendLogPath()}`,
      buttons: ["Keep waiting", "Quit"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (choice.response !== 0) {
      closeSplash();
      app.quit();
      return;
    }
    result = await waitForHealth(120000);
  }
  console.log("[main] backend healthy — opening window");
  setSplashStatus("Loading your library…");

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", stopBackend);
process.on("exit", stopBackend);

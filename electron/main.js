// Electron main process for the Rollfilm desktop app.
//
// Responsibilities:
//   1. Start the FastAPI backend natively as a child process, bound to
//      127.0.0.1 on a free port (dev: local .venv; packaged: bundled exe).
//   2. Point the backend at the user-chosen library folder; its database,
//      thumbnails and staging live inside that folder (see libraryDataDir) so
//      each library is self-contained. Only the model cache and logs stay in
//      Electron's userData (the standard app-data location).
//   3. Wait for /health, then open the window with the built React renderer.
//   4. Expose a native folder picker over IPC (the whole reason for going
//      desktop: any host path is directly readable by the native backend).

const { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell } = require("electron");
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
// ensureLibraryRoot). The database, thumbnails and import staging live inside
// this folder (see libraryDataDir); only the model cache and logs stay in
// userData.
let libraryRoot = "";

// One-time migration for the Photo Manager -> Rollfilm rename: userData (the
// remembered library location in app-config.json, model cache, logs) used to
// live under the old app name. Move it to the new location so the rename
// doesn't look like a fresh install. The library itself is untouched - it
// lives inside the user's photo folder (.photomanager) and is found again via
// the migrated app-config.json.
function migrateRenamedUserData() {
  try {
    const appData = app.getPath("appData");
    const newDir = app.getPath("userData");
    if (fs.existsSync(path.join(newDir, "app-config.json"))) return; // already migrated
    for (const oldName of ["Photo Manager", "photo-manager-desktop"]) {
      const oldDir = path.join(appData, oldName);
      if (oldDir === newDir || !fs.existsSync(path.join(oldDir, "app-config.json"))) continue;
      if (!fs.existsSync(newDir) || fs.readdirSync(newDir).length === 0) {
        fs.rmSync(newDir, { recursive: true, force: true });
        fs.renameSync(oldDir, newDir);
      } else {
        // New dir already has content (but no config) - just carry the config over.
        fs.copyFileSync(path.join(oldDir, "app-config.json"), path.join(newDir, "app-config.json"));
      }
      return;
    }
  } catch {
    // Migration is best-effort; worst case the app asks for the library folder again.
  }
}
migrateRenamedUserData();

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
        : "Welcome to Rollfilm",
      detail: missing
        ? `The library was at:\n${cfg.libraryRoot}\n\nReconnect that drive/folder, or choose a new location. Each library carries its own database and thumbnails (in a hidden .photomanager subfolder), so pointing at a different folder switches to that library.`
        : "Pick a folder to hold your photos. The database and thumbnails live inside it, in a hidden .photomanager subfolder, so the whole library is self-contained and moves with the folder. If the folder is cloud-synced (iCloud, Dropbox, Nextcloud), exclude .photomanager from syncing - sync clients can corrupt an active database.",
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

// The DB, thumbnails and import staging live in a hidden ".photomanager"
// folder INSIDE the library folder, so each library is fully self-contained:
// photos, database and thumbnails travel together (external drive, NAS, a
// simple folder copy). Only install-type data stays in Electron's userData -
// the model cache and logs, which are disposable and shared across libraries.
//
// Caveat: if the library sits in a cloud-synced location (iCloud, Nextcloud,
// Dropbox), exclude ".photomanager" from syncing - a sync client touching a
// live SQLite file can hold locks or evict it mid-write, which hangs the
// backend and can corrupt the database. The first-run dialog says so too.
const crypto = require("crypto");

function libraryDataDir(lib) {
  return path.join(lib, ".photomanager");
}
function dbPathFor(lib) {
  return path.join(libraryDataDir(lib), "db", "library.db");
}
function thumbnailRootFor(lib) {
  return path.join(libraryDataDir(lib), "thumbnails");
}
function stagingRootFor(lib) {
  return path.join(libraryDataDir(lib), "staging");
}

// Older builds kept each library's data in userData under a per-library key
// (hash of the library's absolute path). Still used to *find* that legacy
// folder so its database/thumbnails can be moved into the library once.
function libraryKey(lib) {
  // Normalise so the same folder always hashes the same regardless of trailing
  // slash or symlink spelling; prefix with a readable basename for debuggability.
  const abs = path.resolve(lib);
  const hash = crypto.createHash("sha1").update(abs).digest("hex").slice(0, 12);
  const name = path.basename(abs).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) || "library";
  return `${name}-${hash}`;
}

// One-time migration: move a library's data from the old userData location
// back into the library's own hidden ".photomanager" folder, so existing
// ratings/tags/albums survive the switch. Best-effort: any failure leaves the
// legacy folder untouched and the app starts on a fresh DB.
function migrateLegacyLibraryData(lib) {
  const legacyDir = path.join(app.getPath("userData"), "libraries", libraryKey(lib));
  const newDir = libraryDataDir(lib);
  const legacyDb = path.join(legacyDir, "db", "library.db");
  const newDb = dbPathFor(lib);
  if (!fs.existsSync(legacyDb) || fs.existsSync(newDb)) return;

  console.log(`[main] migrating library data into the library folder: ${legacyDir} -> ${newDir}`);
  try {
    // Move the DB (plus any -wal/-shm sidecars) and the thumbnail cache.
    fs.mkdirSync(path.dirname(newDb), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = legacyDb + suffix;
      if (fs.existsSync(src)) movePath(src, newDb + suffix);
    }
    const legacyThumbs = path.join(legacyDir, "thumbnails");
    if (fs.existsSync(legacyThumbs)) movePath(legacyThumbs, thumbnailRootFor(lib));
    // Staging is transient; drop it rather than migrate.
    fs.rmSync(legacyDir, { recursive: true, force: true });
    console.log("[main] library data migrated into the library folder");
  } catch (err) {
    console.error("[main] migration into the library folder failed (starting fresh):", err);
  }
}

// rename() is fastest but fails across filesystems (EXDEV); fall back to a
// recursive copy + delete so migration works even if userData and the library
// are on different volumes.
function movePath(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
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
    // Model cache and logs are shared/disposable and default under userData...
    PM_DATA_DIR: app.getPath("userData"),
    // ...while the database, thumbnails and import staging live inside the
    // library folder itself (see libraryDataDir), so the whole library is
    // self-contained and swappable.
    LIBRARY_ROOT: libraryRoot,
    DB_PATH: dbPathFor(libraryRoot),
    THUMBNAIL_CACHE_ROOT: thumbnailRootFor(libraryRoot),
    IMPORT_STAGING_ROOT: stagingRootFor(libraryRoot),
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

// --- Quit protection while Immich uploads are running -----------------------
// The backend's upload queue is in-memory: quitting mid-sync silently drops
// whatever hasn't been uploaded yet. Closing the window therefore first asks
// the backend how much is left and, if anything is, offers: finish hidden in
// the background (app quits itself when done), quit anyway, or stay.

let forceClose = false;
let backgroundWaitTimer = null;

function fetchImmichActivity() {
  return new Promise((resolve) => {
    const req = http.get(`${apiBaseUrl}/settings/immich/activity`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

function cancelBackgroundWait() {
  if (backgroundWaitTimer) {
    clearInterval(backgroundWaitTimer);
    backgroundWaitTimer = null;
  }
}

async function confirmCloseWithSyncCheck() {
  if (!mainWindow) return;
  // Already in "finish in background" mode (window hidden): a second quit
  // request (Cmd-Q on the dock icon) means "quit for real, now" - never show
  // a dialog that would attach to an invisible window.
  if (!mainWindow.isVisible()) {
    cancelBackgroundWait();
    forceClose = true;
    mainWindow.close();
    return;
  }
  const activity = await fetchImmichActivity();
  const pending = activity ? activity.pending_uploads || 0 : 0;
  if (!mainWindow) return;
  if (pending === 0) {
    forceClose = true;
    mainWindow.close();
    return;
  }

  // In full/selective mode the startup sync loop re-uploads whatever is
  // missing, so quitting only delays the sync; in manual mode the queued
  // uploads are simply gone until the user pushes them again.
  const resumesNextRun = activity.sync_mode === "full" || activity.sync_mode === "selective";
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Immich sync is still running",
    message: `${pending} photo${pending === 1 ? " is" : "s are"} still uploading to Immich.`,
    detail: resumesNextRun
      ? "Finish in background: the window closes and the app quits by itself once the uploads are done.\n\nQuit now: the remaining uploads stop — they'll be caught up automatically the next time the app runs."
      : "Finish in background: the window closes and the app quits by itself once the uploads are done.\n\nQuit now: the remaining uploads stop and won't be retried automatically (manual sync mode) — you'd have to push them to Immich again.",
    buttons: ["Finish in background", "Quit now", "Keep app open"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });

  if (response === 2 || !mainWindow) return;
  if (response === 1) {
    forceClose = true;
    mainWindow.close();
    return;
  }

  // Finish in background: hide the window, poll until the queue drains, then
  // quit for real. Clicking the dock icon meanwhile brings the window back
  // and cancels the auto-quit (see the activate handler).
  mainWindow.hide();
  backgroundWaitTimer = setInterval(async () => {
    const current = await fetchImmichActivity();
    // A backend that stopped answering can't be uploading anymore - quit too.
    if (!current || (current.pending_uploads || 0) === 0) {
      cancelBackgroundWait();
      forceClose = true;
      if (mainWindow) mainWindow.close();
      else app.quit();
    }
  }, 5000);
}

// --- Library-disconnect watchdog --------------------------------------------
// The library (photos + its .photomanager database) can live on an external
// USB drive, and macOS unmounts those during sleep - so after standby the
// library folder can be gone while the app is still running, with the backend's
// own database yanked out from under it. Watch for that: stop the backend,
// show a waiting screen, and once the drive is mounted again restart the
// backend and reload the window. Nothing is written anywhere in between, so
// reconnecting the drive picks up exactly where the app left off.

let libraryWaiting = false;
let libraryWatchTimer = null;

function startLibraryWatchdog() {
  if (libraryWatchTimer) return;
  libraryWatchTimer = setInterval(checkLibraryMounted, 10000);
  // Check right after wake-from-sleep too - that's exactly when an external
  // drive is still remounting (or stayed behind). Small delay so a drive that
  // remounts within a few seconds never even shows the waiting screen.
  powerMonitor.on("resume", () => setTimeout(checkLibraryMounted, 3000));
}

function checkLibraryMounted() {
  if (libraryWaiting || !libraryRoot) return;
  if (fs.existsSync(libraryRoot)) return;
  libraryWaiting = true;
  console.warn(`[main] library folder disappeared: ${libraryRoot}`);

  // The backend's SQLite file lives inside the vanished folder - stop the
  // process so it can't keep writing into the void, and so the drive isn't
  // held busy when it reappears.
  stopBackend();
  if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
  if (!splashWindow) createSplash();
  setSplashStatus(
    "Photo library not found — reconnect the drive with your library to continue…"
  );

  const poll = setInterval(async () => {
    if (!fs.existsSync(libraryRoot)) return;
    clearInterval(poll);
    setSplashStatus("Library found — restarting…");
    startBackend();
    const result = await waitForHealth(120000);
    if (result === "ok") {
      closeSplash();
      if (mainWindow) {
        // Fresh load instead of surfacing whatever error state the renderer
        // fell into while the backend was gone.
        mainWindow.webContents.reload();
        mainWindow.show();
        mainWindow.focus();
      } else {
        createWindow();
      }
      libraryWaiting = false;
      return;
    }
    closeSplash();
    const choice = await dialog.showMessageBox({
      type: "error",
      title: "Backend did not restart",
      message: "The library is back, but the backend could not be restarted.",
      detail: `Quit and reopen Rollfilm. The log usually shows why:\n${backendLogPath()}`,
      buttons: ["Open log folder", "Quit"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (choice.response === 0) shell.showItemInFolder(backendLogPath());
    forceClose = true;
    app.quit();
  }, 2000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Rollfilm",
    show: false, // shown once the page has loaded (did-finish-load), replacing the splash
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

  // Window is already visible (show: true). Close the splash as soon as the
  // page loads and bring the window forward. did-finish-load is used alongside
  // ready-to-show because ready-to-show does not fire on every setup.
  const revealWindow = () => {
    closeSplash();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  };
  mainWindow.once("ready-to-show", revealWindow);
  mainWindow.webContents.once("did-finish-load", revealWindow);

  // Ask before a close that would drop running Immich uploads (see
  // confirmCloseWithSyncCheck) - forceClose marks a decision already made.
  mainWindow.on("close", (e) => {
    if (forceClose) return;
    e.preventDefault();
    confirmCloseWithSyncCheck();
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
    message: "Restart Rollfilm with the new library folder?",
    detail:
      `New location:\n${chosen}\n\n` +
      "Each library keeps its own database, thumbnails and staging inside its folder, so this " +
      "switches to the library in the new folder. If it's a folder that hasn't been used as a " +
      "library yet, a fresh empty library is started there. Your existing photo files are not " +
      "moved automatically.",
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

// Settings page: where the database, thumbnails and staging live (read-only).
// They always sit inside the current library folder, so there is nothing to
// change independently — switching the library folder moves all of it.
ipcMain.handle("pm:get-data-root", () => (libraryRoot ? libraryDataDir(libraryRoot) : ""));

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
  // The database, thumbnails and staging live inside the library folder's
  // hidden ".photomanager" subfolder (see libraryDataDir). Bring an older
  // userData-based database across on first run after the upgrade so existing
  // metadata isn't lost.
  migrateLegacyLibraryData(libraryRoot);

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
        message: "The Rollfilm backend stopped unexpectedly.",
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
      message: "The Rollfilm backend is still starting.",
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
  // From here on, watch for the library drive disappearing (sleep/eject) so a
  // wake-up without the drive shows a clear waiting screen instead of a
  // broken app whose database vanished mid-flight.
  startLibraryWatchdog();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow && !mainWindow.isVisible()) {
      // Dock click while uploads finish in the background: bring the window
      // back and cancel the pending auto-quit.
      cancelBackgroundWait();
      forceClose = false;
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", stopBackend);
process.on("exit", stopBackend);

// External termination (Ctrl-C in the dev terminal, `concurrently -k`, a parent
// exiting) arrives as a signal, and neither will-quit nor process "exit" fires
// for those - so the backend child would be orphaned and keep holding the DB
// lock, hanging the next start on the splash spinner. Stop it explicitly, then
// quit so normal teardown still runs.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    // Skip the "uploads still running" close dialog - an external kill must
    // never hang on a message box.
    forceClose = true;
    stopBackend();
    app.quit();
    process.exit(0);
  });
}

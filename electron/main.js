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

// `net` below is Node's socket module (getFreePort); Electron's own net - the
// one that can fetch file:// and http:// for the rf:// handler - comes in under
// an explicit name so the two can't be confused.
const {
  Menu,
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net: electronNet,
  powerMonitor,
  protocol,
  shell,
} = require("electron");
const { pathToFileURL } = require("url");
const { initAutoUpdate } = require("./updater");
const { spawn, spawnSync } = require("child_process");
const net = require("net");
const http = require("http");
const path = require("path");
const fs = require("fs");

// PM_DEV=1 loads the renderer from the Vite dev server instead of the built
// files (used by `npm run dev`). Backend source is always chosen by app.isPackaged.
const USE_DEV_SERVER = process.env.PM_DEV === "1";
const DEV_SERVER_URL = "http://localhost:5173";

// Grid thumbnails and lightbox previews are served to the renderer over our own
// rf:// scheme instead of over the backend's HTTP port. The reason is a hard
// browser limit, not a micro-optimisation: Chromium opens at most six
// concurrent HTTP/1.1 connections per origin, so no matter how many tiles the
// grid's look-ahead wants, only six could ever be in flight - and on a 4K
// screen at the dense sizes there are several hundred. Every one of them also
// cost a FastAPI request with a database session and an ownership query, for a
// file whose path follows from the image id alone.
//
// This must run before app.whenReady(). `standard` gives the URLs normal
// origin/path parsing, `stream` lets a response body be piped rather than
// buffered, and `supportFetchAPI`/`corsEnabled` keep them usable from renderer
// code rather than only as an <img src>.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "rf",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

let backendProc = null;
let apiPort = 0;
let apiBaseUrl = "";
let mainWindow = null;
let splashWindow = null;

// A second instance would spawn a second backend against the same library
// (database lock fights) and leave processes behind that block the Windows
// updater from replacing the install dir. Hand the launch over to the
// already-running instance instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      // Same as a dock/taskbar activate: if the window is hidden finishing
      // background uploads, bring it back and cancel the pending auto-quit.
      if (!mainWindow.isVisible()) {
        cancelBackgroundWait();
        forceClose = false;
        mainWindow.show();
      }
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
// Absolute path to the user's photo library, chosen on first run (see
// ensureLibraryRoot). The database, thumbnails and import staging live inside
// this folder (see libraryDataDir); only the model cache and logs stay in
// userData.
let libraryRoot = "";
// True when this launch is a genuine first run (no library folder was
// configured yet). The renderer reads it (pm:is-first-run) to decide whether to
// show the first-start onboarding wizard.
let firstRunThisSession = false;

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

// --- Leftover files from the Photo Manager -> Rollfilm rename ----------------
// The rename migration (above) brings the *config* across but, when the new
// userData folder already exists, leaves the old app-data folders sitting in
// place. They're dead weight — model caches and logs from the previous name —
// so the first-start wizard offers to delete them. Detection and removal both
// go through these helpers.
const LEGACY_APP_DIR_NAMES = ["Photo Manager", "photo-manager-desktop"];

function legacyUserDataDirs() {
  const dirs = [];
  try {
    const appData = app.getPath("appData");
    const current = app.getPath("userData");
    for (const name of LEGACY_APP_DIR_NAMES) {
      const dir = path.join(appData, name);
      if (dir !== current && fs.existsSync(dir)) dirs.push(dir);
    }
  } catch {
    // Best-effort: if appData can't be resolved, report nothing to clean.
  }
  return dirs;
}

// Total size of a folder in bytes (iterative walk so a deep tree can't blow the
// stack). Best-effort: unreadable entries are skipped rather than throwing, so
// a partial number is still shown instead of failing the whole scan.
function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      try {
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
      } catch {
        // Skip entries that vanish or can't be stat'd mid-walk.
      }
    }
  }
  return total;
}

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

// --- rf:// derivative serving ----------------------------------------------
//
// rf://derivative/<image-id>/<file>?v=…&cb=… -> the cached derivative on disk,
// falling back to the backend when it isn't there yet.

// The derivatives that are plain cached files, mapped to the API route that
// produces one when it's missing. Deliberately an allowlist: it is also the
// path-traversal guard, and it keeps renders OFF this route - full.jpg and
// base-preview are generated per request by the backend and have no business
// being read straight off disk.
const RF_DERIVATIVES = new Map([
  ["small.jpg", "thumbnail?size=small"],
  ["thumbnail.jpg", "thumbnail"],
  ["preview.jpg", "preview"],
]);

// What may stand in for a tier that hasn't been derived yet, best first.
//
// small.jpg and thumbnail.jpg are the same picture at different sizes, so a
// missing tier must never make anyone WAIT: a library predating the tier has
// none of them, and deriving one costs a read, a resize and a write on the
// library's disk, per tile. Putting that on the path of tiles scrolling into
// view is what made jumping around the grid leave cards grey for seconds -
// every fresh region paid it again, through the very HTTP path this scheme
// exists to avoid.
//
// Serving the next size up is instant and looks identical - it is exactly what
// the grid got before the tier existed. The proper tier is then warmed in the
// background (see warmTier) so the next visit gets the cheaper decode.
const RF_TIER_FALLBACKS = new Map([
  ["small.jpg", ["small.jpg", "thumbnail.jpg"]],
  ["thumbnail.jpg", ["thumbnail.jpg"]],
  // The lightbox preview has no larger sibling to borrow from; a miss there
  // goes to the backend, which renders it.
  ["preview.jpg", ["preview.jpg"]],
]);

// Deriving the real tier for images that were served a stand-in. Deliberately
// throttled and deduplicated: a scrubber drag can sweep thousands of tiles, and
// firing a request per tile would rebuild the very queue this is meant to keep
// off the user's path. Nothing waits on any of it - the picture is already on
// screen - so it can afford to trickle.
const warmQueue = [];
const warmQueued = new Set();
let warmActive = 0;
const WARM_MAX_CONCURRENT = 2;
const WARM_MAX_QUEUED = 200;

function pumpWarmQueue() {
  while (warmActive < WARM_MAX_CONCURRENT && warmQueue.length > 0) {
    const url = warmQueue.shift();
    warmQueued.delete(url);
    warmActive += 1;
    electronNet
      .fetch(url)
      // Read the body so the backend isn't left writing into a dropped socket.
      .then((res) => res.arrayBuffer())
      .catch(() => {})
      .finally(() => {
        warmActive -= 1;
        pumpWarmQueue();
      });
  }
}

function warmTier(imageId, apiRoute) {
  if (!apiBaseUrl) return;
  const url = `${apiBaseUrl}/images/${imageId}/${apiRoute}`;
  if (warmQueued.has(url)) return;
  // Drop the oldest rather than grow without bound: the newest requests are for
  // where the user actually is.
  if (warmQueue.length >= WARM_MAX_QUEUED) warmQueued.delete(warmQueue.shift());
  warmQueue.push(url);
  warmQueued.add(url);
  pumpWarmQueue();
}

// Image ids are generated identifiers; anything else cannot address a real
// derivative and must not reach path.join.
const RF_IMAGE_ID = /^[A-Za-z0-9_-]+$/;

// Version-stamped URLs (?v= edit revision, ?cb= global rebuild token), so a
// given URL's bytes never change - the same contract the HTTP route promises,
// and what lets a scrolled-back grid area paint without touching the disk again.
const RF_CACHE_CONTROL = "private, max-age=31536000, immutable";

// Ceiling on a single backend request for a derivative that isn't on disk.
// Above the grid's 1.5s budget on purpose: reaching this path at all means
// there are no pixels anywhere to meet that budget with, and a cheap derivation
// (downscaling an existing thumbnail) finishes in milliseconds. What this
// prevents is the other end - one stuck render holding a connection open
// indefinitely.
const RF_BACKEND_DEADLINE_MS = 2000;

async function serveDerivative(request) {
  const url = new URL(request.url);
  // "/<image-id>/<file>" -> ["", "<image-id>", "<file>"]
  const [, imageId, file] = url.pathname.split("/");
  const apiRoute = RF_DERIVATIVES.get(file);
  if (!apiRoute || !imageId || !RF_IMAGE_ID.test(imageId)) {
    return new Response("Not found", { status: 404 });
  }

  if (libraryRoot) {
    const dir = path.join(thumbnailRootFor(libraryRoot), imageId);
    for (const candidate of RF_TIER_FALLBACKS.get(file) ?? [file]) {
      try {
        // A missing file surfaces as a rejection on some platforms and as a
        // non-ok response on others; both mean the same thing here.
        const fromDisk = await electronNet.fetch(pathToFileURL(path.join(dir, candidate)).toString());
        if (!fromDisk.ok) continue;
        const exact = candidate === file;
        // A stand-in must NOT be cached under the requested tier's URL. That URL
        // is version-stamped and served immutable, so caching the larger file
        // against it would pin the oversized decode for a year - the tier would
        // be derived in the background and never actually used.
        if (!exact) warmTier(imageId, apiRoute);
        return new Response(fromDisk.body, {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "cache-control": exact ? RF_CACHE_CONTROL : "no-store",
          },
        });
      } catch {
        // Try the next size up.
      }
    }
  }

  // The fallback is the whole reason this is safe to put in front of every
  // tile. A derivative legitimately may not exist: right after an import the
  // background worker is still generating them, and an older library predates
  // the downscaled tiers entirely. Handing those requests to the backend keeps
  // on-demand generation, its render-slot shedding (503 + Retry-After) and the
  // grid's retry ladder working exactly as before - the disk read above is only
  // a shortcut for the case that is already settled, which is nearly all of them.
  if (!apiBaseUrl) return new Response("Backend not ready", { status: 503 });
  const separator = apiRoute.includes("?") ? "&" : "?";
  const query = url.search ? `${separator}${url.search.slice(1)}` : "";
  try {
    return await electronNet.fetch(`${apiBaseUrl}/images/${imageId}/${apiRoute}${query}`, {
      // A hard ceiling on how long one tile may hold out for the backend. This
      // path only runs when the photo has no derivative on disk at all, so it
      // is already outside what any budget can promise - but "we cannot show it
      // yet" must still come back promptly. Left hanging, a single stuck render
      // pins one of the renderer's connections and takes its neighbours down
      // with it; answering keeps the grid's retry moving instead.
      signal: AbortSignal.timeout(RF_BACKEND_DEADLINE_MS),
    });
  } catch (err) {
    console.warn(`[main] rf:// fallback failed for ${imageId}/${file}: ${err.message}`);
    // Retry-After matches the grid's own fast retry (see RETRY_DELAYS_MS): the
    // photo is being generated, so coming back shortly is the right move.
    return new Response("Not available", { status: 503, headers: { "retry-after": "1" } });
  }
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
    // Landscape rather than the near-square it used to be: still tall enough
    // for logo + spinner + title + version + a two-line status inside the
    // wrap's padding (that content is ~205px), but no taller. Trimming this
    // without also trimming splash.html makes the centred flex column
    // overflow both edges and glues the logo to the top.
    height: 264,
    frame: false,
    resizable: false,
    fullscreenable: false,
    center: true,
    icon: windowIconPath(),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // The splash shows the app version next to the logo; loadFile's query is the
  // one channel available before the page has loaded.
  splashWindow.loadFile(path.join(__dirname, "splash.html"), {
    query: { v: app.getVersion() },
  });
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
    if (process.platform === "win32") {
      // kill() is TerminateProcess on Windows: the backend's own children
      // (exiftool -stay_open) survive it, keep holding files in the install
      // dir, and the NSIS updater then fails to remove the old version
      // ("error uninstalling, retry"). /T takes down the whole tree.
      try {
        spawnSync("taskkill", ["/pid", String(backendProc.pid), "/T", "/F"], { windowsHide: true });
      } catch {
        backendProc.kill();
      }
    } else {
      backendProc.kill("SIGTERM");
    }
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

function fetchBackgroundActivity() {
  return new Promise((resolve) => {
    const req = http.get(`${apiBaseUrl}/maintenance/background-activity`, (res) => {
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

// Everything still working after the screen that started it is gone: photos
// being uploaded to Immich, thumbnails an import couldn't hand over ready-made,
// the search index catching up, a library being merged in. Quitting mid-way
// isn't destructive - all of it resumes on the next start - but doing it
// silently leaves a library that looks half-finished for no visible reason.
async function outstandingWork() {
  const [immich, background] = await Promise.all([
    fetchImmichActivity(),
    fetchBackgroundActivity(),
  ]);
  const uploads = immich ? immich.pending_uploads || 0 : 0;
  const derivatives = background ? background.derivatives_pending || 0 : 0;
  const embeddings = Boolean(background && background.embeddings_running);
  const merging = Boolean(background && background.merge_active);
  const parts = [];
  if (uploads > 0) parts.push(`${uploads} photo${uploads === 1 ? "" : "s"} uploading to Immich`);
  if (merging) parts.push("a library being imported");
  if (derivatives > 0) parts.push(`${derivatives} thumbnail${derivatives === 1 ? "" : "s"} to render`);
  if (embeddings) parts.push("the search index catching up");
  return { immich, uploads, derivatives, embeddings, merging, parts, busy: parts.length > 0 };
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
  const work = await outstandingWork();
  if (!mainWindow) return;
  if (!work.busy) {
    forceClose = true;
    mainWindow.close();
    return;
  }

  // Only Immich uploads in manual mode are actually lost by quitting - they
  // are not retried until the user pushes them again. Everything else (the
  // renders, the search index, a merge) is picked up automatically on the next
  // start, so "quit now" costs time, not work.
  const manualUploadsLost =
    work.uploads > 0 && work.immich && work.immich.sync_mode === "manual";
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Rollfilm is still working",
    message: `Still running: ${work.parts.join(", ")}.`,
    detail: manualUploadsLost
      ? "Finish in background: the window closes and the app quits by itself once it's done.\n\nQuit now: the remaining work stops. The renders and the search index are caught up automatically next time, but the queued Immich uploads are not (manual sync mode) — you'd have to push them again."
      : "Finish in background: the window closes and the app quits by itself once it's done.\n\nQuit now: the remaining work stops — it's picked up again automatically the next time the app runs. Your photos and edits are already saved either way.",
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
    const current = await outstandingWork();
    // A backend that stopped answering can't be working anymore - quit too
    // (outstandingWork reads that as nothing outstanding).
    if (!current.busy) {
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


// --- View zoom ---------------------------------------------------------------
// The whole UI scales with the usual Cmd/Ctrl +, - and 0. These are zoom
// LEVELS, not factors - the factor is 1.2^level, so half a level is the same
// increment Chrome and Electron's own zoom roles step by. Clamped at both ends:
// held-down keys stop at half size and roughly double, past which the toolbar
// stops fitting the window. Cmd-0 is the way back from either end.
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -4; // ~ 48 %
const ZOOM_MAX = 4; // ~ 207 %

function zoomBy(contents, delta) {
  if (!contents || contents.isDestroyed()) return;
  const level = delta === 0 ? 0 : contents.getZoomLevel() + delta;
  contents.setZoomLevel(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level)));
}

// Menu items zoom whichever window is focused, falling back to the main one
// (the menu is alive while a dialog holds focus, and browserWindow is undefined
// then).
function zoomMenuItem(label, accelerator, delta) {
  return {
    label,
    accelerator,
    click: (_item, browserWindow) => zoomBy((browserWindow || mainWindow)?.webContents, delta),
  };
}

// Off-menu accelerators: the unshifted Cmd-= that browsers accept for zoom in,
// and the numeric keypad's +/-/0. Hidden entries, present only to register the
// keys - macOS still takes accelerators from invisible items.
function hiddenZoomItem(label, accelerator, delta) {
  return { ...zoomMenuItem(label, accelerator, delta), visible: false };
}

// Windows and Linux have no menu bar to hang the accelerators on (see below), so
// the same keys come off the renderer's input stream instead. Only registered
// there, or macOS would zoom twice per keypress.
function attachZoomShortcuts(contents) {
  if (process.platform === "darwin") return;
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.control || input.alt || input.meta) return;
    const delta =
      input.key === "+" || input.key === "=" ? ZOOM_STEP
      : input.key === "-" ? -ZOOM_STEP
      : input.key === "0" ? 0
      : null;
    if (delta === null) return;
    zoomBy(contents, delta);
    event.preventDefault();
  });
}

// --- Application menu --------------------------------------------------------
// Rollfilm carries its own bar inside the window (nav, search, Settings,
// Help), so the OS menu is pure duplication - and Electron's default one is
// worse than empty: it advertises electronjs.org and offers Reload, Force
// Reload and Toggle DevTools, none of which mean anything while sorting photos
// and one of which (a stray Cmd-R mid-import) is actively unhelpful.
//
// On Windows and Linux the menu bar can go entirely. On macOS it cannot: the
// app-name menu belongs to the system, and every app has one - what an app can
// decide is what sits NEXT to it, which here is View - Zoom In, Zoom Out and
// Actual Size, the one thing the window itself has no control for. Edit is kept
// but hidden, because macOS takes the clipboard shortcuts from the menu: drop it
// and Cmd-C/V/X/A stop working in every text field in the app (search, tags,
// the Immich key).
function buildApplicationMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu", visible: false },
      {
        label: "View",
        submenu: [
          zoomMenuItem("Zoom In", "CommandOrControl+Plus", ZOOM_STEP),
          zoomMenuItem("Zoom Out", "CommandOrControl+-", -ZOOM_STEP),
          zoomMenuItem("Actual Size", "CommandOrControl+0", 0),
          hiddenZoomItem("Zoom In", "CommandOrControl+=", ZOOM_STEP),
          hiddenZoomItem("Zoom In", "CommandOrControl+numadd", ZOOM_STEP),
          hiddenZoomItem("Zoom Out", "CommandOrControl+numsub", -ZOOM_STEP),
          hiddenZoomItem("Actual Size", "CommandOrControl+num0", 0),
        ],
      },
    ])
  );
}

// --- Links that leave the app --------------------------------------------
// A link pointing outside the app belongs to the OS, and Electron's defaults
// get both halves of that wrong. A target="_blank" link opens a second,
// chrome-less BrowserWindow - a browser with no address bar, no back button
// and this app's preload attached. And a plain navigation to mailto: is
// dropped on the floor, because the renderer can't load a scheme it has no
// handler for: the Contact icon would simply do nothing.
//
// So external URLs are handed to the system handler (default browser, default
// mail client) and the in-app navigation is refused. Two addresses are http://
// but are *not* external and must keep loading in place: the dev server, and
// the bundled backend the UI links straight at for the backup download.
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function isOwnOrigin(parsed, base) {
  try {
    return !!base && new URL(base).origin === parsed.origin;
  } catch {
    return false;
  }
}

function openExternally(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!EXTERNAL_SCHEMES.has(parsed.protocol)) return false;
  if (isOwnOrigin(parsed, apiBaseUrl)) return false;
  if (USE_DEV_SERVER && isOwnOrigin(parsed, DEV_SERVER_URL)) return false;
  shell.openExternal(rawUrl);
  return true;
}

function routeExternalLinksToTheOS(webContents) {
  webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    if (openExternally(url)) event.preventDefault();
  });
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

  attachZoomShortcuts(mainWindow.webContents);
  routeExternalLinksToTheOS(mainWindow.webContents);

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

// Native multi-file picker for "Choose files…". Returns [{ path, size }] so
// the renderer can stage the picked files through the same incremental
// path-import pipeline as a folder import (no browser upload) - sizes feed the
// byte-based progress the staging loop reports. Null when dismissed.
ipcMain.handle("pm:pick-files", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose photos",
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Photos",
        extensions: [
          "jpg", "jpeg", "png",
          "cr2", "cr3", "nef", "arw", "dng", "raf", "orf", "rw2", "pef", "srw",
        ],
      },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths.map((p) => {
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {
      // Unreadable file: stage anyway; the backend reports the real error.
    }
    return { path: p, size };
  });
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

// First-start wizard: was this launch a genuine first run (no library folder
// configured yet)? Drives whether the onboarding wizard appears.
ipcMain.handle("pm:is-first-run", () => firstRunThisSession);

// First-start wizard, "Clean up" step: leftover app-data folders from the old
// Photo Manager / photo-manager-desktop app names, with their sizes so the
// wizard can say how much space removing them frees.
ipcMain.handle("pm:scan-legacy-data", () =>
  legacyUserDataDirs().map((p) => ({ path: p, sizeBytes: dirSizeBytes(p) }))
);

// First-start wizard, "Clean up" step: delete those leftover folders. Reports
// what was removed and what couldn't be (e.g. a permissions error) so the
// wizard can show an honest result rather than claiming success blindly.
ipcMain.handle("pm:remove-legacy-data", () => {
  const removed = [];
  const failed = [];
  for (const dir of legacyUserDataDirs()) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (err) {
      failed.push({ path: dir, error: err.message });
    }
  }
  return { removed, failed };
});

// First-run setup: the onboarding wizard's library step calls this to pick the
// library folder in-app, replacing the old native "choose your library" message
// box. It writes the choice, then starts the backend for the first time (this
// launch had none, since no LIBRARY_ROOT was known) and waits until it's
// healthy. On success the renderer reloads into the full app and the wizard
// carries on with the remaining steps.
ipcMain.handle("pm:setup-library", async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: "Choose your photo library folder",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Use this folder",
  });
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };

  const chosen = picked.filePaths[0];
  writeConfig({ ...readConfig(), libraryRoot: chosen });
  libraryRoot = chosen;
  // Bring an older userData-based database across so existing metadata isn't
  // lost when an upgrader points at a folder used by a legacy build.
  migrateLegacyLibraryData(chosen);

  const healthy = await startBackendAndWait(true);
  if (!healthy) {
    app.quit();
    return { ok: false };
  }
  // The library exists now, so start watching for it disappearing (eject/sleep).
  startLibraryWatchdog();
  return { ok: true, path: chosen };
});

// Start the backend and wait until /health answers, surfacing the same
// keep-waiting / crash dialogs the slow first launch needs. Returns true once
// the backend is healthy, false when the user chose to quit (the caller then
// quits). Shared by the normal boot path and the first-run library setup.
async function startBackendAndWait(isFirstStart) {
  console.log(`[main] starting backend, expecting ${apiBaseUrl}`);
  setSplashStatus(
    isFirstStart
      ? "Starting backend… the first launch can take a few minutes"
      : "Loading…"
  );
  startBackend();

  // First launch of a packaged build is genuinely slow (Gatekeeper scans the
  // bundle, torch imports, DB migrations run), so on timeout offer to keep
  // waiting instead of giving up — and point at the log file either way.
  let result = await waitForHealth();
  while (result !== "ok") {
    closeSplash();
    if (result === "died") {
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
      return false;
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
    if (choice.response !== 0) return false;
    result = await waitForHealth(120000);
  }
  console.log("[main] backend healthy");
  return true;
}

function registerActivateHandler() {
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
}

app.whenReady().then(async () => {
  setDevDockIcon();
  buildApplicationMenu();
  createSplash();

  const isFirstStart = !readConfig().libraryRoot;
  firstRunThisSession = isFirstStart;

  // The renderer reads the backend URL the moment it loads, so the port must be
  // known before any window opens — including the first-run setup window, which
  // comes up before the backend has even started.
  apiPort = await getFreePort();
  apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  // After apiBaseUrl (the handler's fallback target) and before any window, so
  // no renderer can ever request a derivative the scheme can't answer yet. The
  // handler reads `libraryRoot` per request rather than capturing it - on a
  // first run it is still empty here and gets set by the onboarding wizard.
  protocol.handle("rf", serveDerivative);
  registerActivateHandler();

  // Update checks run detached from startup (first one after a delay, see
  // updater.js) - they must never delay the splash/window flow here.
  initAutoUpdate({
    getMainWindow: () => mainWindow,
    // quitAndInstall must not be intercepted by the "uploads still running"
    // close dialog - the user already chose to restart.
    allowQuit: () => {
      forceClose = true;
    },
    // The NSIS installer can only replace files nothing is holding open, and
    // the backend (plus its exiftool workers) lives inside the install dir.
    stopBackend,
  });

  if (isFirstStart) {
    // First run: instead of a native "choose your library" message box, open the
    // window right away and let the in-app onboarding wizard ask for the folder
    // (pm:setup-library). The backend isn't started yet — it has no
    // LIBRARY_ROOT — so the renderer shows the library-setup screen (which makes
    // no API calls) until the user picks a folder, which then starts the backend.
    setSplashStatus("Loading…");
    createWindow();
    return;
  }

  // Returning user: make sure the saved library is reachable (native reconnect
  // prompt if the drive is unplugged), then boot the backend before the window.
  setSplashStatus("Loading…");
  libraryRoot = await ensureLibraryRoot();
  if (!libraryRoot) {
    closeSplash();
    app.quit();
    return;
  }
  // The database, thumbnails and staging live inside the library folder's hidden
  // ".photomanager" subfolder (see libraryDataDir). Bring an older userData-based
  // database across on first run after the upgrade so existing metadata isn't lost.
  migrateLegacyLibraryData(libraryRoot);

  const healthy = await startBackendAndWait(false);
  if (!healthy) {
    closeSplash();
    app.quit();
    return;
  }
  console.log("[main] backend healthy — opening window");
  setSplashStatus("Loading your library…");

  createWindow();
  // From here on, watch for the library drive disappearing (sleep/eject) so a
  // wake-up without the drive shows a clear waiting screen instead of a broken
  // app whose database vanished mid-flight.
  startLibraryWatchdog();
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

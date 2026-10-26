// Auto-update for the packaged desktop app, fed by the GitHub releases the
// build workflow publishes (electron/package.json "publish" points at the
// repo; electron-builder bakes that into the bundle as app-update.yml).
//
// On all three platforms a new version is announced first, with what it
// brings, and downloads only once the user says "Update"; a small "restart
// now?" prompt then applies it - and the download is only what
// changed: electron-updater compares the block map of the release with the
// one of the version it has and fetches the blocks that differ (some tens of
// MB of an installer of several hundred).
//
//   Windows / Linux — electron-updater start to finish. Both targets (NSIS,
//   AppImage) support unsigned self-replacement.
//
//   macOS — electron-updater for the check and the download, our own code for
//   the install. Its mac path hands the downloaded zip to Squirrel.Mac, and
//   Squirrel refuses to swap an app bundle that isn't code-signed; the mac
//   build ships unsigned (identity: null). Nothing stops the app from
//   unpacking the zip itself and trading the bundle once it has quit, though:
//   a file the app downloaded carries no quarantine flag, so Gatekeeper has
//   nothing to say about the new bundle.
//
//   Where that can't work - the app runs from the disk image or from
//   Gatekeeper's translocation mount, its folder isn't writable, or a swap
//   was tried and didn't take - the mac falls back to notify-only: check the
//   GitHub API for a newer tag and offer to open the release page.
//
// Everything here is fire-and-forget: update checks must never block startup,
// and a failed check (offline, rate-limited, GitHub down) is logged and
// otherwise invisible - the app simply stays on its current version.

const { app, dialog, ipcMain, shell } = require("electron");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const util = require("util");

const REPO = "pasqualkreher/rollfilm";
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

// First check shortly after startup (the window is up by then, and a dialog
// with no window to attach to still works); then periodically, for the
// "leave it running for weeks" case.
const FIRST_CHECK_DELAY_MS = 15 * 1000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// A prompt about a version shows once per run - re-prompting every 6 hours
// about the same release would just be nagging.
let promptedVersion = null;

/**
 * hooks:
 *   getMainWindow() -> BrowserWindow | null   dialog parent (may be null)
 *   allowQuit()                               bypass the "Immich uploads still
 *                                             running" close interception so
 *                                             quitAndInstall isn't blocked
 *   stopBackend()                             kill the backend (and its
 *                                             exiftool workers) before the
 *                                             installer starts - see below
 */
function initAutoUpdate(hooks) {
  // Dev runs update against nothing; the version is meaningless there.
  if (!app.isPackaged) return;
  registerNoticeIpc();

  if (process.platform === "darwin") {
    initMacUpdater(hooks);
    return;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    log.warn("electron-updater unavailable:", err.message);
    return;
  }
  // Even if the user picks "Later", the downloaded update applies on the next
  // normal quit - so "Later" still updates, just without the forced restart.
  autoUpdater.autoInstallOnAppQuit = true;
  runUpdater(autoUpdater, hooks);
}

// --- Log --------------------------------------------------------------------

// Whether an update came as a delta or as the whole file, and why one didn't
// install, is only ever visible here: logs/updater.log next to backend.log.
// electron-updater writes its own progress through the same four methods.
const log = (() => {
  let stream = null;
  const open = () => {
    if (stream) return stream;
    const file = path.join(app.getPath("userData"), "logs", "updater.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // One file that never grows past a few runs' worth.
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) {
        fs.renameSync(file, path.join(path.dirname(file), "updater.previous.log"));
      }
    } catch {
      /* no log yet */
    }
    stream = fs.createWriteStream(file, { flags: "a" });
    stream.on("error", () => {});
    return stream;
  };
  const write = (level, args) => {
    let line = util.format(...args);
    // electron-updater's debug output is the whole operation list of a delta
    // download (thousands of lines) and then every range request: cut the
    // list, and keep all of it out of main.log.
    if (line.length > 2000) line = `${line.slice(0, 160).replace(/\s+/g, " ")}… (${line.length} chars)`;
    if (level !== "debug") (level === "info" ? console.log : console.warn)(`[updater] ${line}`);
    try {
      open().write(`${new Date().toISOString()} ${level} ${line}\n`);
    } catch {
      /* a log that can't be written must not take the updater down */
    }
  };
  return {
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    debug: (...args) => write("debug", args),
  };
})();

// --- The part all platforms share --------------------------------------------

function runUpdater(updater, hooks) {
  updater.logger = log;
  // Nothing downloads until the user says so: a new version is announced with
  // what it brings, and "Update" starts the download.
  updater.autoDownload = false;

  // Asked once per version and run; "Not now" asks again on the next start.
  let askedVersion = null;
  // The version whose download the in-app sheet is following.
  let sheetDownload = null;

  // The download with its retries; at the end "failed - try again?".
  const download = async (info) => {
    const follows = () => sheetDownload === info.version;
    const result = await downloadWithRetry(updater, hooks, info, follows);
    if (result === "done") return;
    if (follows()) sheetDownload = null;
    if (result === "cancelled") {
      tellInApp(hooks, { state: "closed", version: info.version });
      return;
    }
    const reason = errorReason(result);
    let action = await askInApp(hooks, { state: "failed", mode: "self", version: info.version, reason });
    if (action === null) {
      const win = hooks.getMainWindow();
      const { response } = await dialog.showMessageBox(win ?? null, {
        type: "warning",
        title: "Update download failed",
        message: `Rollfilm ${info.version} could not be downloaded.`,
        detail: `${reason}\n\nTry again now, or later: the update is offered again on the next start.`,
        buttons: ["Try again", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      action = response === 0 ? "download" : "dismiss";
    } else if (action === "download") {
      sheetDownload = info.version;
    }
    if (action === "download") download(info);
  };

  updater.on("update-available", async (info) => {
    if (askedVersion === info.version) return;
    askedVersion = info.version;
    const notes = await releaseNotesMarkdown(info);
    let action = await askInApp(hooks, { state: "available", mode: "self", version: info.version, notes });
    if (action === null) {
      // No sheet: the native dialog, as before.
      const win = hooks.getMainWindow();
      const { response } = await dialog.showMessageBox(win ?? null, {
        type: "info",
        title: "Update available",
        message: `Rollfilm ${info.version} is available (you have ${app.getVersion()}).`,
        detail: withNotes(
          releaseNotesOf(info),
          "Update downloads it in the background; you are asked before the app restarts."
        ),
        buttons: ["Update", "Not now"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      action = response === 0 ? "download" : "dismiss";
    } else if (action === "download") {
      sheetDownload = info.version;
    }
    if (action !== "download") return;
    download(info);
  });

  // Progress: the Dock (taskbar) bar always, the sheet when it is following
  // the download - with the rate over the last minute and the time that
  // leaves, since a delta download from GitHub is hundreds of small range
  // requests and the percent alone can sit still for a while.
  updater.on("download-progress", (progress) => {
    const percent = Math.max(0, Math.min(100, Math.floor(Number(progress?.percent) || 0)));
    setDockProgress(hooks, percent / 100);
    const d = activeDownload;
    if (!d) return;
    d.percent = percent;
    d.transferred = Number(progress?.transferred) || 0;
    d.total = Number(progress?.total) || 0;
    d.rate.add(d.transferred);
    if (sheetDownload !== d.version) return;
    const now = Date.now();
    if (percent === d.sentPercent && now - d.sentAt < 2000) return;
    d.sentPercent = percent;
    d.sentAt = now;
    const rate = d.rate.perSecond();
    tellInApp(hooks, {
      state: "downloading",
      mode: "self",
      version: d.version,
      percent,
      transferred: d.transferred,
      total: d.total,
      bytesPerSecond: rate,
      etaSeconds: rate > 0 && d.total > d.transferred ? Math.round((d.total - d.transferred) / rate) : null,
    });
  });

  updater.on("error", (err) => {
    // Expected offline noise, not a user-facing problem.
    log.warn("update check failed:", err == null ? "unknown" : err.message);
  });

  updater.on("update-downloaded", async (info) => {
    setDockProgress(hooks, -1);
    if (promptedVersion === info.version) return;
    promptedVersion = info.version;
    if (sheetDownload === info.version) sheetDownload = null;
    const notes = await releaseNotesMarkdown(info);
    let action = await askInApp(hooks, { state: "ready", mode: "self", version: info.version, notes });
    if (action === null) {
      const win = hooks.getMainWindow();
      const { response } = await dialog.showMessageBox(win ?? null, {
        type: "info",
        title: "Update ready",
        message: `Rollfilm ${info.version} has been downloaded.`,
        detail: "Restart now to update, or keep working - the update installs by itself the next time you quit.",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      action = response === 0 ? "restart" : "dismiss";
    }
    if (action !== "restart") return;
    // The close handler intercepts quits while Immich uploads are pending;
    // the user just chose to restart, so that decision is already made.
    hooks.allowQuit();
    // quitAndInstall() spawns the installer FIRST and quits afterwards, so the
    // backend would still be holding files in the install dir when NSIS starts
    // replacing them. Take it down here, before the installer exists - the
    // taskkill in build/installer.nsh stays as the safety net for the
    // "install on next quit" path and for orphans from an earlier crash.
    try {
      hooks.stopBackend?.();
    } catch (err) {
      log.warn("stopping backend before install failed:", err.message);
    }
    updater.quitAndInstall();
  });

  const check = () =>
    updater.checkForUpdates().catch((err) => {
      log.warn("update check failed:", err.message);
    });

  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, RECHECK_INTERVAL_MS).unref?.();
}

// --- The download: retries, progress, what the quit dialog sees -------------------

// The download in flight, or null: { version, percent, transferred, total,
// token, cancelled, rate, wake }. main.js asks for it before the app quits.
let activeDownload = null;

function updateDownloadState() {
  const d = activeDownload;
  if (!d) return null;
  return {
    version: d.version,
    percent: d.percent,
    transferred: d.transferred,
    total: d.total,
    cancel: () => {
      d.cancelled = true;
      d.token?.cancel();
      d.wake?.();
    },
  };
}

// A download that breaks off (the Wi-Fi roams, a VPN comes up, GitHub's CDN
// drops the connection) is tried again by itself: three more times, with
// growing pauses. electron-updater starts each try fresh, as a delta where
// it can, and falls back to the whole file when the delta fails.
const RETRY_DELAYS_MS = [5000, 20000, 60000];
const TRANSIENT_ERROR =
  /ERR_NETWORK_CHANGED|ERR_CONNECTION|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang up|timed? ?out|status code 5\d\d|HttpError: 5\d\d/i;

// "done" (update-downloaded has fired), "cancelled", or the final Error.
async function downloadWithRetry(updater, hooks, info, sheetFollows) {
  const { CancellationToken } = require("electron-updater");
  const d = {
    version: info.version,
    percent: 0,
    transferred: 0,
    total: 0,
    token: null,
    cancelled: false,
    rate: new RateMeter(),
    wake: null,
    sentPercent: -1,
    sentAt: 0,
  };
  activeDownload = d;
  try {
    for (let attempt = 0; ; attempt++) {
      d.token = new CancellationToken();
      try {
        await updater.downloadUpdate(d.token);
        return "done";
      } catch (err) {
        if (d.cancelled) {
          log.info("update download cancelled");
          return "cancelled";
        }
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay == null || !TRANSIENT_ERROR.test(errorReason(err))) {
          log.warn("update download failed:", errorReason(err));
          return err instanceof Error ? err : new Error(String(err ?? "unknown error"));
        }
        log.warn(`update download failed (${errorReason(err)}); trying again in ${delay / 1000} s`);
        if (sheetFollows()) {
          tellInApp(hooks, { state: "downloading", mode: "self", version: d.version, percent: d.percent, retryInSeconds: delay / 1000 });
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delay);
          d.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        d.wake = null;
        if (d.cancelled) return "cancelled";
        d.rate = new RateMeter();
      }
    }
  } finally {
    if (activeDownload === d) activeDownload = null;
    setDockProgress(hooks, -1);
  }
}

// Bytes per second over the last minute of samples - long enough that the
// pauses between range requests don't make the figure jump.
class RateMeter {
  constructor() {
    this.samples = [];
  }
  add(bytes) {
    const now = Date.now();
    this.samples.push({ t: now, bytes });
    while (this.samples.length > 2 && now - this.samples[1].t > 60000) this.samples.shift();
  }
  perSecond() {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const seconds = (last.t - first.t) / 1000;
    return seconds > 0 ? Math.max(0, Math.round((last.bytes - first.bytes) / seconds)) : 0;
  }
}

// One line that says what went wrong: electron-updater's errors carry it in
// the message ("net::ERR_NETWORK_CHANGED").
function errorReason(err) {
  const text = err == null ? "" : String(err.message || err.code || err);
  return text.replace(/^Error:\s*/, "").split("\n")[0].slice(0, 160) || "unknown error";
}

// The Dock icon's progress bar (taskbar on Windows): 0-1, anything else takes it away.
function setDockProgress(hooks, fraction) {
  const win = hooks.getMainWindow();
  if (!win || win.isDestroyed()) return;
  try {
    win.setProgressBar(fraction);
  } catch {
    /* no window chrome to draw on */
  }
}

// --- macOS: download through electron-updater, install by hand -----------------

// Runs detached and outlives the app: wait for it to be gone, move the old
// bundle aside, move the new one in, and put the old one back if that fails.
// A rename within one volume, so there is no moment with half an app.
const SWAP_SCRIPT = `
pid="$1"; staged="$2"; target="$3"; relaunch="$4"
exec >>"$5" 2>&1
echo "$(date -u +%FT%TZ) swap: waiting for $pid, then $staged -> $target"
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 300 ]; then echo "swap: the app did not quit, giving up"; exit 1; fi
  sleep 0.2
done
backup="$target.previous"
rm -rf "$backup"
mv "$target" "$backup" || { echo "swap: could not move the old app aside"; exit 1; }
if mv "$staged" "$target"; then
  rm -rf "$backup"
  echo "swap: done"
else
  echo "swap: could not move the new app in, restoring the old one"
  mv "$backup" "$target"
  exit 1
fi
if [ "$relaunch" = 1 ]; then open "$target"; fi
`;

function initMacUpdater(hooks) {
  const notifyOnly = () => {
    const check = () => checkMacNotifyOnly(hooks);
    setTimeout(check, FIRST_CHECK_DELAY_MS);
    setInterval(check, RECHECK_INTERVAL_MS).unref?.();
  };

  // .../Rollfilm.app/Contents/MacOS/Rollfilm -> .../Rollfilm.app
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  const stateDir = path.join(app.getPath("userData"), "updater");
  const pendingFile = path.join(stateDir, "pending-swap.json");
  const failedFile = path.join(stateDir, "swap-failed.json");
  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };

  // A swap that was started leaves a note saying which version it was going
  // to; if this run is still older than that, it did not take (macOS may
  // refuse an app that changes an app). Trying again on every quit would fail
  // the same way and never tell anyone, so this version of the app goes back
  // to notify-only. The note is void once the app is a different version.
  const pending = readJson(pendingFile);
  fs.rmSync(pendingFile, { force: true });
  if (pending && isNewerVersion(String(pending.version), app.getVersion())) {
    log.warn(`the swap to ${pending.version} did not take; falling back to notify-only`);
    fs.writeFileSync(failedFile, JSON.stringify({ version: app.getVersion() }));
    // The unpacked app it left behind is over a gigabyte nobody will use.
    const dir = path.dirname(String(pending.staged || ""));
    if (path.basename(dir) === "staged") fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  const failed = readJson(failedFile);
  if (failed && failed.version !== app.getVersion()) fs.rmSync(failedFile, { force: true });
  else if (failed) return notifyOnly();

  const reason = cannotReplace(bundle);
  if (reason) {
    log.info(`self-update off (${reason}); notify-only`);
    return notifyOnly();
  }

  let MacUpdater;
  try {
    ({ MacUpdater } = require("electron-updater"));
  } catch (err) {
    log.warn("electron-updater unavailable:", err.message);
    return notifyOnly();
  }

  let staged = null; // { version, appPath } once an update is unpacked
  let swapStarted = false;
  const startSwap = (relaunch) => {
    if (!staged || swapStarted) return;
    swapStarted = true;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(pendingFile, JSON.stringify({ version: staged.version, staged: staged.appPath }));
    const logFile = path.join(app.getPath("userData"), "logs", "updater.log");
    log.info(`swapping in ${staged.version} once the app has quit`);
    spawn(
      "/bin/sh",
      ["-c", SWAP_SCRIPT, "sh", String(process.pid), staged.appPath, bundle, relaunch ? "1" : "0", logFile],
      { detached: true, stdio: "ignore" }
    ).unref();
  };

  // Everything up to the finished, verified zip is MacUpdater's - including
  // the delta download against the zip of the last update, which it keeps as
  // update.zip in its cache. Only the two steps that would go to Squirrel are
  // replaced.
  class UnsignedMacUpdater extends MacUpdater {
    async updateDownloaded(zipFileInfo, event) {
      try {
        if (!staged || staged.version !== event.version) {
          const dir = path.join(this.downloadedUpdateHelper.cacheDir, "staged");
          staged = { version: event.version, appPath: await unpack(event.downloadedFile, dir, event.version) };
          log.info(`unpacked ${event.version} to ${staged.appPath}`);
        }
      } catch (err) {
        // The download is fine but can't be made into an app here; the release
        // page still can.
        log.warn("unpacking the update failed:", err.message);
        checkMacNotifyOnly(hooks);
        return;
      }
      this.dispatchUpdateDownloaded(event);
    }

    // "Restart now": the backend is already stopped by the caller.
    quitAndInstall() {
      startSwap(true);
      app.quit();
    }
  }

  // "Later", or no answer at all: the next normal quit installs it.
  app.on("quit", () => startSwap(false));

  runUpdater(new UnsignedMacUpdater(), hooks);
}

// Why the running bundle can't be traded for a new one - or null if it can.
function cannotReplace(bundle) {
  if (!bundle.endsWith(".app")) return "not running from an app bundle";
  // An app that was never moved after download runs from a random read-only
  // mount; the real bundle is somewhere this process doesn't know.
  if (bundle.includes("/AppTranslocation/")) return "app is translocated";
  try {
    // Also what says no to an app started straight from the disk image.
    fs.accessSync(bundle, fs.constants.W_OK);
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
  } catch {
    return "app location is not writable";
  }
  return null;
}

// Unpacks the update zip and returns the path of the app inside it. ditto is
// what made the zip's counterpart on every Mac since 10.4: it keeps symlinks,
// permissions and extended attributes, all of which a bundle depends on.
async function unpack(zip, dir, version) {
  const run = util.promisify(execFile);
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  await run("/usr/bin/ditto", ["-x", "-k", zip, dir]);

  const name = (await fs.promises.readdir(dir)).find((f) => f.endsWith(".app"));
  if (!name) throw new Error("no app in the update zip");
  const appPath = path.join(dir, name);
  // The swap replaces a working app with this one; be sure it is the app, and
  // the version the release said it was.
  await fs.promises.access(path.join(appPath, "Contents", "MacOS", path.basename(process.execPath)), fs.constants.X_OK);
  const { stdout } = await run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    path.join(appPath, "Contents", "Info.plist"),
  ]);
  if (stdout.trim() !== version) throw new Error(`the zip holds ${stdout.trim()}, not ${version}`);
  return appPath;
}

// --- macOS fallback: check + open the release page -----------------------------

async function checkMacNotifyOnly(hooks) {
  let latest;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "User-Agent": "Rollfilm", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    latest = await res.json();
  } catch (err) {
    log.warn("update check failed:", err.message);
    return;
  }

  const latestVersion = String(latest.tag_name || "").replace(/^v/, "");
  if (!latestVersion || !isNewerVersion(latestVersion, app.getVersion())) return;
  if (promptedVersion === latestVersion) return;
  promptedVersion = latestVersion;

  const url = latest.html_url || RELEASES_URL;
  let action = await askInApp(hooks, {
    state: "available",
    mode: "page",
    version: latestVersion,
    notes: changelogPart(latest.body),
    url,
  });
  if (action === null) {
    const win = hooks.getMainWindow();
    const { response } = await dialog.showMessageBox(win ?? null, {
      type: "info",
      title: "Update available",
      message: `Rollfilm ${latestVersion} is available (you have ${app.getVersion()}).`,
      detail: withNotes(
        latest.body,
        "Download the new version from the releases page, then drag it into Applications to update."
      ),
      buttons: ["Open download page", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    action = response === 0 ? "open-page" : "dismiss";
  }
  if (action === "open-page") shell.openExternal(url);
}

// --- The prompt as the app's own sheet -------------------------------------------

// The announcement is the app's own sheet (frontend UpdateNotice.tsx), styled
// like "What's new", with the release notes folded under a disclosure. Every
// notice carries an id the page acknowledges as soon as it has it; no window,
// or no answer within ACK_TIMEOUT_MS (a page still loading, a renderer bundle
// from before the sheet), and the caller shows the native dialog instead.
const ACK_TIMEOUT_MS = 3000;
let noticeSeq = 0;
// The notice waiting for the user: { id, version, acked(), answer(action) }.
let openNotice = null;
let noticeIpcRegistered = false;

function registerNoticeIpc() {
  if (noticeIpcRegistered) return;
  noticeIpcRegistered = true;
  ipcMain.handle("pm:update-ack", (_event, id) => {
    if (openNotice && openNotice.id === id) openNotice.acked();
  });
  // "download" | "restart" | "open-page" | "dismiss"; the caller of askInApp
  // maps it onto what the native dialog's buttons did. An answer with no
  // notice open (closing the sheet while it shows the download) is ignored.
  ipcMain.handle("pm:update-action", (_event, action) => {
    const notice = openNotice;
    if (!notice) return;
    openNotice = null;
    notice.answer(String(action || "dismiss"));
  });
}

function sendToWindow(hooks, payload) {
  const win = hooks.getMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  try {
    win.webContents.send("pm:update", { current: app.getVersion(), ...payload });
    return true;
  } catch (err) {
    log.warn("update notice could not be sent:", err.message);
    return false;
  }
}

// A notice that needs no answer (download progress, "close the sheet").
function tellInApp(hooks, payload) {
  sendToWindow(hooks, payload);
}

// Resolves with the action picked in the sheet, or null when the sheet can't
// be shown - the caller then asks natively.
async function askInApp(hooks, payload) {
  // A newer notice replaces one nobody answered (a reload took its sheet away).
  if (openNotice) {
    const stale = openNotice;
    openNotice = null;
    stale.answer("dismiss");
  }
  const id = ++noticeSeq;
  let acked;
  let answer;
  const ack = new Promise((resolve) => (acked = () => resolve(true)));
  const action = new Promise((resolve) => (answer = resolve));
  const notice = { id, version: payload.version, acked, answer };
  openNotice = notice;
  if (!sendToWindow(hooks, { ...payload, id })) {
    if (openNotice === notice) openNotice = null;
    return null;
  }
  let timer;
  const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(false), ACK_TIMEOUT_MS)));
  const ok = await Promise.race([ack, timeout]);
  clearTimeout(timer);
  if (!ok) {
    log.info("the page did not take the update notice; asking natively");
    if (openNotice === notice) openNotice = null;
    // An answer that comes late must not leave a second prompt on screen.
    tellInApp(hooks, { state: "closed", version: payload.version });
    return null;
  }
  return action;
}

// --- What's new, in the prompt ---------------------------------------------------

// The prompt says what the update brings: the first few points of the
// release page's changelog (scripts/release-notes.js writes it), as plain
// text - a native dialog shows no markup. The app's own "What's new" sheet has
// the whole list after the restart.
const NOTES_MAX_POINTS = 6;

// electron-updater hands the release body over as HTML (GitHub's rendering);
// with fullChangelog it is a list of { version, note }.
function releaseNotesOf(info) {
  const notes = info.releaseNotes;
  if (Array.isArray(notes)) return notes.find((n) => n.version === info.version)?.note ?? notes[0]?.note ?? "";
  return typeof notes === "string" ? notes : "";
}

// Where the changelog part of a release body ends: the downloads, the folded
// blocks, or the commit list of a release without a CHANGELOG section.
const NOTES_END = /<h\d[^>]*>\s*Download|^#+\s*Download|<details|^#+\s*Changes/im;

// The release body's changelog part, as markdown (the sheet parses it the way
// it parses CHANGELOG.md).
function changelogPart(raw) {
  if (!raw) return "";
  const text = String(raw);
  const cut = text.search(NOTES_END);
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

// The release page's body as GitHub stores it: markdown, unlike the HTML
// electron-updater hands over. null when GitHub can't be asked.
async function fetchReleaseBody(version) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, {
      headers: { "User-Agent": "Rollfilm", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const release = await res.json();
    return typeof release.body === "string" ? release.body : null;
  } catch (err) {
    log.warn(`release notes of ${version} could not be fetched:`, err.message);
    return null;
  }
}

// What the sheet shows for an electron-updater update: the release body, or
// failing that the points of the HTML it brought along.
const notesByVersion = new Map();
async function releaseNotesMarkdown(info) {
  if (notesByVersion.has(info.version)) return notesByVersion.get(info.version);
  const body = await fetchReleaseBody(info.version);
  const notes = body
    ? changelogPart(body)
    : notesSummary(releaseNotesOf(info))
        .map((p) => `- ${p}`)
        .join("\n");
  if (body) notesByVersion.set(info.version, notes);
  return notes;
}

// HTML or markdown in, "• point" lines out - only the changelog part, which
// ends where the downloads begin.
function notesSummary(raw) {
  if (!raw) return [];
  let text = String(raw);
  const cut = text.search(NOTES_END);
  if (cut !== -1) text = text.slice(0, cut);
  // HTML wraps a point's text over lines as it likes: one line per element.
  if (/<li[\s>]/i.test(text)) text = text.replace(/\s+/g, " ");
  text = text
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|li|h\d|ul)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\*\*|`/g, "");
  // A markdown point can run over several lines: join the continuations.
  const points = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (/^[-*]\s+/.test(t)) points.push(t.replace(/^[-*]\s+/, ""));
    else if (t && !/^#/.test(t) && points.length > 0 && /^\s/.test(line)) points[points.length - 1] += ` ${t}`;
  }
  return points;
}

function withNotes(raw, closing) {
  const points = notesSummary(raw);
  if (points.length === 0) return closing;
  const shown = points.slice(0, NOTES_MAX_POINTS).map((p) => `• ${p}`);
  if (points.length > NOTES_MAX_POINTS) shown.push(`…and ${points.length - NOTES_MAX_POINTS} more`);
  return `What's new:\n${shown.join("\n")}\n\n${closing}`;
}

// "0.1.13" > "0.1.12" - plain numeric per part, missing parts count as 0.
// Anything non-numeric (pre-release suffixes aren't used here) compares as 0.
function isNewerVersion(candidate, current) {
  const a = candidate.split(".").map((n) => parseInt(n, 10) || 0);
  const b = current.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

module.exports = { initAutoUpdate, updateDownloadState };

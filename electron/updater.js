// Auto-update for the packaged desktop app, fed by the GitHub releases the
// build workflow publishes (electron/package.json "publish" points at the
// repo; electron-builder bakes that into the bundle as app-update.yml).
//
// On all three platforms the new version downloads in the background and a
// small "restart now?" prompt applies it - and the download is only what
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

const { app, dialog, shell } = require("electron");
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
      if (fs.statSync(file).size > 512 * 1024) {
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
    const line = util.format(...args);
    (level === "info" || level === "debug" ? console.log : console.warn)(`[updater] ${line}`);
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
  updater.autoDownload = true;

  updater.on("error", (err) => {
    // Expected offline noise, not a user-facing problem.
    log.warn("update check failed:", err == null ? "unknown" : err.message);
  });

  updater.on("update-downloaded", async (info) => {
    if (promptedVersion === info.version) return;
    promptedVersion = info.version;
    const win = hooks.getMainWindow();
    const { response } = await dialog.showMessageBox(win ?? null, {
      type: "info",
      title: "Update ready",
      message: `Rollfilm ${info.version} has been downloaded.`,
      detail:
        "Restart now to update, or keep working - the update installs by itself the next time you quit.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return;
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

  const win = hooks.getMainWindow();
  const { response } = await dialog.showMessageBox(win ?? null, {
    type: "info",
    title: "Update available",
    message: `Rollfilm ${latestVersion} is available (you have ${app.getVersion()}).`,
    detail:
      "Download the new version from the releases page, then drag it into Applications to update.",
    buttons: ["Open download page", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) shell.openExternal(latest.html_url || RELEASES_URL);
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

module.exports = { initAutoUpdate };

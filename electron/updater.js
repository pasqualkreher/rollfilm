// Auto-update for the packaged desktop app, fed by the GitHub releases the
// build workflow publishes (electron/package.json "publish" points at the
// repo; electron-builder bakes that into the bundle as app-update.yml).
//
// Two very different code paths on purpose:
//
//   Windows / Linux — true auto-update via electron-updater: the new installer
//   downloads in the background and a small "restart now?" prompt applies it.
//   Both targets (NSIS, AppImage) support unsigned self-replacement.
//
//   macOS — notify-only. Squirrel.Mac refuses to swap an app bundle that isn't
//   code-signed, and the mac build ships unsigned (identity: null) - a real
//   in-place update is impossible without an Apple Developer certificate. So
//   the mac path just checks the GitHub API for a newer tag and offers to open
//   the release page for a manual download.
//
// Everything here is fire-and-forget: update checks must never block startup,
// and a failed check (offline, rate-limited, GitHub down) is logged and
// otherwise invisible - the app simply stays on its current version.

const { app, dialog, shell } = require("electron");

const REPO = "pasqualkreher/rollfilm";
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

// First check shortly after startup (the window is up by then, and a dialog
// with no window to attach to still works); then periodically, for the
// "leave it running for weeks" case.
const FIRST_CHECK_DELAY_MS = 15 * 1000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// The mac "new version available" prompt shows once per version per run -
// re-prompting every 6 hours about the same release would just be nagging.
let macPromptedVersion = null;

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

  const check = process.platform === "darwin" ? () => checkMacNotifyOnly(hooks) : null;

  if (check) {
    setTimeout(check, FIRST_CHECK_DELAY_MS);
    setInterval(check, RECHECK_INTERVAL_MS).unref?.();
    return;
  }

  initElectronUpdater(hooks);
}

// --- Windows / Linux: electron-updater -------------------------------------

function initElectronUpdater(hooks) {
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    console.warn("[updater] electron-updater unavailable:", err.message);
    return;
  }

  autoUpdater.autoDownload = true;
  // Even if the user picks "Later", the downloaded update applies on the next
  // normal quit - so "Later" still updates, just without the forced restart.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (err) => {
    // Expected offline noise, not a user-facing problem.
    console.warn("[updater] update check failed:", err == null ? "unknown" : err.message);
  });

  autoUpdater.on("update-downloaded", async (info) => {
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
      console.warn("[updater] stopping backend before install failed:", err.message);
    }
    autoUpdater.quitAndInstall();
  });

  const check = () =>
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn("[updater] update check failed:", err.message);
    });

  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, RECHECK_INTERVAL_MS).unref?.();
}

// --- macOS: check + open the release page ----------------------------------

async function checkMacNotifyOnly(hooks) {
  let latest;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "User-Agent": "Rollfilm", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    latest = await res.json();
  } catch (err) {
    console.warn("[updater] update check failed:", err.message);
    return;
  }

  const latestVersion = String(latest.tag_name || "").replace(/^v/, "");
  if (!latestVersion || !isNewerVersion(latestVersion, app.getVersion())) return;
  if (macPromptedVersion === latestVersion) return;
  macPromptedVersion = latestVersion;

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

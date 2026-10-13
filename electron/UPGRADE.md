# Electron upgrade

The shell pins `electron ^33.2.0` (33.4.11 installed). Electron supports only
its newest three majors, and 33 went out of support in 2025. It gets no more
Chromium security fixes, which matters for an app that renders file names,
EXIF text and Immich album titles.

**Target:** the newest stable major listed on https://releases.electronjs.org
when the upgrade is done. Check that page first. Don't assume a number from
this note.

## Steps

1. Read the breaking-changes page (https://www.electronjs.org/docs/latest/breaking-changes)
   for every major from 34 up to the target. Look for anything this shell
   uses: `protocol.handle` / `registerSchemesAsPrivileged` (rf://),
   `webRequest.onBeforeSendHeaders` / `onHeadersReceived` (API token, CSP),
   `webContents.printToPDF` (canvas PDF), `startDrag`, `webUtils.getPathForFile`,
   `setWindowButtonPosition` / `setWindowButtonVisibility`, `nativeTheme`,
   `app.dock.setProgressBar`, and the sandboxed preload rules.
2. Check the minimum macOS. Newer majors dropped macOS 11, so the README's
   system requirements may need to change.
3. `npm install --save-dev electron@<target> electron-builder@latest` (builder
   25 predates the newer Electron majors), then `npm install` for
   `electron-updater`.
4. `npm run dev`: test import, the grid (rf:// tiles), the editor, the map
   tiles, canvas PDF export, drag out to the Finder, a file drop, and the menu bar.
5. `npm run pack`, then test the installed app: the CSP only applies to the
   built bundle, and so does the auto-updater. Do a full update from the
   previous release, because the updater crosses the Electron version too.
6. Bump the version and release as usual.

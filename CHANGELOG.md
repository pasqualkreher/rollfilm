# Changelog

What changed in each version of Rollfilm, newest first. The app shows the part you haven't seen after an update, and each GitHub release page carries its own section.

<!-- One line per point: GitHub's release pages keep line breaks. Sections: New, Improved, Fixed, Safety. -->

## 0.1.98 — 2026-10-18

### New
- **Rolls**: every import is kept as a roll. After an import the Import page shows the roll as a contact sheet with "Open in Library"; Albums lists Rolls instead of Recent imports; the Library sorts by roll.
- **Survey**: select 2 to 6 photos and press N (or right-click → Survey) to see them side by side. Stars, picks, rejects and colours go to the framed photo, X takes it out, Esc returns to the grid with the selection kept.

### Improved
- Backups carry the rolls (manifest v4); older backups restore as before.
- The selection bar drops Select all and Clear selection: ⌘A, Esc and a click on empty ground do the same.
- Auto-arrange on the canvas takes a range of photos per page (1 to 9, "at least" and "at most"), sets the pages in rows, columns or whichever fits best, keeps sizes even or fills the paper, has a style (Balanced, Fitted lets photos swap places, Edge to edge fills the page to the margin and trims photos a little), and by time starts a new page where the shooting paused.
- Find similar… says what it did: "Added 10 photos to “Holiday”." in the dialog's footer after Add to….
- Settings › Backup & restore no longer lists database snapshots. Rollfilm still copies its database before every update and once a day, on its own.

### Fixed
- A preset that brings only its film look onto a photo that was never edited no longer renders it dark; the photo takes the same base a new edit gets, and moves to the current process the way the editor does.
- Albums hid the Recent imports row when no other automatic album existed.
- The selection bar wraps cleanly in a narrow window: rows keep their spacing, the divider goes, Delete stays beside Edit and Reset, and the grid's last row is never hidden under it. The tag field now sits beside the stars.
- Closing an import session while its previews were still rendering no longer logs an error.

## 0.1.97 — 2026-10-17

### Fixed
- Linux: since 0.1.94 the window could not reach the app's background service - every view said it "did not answer" and imports failed with a network error. The window's bridge to the app failed to load under the Linux sandbox; it loads again. (#4)
- When the window's bridge is missing, the app now says so instead of "did not answer", and main.log records why (preload errors, renderer crashes, page errors).

## 0.1.96 — 2026-10-17

### New
- Updates ask first and say what they bring. After an update, a "What's new" window shows the changes once.
- Settings › Maintenance lists the release notes of every version.
- Canvas: **Auto-arrange** rebuilds the pages - by look, by time or in order, with as many photos per page as you say - each page laid out for its photos.
- **Find similar…** finds photos in your library that go with one you chose, narrowed by tags or place - from the selection bar, the right-click menu, the photo view and the canvas filmstrip. Tick what you want, then select it, add it to an album or canvas, or export it.
- Two new skins, each with a light and a dark cut: Cyanotype (deep blue) and Negative (the orange of colour negative film).
- Download backup asks where to save, shows its progress in the title bar and offers "Show in Finder" when done.

### Improved
- The editor's Export… and Save copy buttons are smaller and fit on one line.
- Stars, picks, rejects, colour labels and tags no longer show anything in the title bar: no spinner, no Undo chip. Moving to the Trash and removing from an album keep their Undo.
- P shows and hides the panel again, in the photo view, the editor and the import preview. Pick is now A (X rejects, U unflags as before).
- Settings › Tags shows rename and delete for every tag, not only under the pointer.
- "Report a problem" (with the version and system filled in) and "Show logs" where a load fails, in Settings › About and in the Help menu.
- Dragging files over the window shows "Drop to import"; the Import page has a visible drop target; an empty library offers Import photos.
- Albums no longer carry tags: no Tags row, no tag field when creating an album, no tag rule in the album's bar (tags are in the filter). An album that already has a rule still shows it, so it can be taken off.
- Even spacing between your albums and the automatic ones.

### Fixed
- A source folder on a network mount that stopped answering no longer stalls every library request: the check is time-boxed and cached. Requests that get no answer within half a minute now fail with a message instead of hanging.
- A folder dropped on the window while an import review was open did nothing; the start dialog now appears.
- Every copying import asks which folder to copy into, also with "Always copy" set - unless Settings › Import fixes one. Backup and verification are greyed out while photos stay where they are.
- The Import settings dialog no longer cuts off its title on small windows; the settings scroll between title and Done.

## 0.1.95 — 2026-10-13

### New
- **Masks and Retouch you can read.** One tool at a time (R, K, Q, W; Esc puts it away), a "+ New mask" menu, Add/Subtract/Intersect for a mask's parts, numbered pins on the photo and an overlay you can toggle with O.
- **Retouch** shows a size ring and an arrow from source to spot. Alt-click sets the source, Space-drag pans.
- **Culling:** pick and reject with P, X and U. Every star, label, flag, delete and album removal gets an Undo chip, so Delete no longer asks.
- **Editor:** history list, named snapshots, a reset per section, `\` for before/after, an RGB readout and Export… right in the editor.
- **Export:** PNG, 8-bit TIFF, size by short edge, megapixels or per cent, sharpening for screen, and a logo watermark.
- Recent imports, a Show filter (edited, unrated, located) and smart albums you can cull in.
- Mac: Go and Photo menus, and you can drop a card or folder on the window to import it.

### Improved
- Presets are kept in the library. Sharpening has radius and masking, and defringe handles purple and green.
- Search stops at the relevant matches. Your own albums come first.

### Safety
- The library sync marks missing files instead of deleting them.
- The database is snapshotted before every migration and once a day.
- Backup and restore cover everything (canvases, settings, snapshots, presets) and are checked before anything is replaced.
- Import copies through a temporary file and can verify checksums.

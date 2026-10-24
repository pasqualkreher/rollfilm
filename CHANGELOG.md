# Changelog

What changed in each version of Rollfilm, newest first. The app shows the part you haven't seen after an update, and each GitHub release page carries its own section.

<!-- One line per point: GitHub's release pages keep line breaks. Sections: New, Improved, Fixed, Safety. -->

## 0.2.1 — 2026-10-24

### Fixed
- Windows: the update of a Rollfilm installed for all users (Program Files) still stopped on "Rollfilm cannot be closed – Retry / Cancel"; the previous version is now skipped in that case too.

## 0.2.0 — 2026-10-24

### Fixed
- Windows updates no longer stall on "Rollfilm cannot be closed – Retry / Cancel": the setup removes the previous version itself instead of running its uninstaller, and first ends any helper still running from the Rollfilm folder.

## 0.1.100 — 2026-10-21

### New
- **Import review: select by dragging** a rectangle over the cards, as in the Library; ⌘-click, Shift-click and ⌘A work as before.
- **Add a library by dropping it**: drag a library folder from the Finder onto the Library tab of the Import page; the page checks it and offers to merge it.
- **Back and Forward through the import**: the title bar's Back goes from the preview to the review and from the review to the Import page; Forward brings them back, the review with its filters and scroll position, the preview with its photo.

### Improved
- The Import page is one tabbed start: Card or folder, Library and External sources, with Import settings… at the end of the row. The drop target holds Choose folder… and Choose files…; open sessions sit below it with Continue, rename and close.
- The review's toolbar says "k of n to import · m added" and has one Add… menu for folders and files. The bottom row keeps Close session and Continue later on the left, Album and Immich beside Import all, Import none and Add N photos on the right.
- Review cards: stars and colour swatches sit under the photo with the Import checkbox; a card to import carries an accent frame instead of the others being dimmed.
- The import preview has one row under the photo: the card's stars, colours and Import box on the left, background and zoom in the middle, name, kind, counter and Info on the right. Its own Back button is gone; the title bar's Back and the Import tab close it.
- The Import tab steps one level up while you are on the Import page (preview → review → Import page) and never ends a session; from any other tab it returns to where you last were.
- After an import the Import page goes back to its start; the roll is under Albums › Rolls.
- The editor's and the photo view's control row give way step by step on a narrow stage (the Slideshow word, then the 200/400 zoom steps, then a second line) instead of breaking wherever the width runs out.
- The photo view's info panel shows the flag beside the stars.
- The narrow window's menu lists the modules only; Trash, Statistics, Settings and Help keep their icon buttons at every width.
- Survey is gone: the side-by-side view (N) was taken out again, together with its menu entries and Help rows.

## 0.1.99 — 2026-10-19

### New
- **Swap photos on the canvas**: drag a photo onto the middle of another and drop it on “Swap photos”. Alike shapes keep both frames; a portrait for a landscape on a page set as a layout sets the page again in its reading order, so the rows reach the margins as before, and swapping back gives the page exactly as it was. On a free page the two frames reshape to their photos at the same size, clear of their neighbours. ⌘Z takes a swap back in one step.
- **Drop takes the free space**: a photo dropped from the filmstrip takes the empty area where it lands, inside the margins and clear of its neighbours; with the grid on it sits on the grid. The ghost shows the frame before you let go.
- **Fill free space (G)** grows the selected photo into the empty area around it. With every photo of a page selected (⌘A) it sets the page as a whole, like Auto-arrange for that one page, in the photos' reading order.
- **Pages in the rail take photos**: drag a photo from the page onto a page card to move it there, onto a frame on that card to swap the two across pages, or onto “Add a page” for a page of its own. The rail scrolls while you hold a photo near its edge.
- **Page sizes**: the common photo-book and print sizes (A-series, Letter and Tabloid, book sizes from compact to XL and three squares, lab prints from 9×13 cm to 16×20 in), each once, grouped and searchable, with a Landscape/Portrait switch beside the list.
- **Survey**: a click or Enter opens the framed photo in the photo view, which pages through the survey's photos only; Esc comes back to the survey as it was left.

### Improved
- The Import page looks like the rest of the app: the review's source and count head the toolbar, Add folder/Add photos sit in the bar, the step strip and the tinted banners are plain status lines, and the start page's cards are Settings-style sections with the app's own menu behind "Import photos". The button keeps its width while an import runs.
- Adding to an album or canvas, Immich uploads and bulk develops report in the title bar's task dock, with an Open link where there is somewhere to go; the message row under the selection bar is gone.
- Moving or resizing a frame also snaps to a neighbour's edge at the layout gap (6 mm), not only flush. A frame let go outside the page view goes back where it came from.
- Several selected frames are marked clearly: a two-pixel accent outline with a light halo, readable on paper and on dark photos.
- Auto-arrange by time picks its pauses from how the photos spread: a year of photos breaks by day, a day by hour, an hour by minute.
- Clear canvas also removes the extra pages; the canvas starts over with one empty page. Leaving an empty canvas's editor goes back to the list.
- Colour grading wheels: a drag with Shift held moves the puck at a quarter of the pointer's pace, the arrow keys nudge it (← → hue, ↑ ↓ saturation, Shift for tenths), and values keep a decimal.
- In the editor the climb to the screen's full size after a slider rests no longer shows the small spinner at fit view; zoomed-in native renders still say so.
- Albums and Canvas start with their create field right under the title; Rolls and Other imports moved down to the automatic rows; the intro texts on Canvas and Import and the canvas toolbar's "How this works" list are gone.

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

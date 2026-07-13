// In-app user guide. Content is maintained by hand — keep it in sync with the
// actual features (this is what "Help" in the nav and the first-run welcome
// guide point at).

import type { ReactNode } from "react";

const SECTIONS: { id: string; title: string }[] = [
  { id: "basics", title: "The basics: where your photos live" },
  { id: "importing", title: "Importing photos" },
  { id: "browsing", title: "Browsing the library" },
  { id: "search", title: "Search" },
  { id: "culling", title: "Culling: stars, colors, tags and Selects" },
  { id: "trash", title: "Deleting & the Trash" },
  { id: "photo-view", title: "The photo view" },
  { id: "editing", title: "Editing photos" },
  { id: "albums", title: "Albums" },
  { id: "map", title: "Map" },
  { id: "external-sources", title: "External sources" },
  { id: "immich", title: "Immich" },
  { id: "backup", title: "Backup, restore & maintenance" },
  { id: "shortcuts", title: "Keyboard shortcuts" },
  { id: "troubleshooting", title: "Troubleshooting" },
];

// Plain anchors would fight the HashRouter (#/help vs #basics), so the table
// of contents scrolls programmatically instead.
function jumpTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function H({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="section-title help-heading" style={{ fontSize: 16 }}>
      {children}
    </h3>
  );
}

export function Help() {
  return (
    <div className="page help-page">
      <div className="help-inner">
        <h2 className="section-title">Help</h2>
        <p style={{ color: "var(--text-muted)" }}>
          Everything Photo Manager can do, in the order you'll meet it.
        </p>

        <nav className="help-toc" aria-label="Contents">
          {SECTIONS.map((s) => (
            <button key={s.id} className="help-toc-link" onClick={() => jumpTo(s.id)}>
              {s.title}
            </button>
          ))}
        </nav>

        <H id="basics">The basics: where your photos live</H>
        <p>Photo Manager keeps everything for a library together in one place:</p>
        <ul>
          <li>
            <strong>Your library folder</strong> — the folder you picked on first start. Imported
            photo files are copied here, and the database, thumbnails and import staging live
            alongside them in a hidden <code>.photomanager</code> subfolder. That makes the whole
            library self-contained: back it up or move it to another drive as one folder. You can
            see and change it under <em>Settings → Library folder</em> (changing it restarts the app
            and does not move existing photo files).
          </li>
          <li>
            <strong>Separate libraries</strong> — because a library is self-contained, you can keep
            several independent ones and switch between them by pointing the app at a different
            library folder under <em>Settings → Library folder</em>.
          </li>
          <li>
            <strong>Shared app data</strong> — only the AI model cache and logs stay in the standard
            app-data location. They're rebuilt or managed automatically; you never need to touch
            them.
          </li>
        </ul>
        <p>
          The library folder on disk is the source of truth: if files disappear from it (deleted
          outside the app, drive unplugged), use <em>Settings → Sync database to library</em> to
          reconcile.
        </p>

        <H id="importing">Importing photos</H>
        <p>
          <em>Import tab → "Import photos ▾" → choose a folder or individual files.</em> Supported:
          JPEG, PNG and RAW (CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2, PEF, SRW).
        </p>
        <ol>
          <li>
            Files upload into a <strong>staging area</strong> first — nothing lands in your library
            yet. The upload continues even if you switch to another tab (the Import link shows the
            progress).
          </li>
          <li>
            Photo Manager checks every staged file against your library.{" "}
            <strong>"Already in library"</strong> means byte-identical — these can't be imported
            again. <strong>"Possible duplicate"</strong> means visually near-identical — you decide.
            "Hide duplicates" (on by default) keeps them out of view. Exception: a photo that so far
            only exists in an <em>external source</em> can still be imported — the imported copy
            becomes the library's own, and the photo keeps its stars, tags, albums and edits (the
            file in the external folder stays untouched).
          </li>
          <li>
            You can already <strong>rate and color-label</strong> staged photos, so culling can start
            before the import — directly on the cards or in the preview (arrow keys to flip through).
          </li>
          <li>
            <strong>RAW+JPEG pairs</strong> shot together are detected. In merged view they act as
            one photo; if you select only one half, the import asks whether to include the partner.
          </li>
          <li>
            Optionally tick <strong>"Also upload to Immich (JPG only)"</strong> — RAW files never
            leave this library. Whether each upload arrived is shown under{" "}
            <em>Settings → Immich → Recent uploads</em>.
          </li>
          <li>
            <strong>"Import N photos"</strong> copies the selection into your library folder;
            "Discard" throws the staging session away.
          </li>
        </ol>

        <H id="browsing">Browsing the library</H>
        <p>
          The Library is a newest-first timeline grouped by month, with a{" "}
          <strong>date scrubber</strong> on the right edge — drag it to jump years at a time.
        </p>
        <ul>
          <li>
            <strong>Filters:</strong> album, minimum star rating, color label, tags (a photo must
            carry <em>all</em> selected tags) and a capture-date range. "Clear" resets everything.
          </li>
          <li>
            <strong>View mode:</strong> show RAW + JPEG, only JPEGs, or only RAWs. With{" "}
            <strong>"Merge RAW+JPG"</strong> a pair appears as a single card — rating, labeling or
            deleting it applies to both files.
          </li>
          <li>
            <strong>Thumbnail size:</strong> S / M / L / XL.
          </li>
          <li>
            <strong>Selection &amp; bulk actions:</strong> press "Select", click photos (shift-click
            for a range), then use the bottom bar: set stars or a color label, add a tag, add to an
            album, add to Selects, send to Immich, reset stars/tags/colors — or delete.
          </li>
        </ul>
        <p>
          <strong>Deleting is safe by default.</strong> Library photos go to the in-app{" "}
          <strong>Trash</strong> first and can be restored; photos from an external source are only
          removed from the catalog — their files on disk are never touched. A RAW+JPEG pair is
          always deleted together. See "Deleting &amp; the Trash" below.
        </p>

        <H id="search">Search</H>
        <p>
          The search box in the top bar understands <strong>plain language</strong> — try "dog on a
          beach" or "red car at night". It matches your tag names first, then ranks photos by visual
          similarity to your words (the image content itself, not filenames). Search respects the
          view you're in: inside an album it searches that album; everywhere else, the whole library.
        </p>

        <H id="culling">Culling: stars, colors, tags and Selects</H>
        <ul>
          <li>
            <strong>Stars (0–5):</strong> click the stars on a card, in the detail view or in the
            bulk bar. Clicking the same star again clears the rating.
          </li>
          <li>
            <strong>Color labels:</strong> red, orange, yellow, green, blue, magenta or gray — use
            them for whatever workflow you like (e.g. green = done, red = revisit).
          </li>
          <li>
            <strong>Tags:</strong> free-form keywords with autocomplete. Add them per photo in the
            detail view or to a whole selection at once.
          </li>
          <li>
            <strong>Selects</strong> is your shortlist basket: add photos from anywhere, then on the
            Selects page download them all as a zip, send them to Immich, or clear the list. The nav
            shows a live count.
          </li>
        </ul>

        <H id="trash">Deleting &amp; the Trash</H>
        <p>What "Delete" does depends on where the photo lives:</p>
        <ul>
          <li>
            <strong>Photos imported into your library</strong> move to the <strong>Trash</strong>{" "}
            (in the nav). The original file stays in your library folder, and the photo keeps its
            stars, tags, albums and edits — <strong>Restore</strong> brings it back exactly as it
            was.
          </li>
          <li>
            <strong>Photos from an external source</strong> (indexed in place) are removed from the
            catalog immediately — they don't go to the Trash, because{" "}
            <strong>their files are never deleted</strong>. The original stays untouched in your
            folder/NAS, and the automatic scan at app start won't bring the photo back. To get it
            into the library again, press <em>Scan now</em> on the source (a manual scan re-indexes
            everything, including removed photos) — or import the file.
          </li>
        </ul>
        <p>
          On the Trash page, <strong>"Delete forever"</strong> permanently deletes the selected
          photos — only this step actually removes the original files from your library folder, and
          it cannot be undone. The delete confirmation always tells you exactly what will happen to
          your selection.
        </p>
        <p>
          The Trash also <strong>empties itself</strong>: on every app start, photos that have been
          in the Trash longer than the retention period (default <strong>14 days</strong>) are
          deleted for good in the background. Change the period under{" "}
          <em>Settings → Trash</em> — set it to 0 to keep deleted photos forever.
        </p>

        <H id="photo-view">The photo view</H>
        <p>
          Click any photo to open it. Scroll or pinch to zoom toward the cursor, drag to pan,
          double-click to jump between fit and 100%. Below the photo: its EXIF details, tags, albums,
          a <strong>"Similar photos"</strong> strip (found by visual similarity), and{" "}
          <strong>"Download original"</strong>.
        </p>

        <H id="editing">Editing photos</H>
        <p>
          <em>Detail view → Edit.</em> Editing is <strong>non-destructive</strong>: the original file
          is never modified, and the preview you see is rendered by the exact same pipeline that
          saves.
        </p>
        <ul>
          <li>
            <strong>Geometry:</strong> rotate in 90° steps, crop by dragging — freeform or locked to
            an aspect ratio (Original, 1:1 and all the common sizes: 3:2, 4:3, 5:4, 7:5, 16:9 and
            their portrait counterparts) — plus composition overlays (rule of thirds, grid,
            diagonals).
          </li>
          <li>
            <strong>Light</strong> (with live histogram): exposure, contrast, highlights, shadows,
            whites, blacks, dehaze.
          </li>
          <li>
            <strong>Color:</strong> temperature, tint, saturation, Fuji color chrome / chrome blue.
          </li>
          <li>
            <strong>Color mixer:</strong> hue / saturation / luminance per color band (red, orange,
            yellow, green, aqua, blue, purple, magenta).
          </li>
          <li>
            <strong>Detail:</strong> clarity, sharpness, denoise. <strong>Lens &amp; effects:</strong>{" "}
            distortion, vignette, mist, grain and grain size.
          </li>
          <li>
            <strong>Presets:</strong> save your current look under a name and reapply it to other
            photos (crop/rotation are not part of a preset).
          </li>
          <li>
            Handy: <strong>double-click a slider</strong> to reset it; <strong>hold "Compare"</strong>{" "}
            to peek at the original; toggle a light or black background behind the photo.
          </li>
          <li>
            <strong>Save</strong> updates this photo's edit. <strong>Save copy</strong> creates a new
            photo (auto-tagged "edited") and leaves the original untouched. "Reset all" clears every
            adjustment.
          </li>
        </ul>

        <H id="albums">Albums</H>
        <p>
          Albums are created on the Albums page. Fill them via the bulk bar ("Add to album") or from
          a photo's detail page. Removing a photo from an album, or deleting the whole album, never
          deletes the photos themselves.
        </p>

        <H id="map">Map</H>
        <p>
          The Map shows a pin for every photo with GPS coordinates in its EXIF data (phones add these
          automatically; many cameras don't). RAW+JPEG pairs appear as one pin. Click a pin to open
          the photo.
        </p>

        <H id="external-sources">External sources</H>
        <p>
          <em>Import tab → External photo sources.</em> An external source is a folder that is{" "}
          <strong>indexed in place</strong> — nothing is copied or moved, unlike the rest of Import.
          Ideal for a
          NAS or an existing archive you don't want to reorganize. Sources are re-scanned at app
          start and on demand. If the drive is unplugged the source shows as{" "}
          <strong>Disconnected</strong> and its photos are hidden until it returns. "Remove" only
          forgets the index — the files stay untouched.
        </p>
        <ul>
          <li>
            <strong>Deleting a photo</strong> from an external source only removes the catalog entry
            — the file on disk is never touched, and automatic scans at app start keep it removed.
            Pressing <em>Scan now</em> re-indexes the whole folder, including photos you removed
            (see "Deleting &amp; the Trash").
          </li>
          <li>
            <strong>Duplicates between library and sources:</strong> the imported library copy is
            always the source of truth. A scan skips files that are byte-identical to a photo
            already in your library, and importing a photo that a source already indexed turns that
            entry into a regular library photo instead of creating a duplicate.
          </li>
        </ul>

        <H id="immich">Immich</H>
        <p>
          <em>Settings → Immich integration:</em> enter your server's address and an API key (create
          one in Immich under <em>Account Settings → API Keys</em>), then "Test connection". Once
          configured you can upload during import or send any selection later. Only JPEGs are
          uploaded — RAW files always stay local. Uploads run in the background and are retried a few
          times on network hiccups; the outcome of each one appears under{" "}
          <em>Settings → Immich → Recent uploads</em>.
        </p>

        <H id="backup">Backup, restore &amp; maintenance</H>
        <ul>
          <li>
            <strong>Download backup:</strong> one zip with every photo plus all ratings, colors,
            albums, tags and edits.
          </li>
          <li>
            <strong>Restore from backup:</strong> replaces <em>everything</em> in the current library
            with the backup's contents — you must type "delete" to confirm.
          </li>
          <li>
            <strong>Sync database to library:</strong> the one-stop repair. Removes database entries
            whose files vanished from disk, deletes thumbnails that belong to no photo anymore,
            regenerates missing thumbnails in the background, and reports files in the library
            folder that aren't imported.
          </li>
          <li>
            <strong>Rebuild all thumbnails:</strong> emergency reset — regenerates every
            thumbnail/preview from the originals (slow). Only needed if thumbnails still look wrong
            after a sync.
          </li>
        </ul>

        <H id="shortcuts">Keyboard shortcuts</H>
        <table className="help-shortcuts">
          <thead>
            <tr>
              <th>Where</th>
              <th>Key</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Photo view</td>
              <td>
                <kbd>←</kbd> / <kbd>→</kbd>
              </td>
              <td>Previous / next photo (walks the same filtered set you came from)</td>
            </tr>
            <tr>
              <td>Photo view</td>
              <td>
                <kbd>↑</kbd> / <kbd>↓</kbd>
              </td>
              <td>Switch between the RAW and JPEG half of a pair</td>
            </tr>
            <tr>
              <td>Photo view</td>
              <td>
                <kbd>Esc</kbd>
              </td>
              <td>Zoomed in: back to fit. Otherwise: back to the grid</td>
            </tr>
            <tr>
              <td>Editor</td>
              <td>
                <kbd>Esc</kbd>
              </td>
              <td>Exit crop mode, or close the editor</td>
            </tr>
            <tr>
              <td>Import preview</td>
              <td>
                <kbd>←</kbd> / <kbd>→</kbd> / <kbd>Esc</kbd>
              </td>
              <td>Previous / next staged file, close preview</td>
            </tr>
            <tr>
              <td>Import preview</td>
              <td>
                <kbd>0</kbd>–<kbd>5</kbd>
              </td>
              <td>Set the star rating (0 clears it)</td>
            </tr>
            <tr>
              <td>Import preview</td>
              <td>
                <kbd>Space</kbd>
              </td>
              <td>Check / uncheck whether this file is imported</td>
            </tr>
            <tr>
              <td>Grids</td>
              <td>
                <kbd>Shift</kbd> + click
              </td>
              <td>Select a range of photos (in select mode)</td>
            </tr>
          </tbody>
        </table>

        <H id="troubleshooting">Troubleshooting</H>
        <h4>The app takes very long to start, or says "Backend is taking a while"</h4>
        <p>
          The <strong>first launch</strong> after installing can take several minutes: the operating
          system verifies the app and the image engine loads for the first time. Choose{" "}
          <strong>"Keep waiting"</strong> — later launches are much faster.
        </p>
        <h4>"Backend did not start" / "stopped unexpectedly"</h4>
        <p>
          The backend writes a log you can check (the error dialog has an "Open log folder" button):
        </p>
        <ul>
          <li>
            macOS: <code>~/Library/Application Support/photo-manager-desktop/logs/backend.log</code>
          </li>
          <li>
            Windows: <code>%APPDATA%\photo-manager-desktop\logs\backend.log</code>
          </li>
          <li>
            Linux: <code>~/.config/photo-manager-desktop/logs/backend.log</code>
          </li>
        </ul>
        <h4>An Immich upload didn't arrive</h4>
        <p>
          Check <em>Settings → Immich → Recent uploads</em>: every background upload is listed there
          with a ✓ or the exact error. Uploads are retried a few times automatically; "duplicate"
          means Immich already has that photo (that's fine, not an error). If uploads keep failing,
          use "Test connection" in the same section to verify the server address and API key, and
          make sure the Immich server is reachable from this machine.
        </p>
        <h4>"Your photo library folder can't be found" at startup</h4>
        <p>
          Your library lives on a drive that isn't connected. Reconnect it and the app continues
          normally — or pick a new location (existing photos are not moved automatically).
        </p>
        <h4>Photos from an external source are missing</h4>
        <p>
          Check <em>Import tab → External photo sources</em>: a "Disconnected" source means its drive or
          network share is offline. Its photos reappear as soon as it's back.
        </p>
        <h4>Thumbnails look wrong or outdated</h4>
        <p>
          <em>Settings → Rebuild all thumbnails</em> regenerates everything from the original files.
        </p>
        <h4>Search doesn't find a photo I know is there</h4>
        <p>
          Search only covers the current scope (the album you're in) and skips photos on disconnected
          external sources. Also check the filter bar — an active rating/color/tag/date filter
          narrows search results too.
        </p>
      </div>
    </div>
  );
}

// In-app user guide. Content is maintained by hand — keep it in sync with the
// actual features (this is what "Help" in the nav and the first-run welcome
// guide point at).

export function Help() {
  return (
    <div className="page help-page">
      <h2 className="section-title">Help</h2>
      <p style={{ color: "var(--text-muted)" }}>
        Everything Photo Manager can do, in the order you'll meet it. In a hurry? Each section
        starts with the short version.
      </p>

      <h3 className="section-title" style={{ fontSize: 16 }}>
        The basics: where your photos live
      </h3>
      <p>
        Photo Manager keeps two kinds of data in two places:
      </p>
      <ul>
        <li>
          <strong>Your library folder</strong> — the folder you picked on first start. Imported
          photo files are copied here; it's yours to back up or put on an external drive. You can
          see and change it under <em>Settings → Library folder</em> (changing it restarts the app
          and does not move existing files).
        </li>
        <li>
          <strong>App data</strong> — the database, thumbnails and caches. These live in the
          standard app-data location and are rebuilt or managed automatically; you never need to
          touch them.
        </li>
      </ul>
      <p>
        The library folder on disk is the source of truth: if files disappear from it (deleted
        outside the app, drive unplugged), use <em>Settings → Sync database to library</em> to
        reconcile.
      </p>

      <h3 className="section-title" style={{ fontSize: 16 }}>
        Importing photos
      </h3>
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
          "Hide duplicates" (on by default) keeps them out of view.
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
          leave this library.
        </li>
        <li>
          <strong>"Import N photos"</strong> copies the selection into your library folder;
          "Discard" throws the staging session away.
        </li>
      </ol>

      <h3 className="section-title" style={{ fontSize: 16 }}>
        Browsing the library
      </h3>
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
        <strong>Deleting is permanent.</strong> There is no trash can: deleting removes the
        original file(s) from disk, and a RAW+JPEG pair is always deleted together. The backup
        feature (below) is your safety net.
      </p>

      <h3 className="section-title" style={{ fontSize: 16 }}>
        Search
      </h3>
      <p>
        The search box in the top bar understands <strong>plain language</strong> — try "dog on a
        beach" or "red car at night". It matches your tag names first, then ranks photos by visual
        similarity to your words (the image content itself, not filenames). Search respects the
        view you're in: inside an album it searches that album; everywhere else, the whole library.
      </p>

      <h3 className="section-title" style={{ fontSize: 16 }}>
        Culling: stars, colors, tags and Selects
      </h3>
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

      <h3 className="section-title" style={{ fontSize: 16 }}>
        The photo view
      </h3>
      <p>
        Click any photo to open it. Scroll or pinch to zoom toward the cursor, drag to pan,
        double-click to jump between fit and 100%. Below the photo: its EXIF details, tags, albums,
        a <strong>"Similar photos"</strong> strip (found by visual similarity), and{" "}
        <strong>"Download original"</strong>.
      </p>

      <h3 className="section-title" style={{ fontSize: 16 }}>
        Editing photos
      </h3>
      <p>
        <em>Detail view → Edit.</em> Editing is <strong>non-destructive</strong>: the original file
        is never modified, and the preview you see is rendered by the exact same pipeline that
        saves.
      </p>
      <ul>
        <li>
          <strong>Geometry:</strong> rotate in 90° steps, crop by dragging, composition overlays
          (rule of thirds, grid, diagonals).
        </li>
        <li>
          <strong>Film simulation:</strong> Fujifilm-style looks with an intensity slider — Provia,
          Velvia, Astia, Classic Chrome, Classic Negative, Pro Neg. Std/Hi, Eterna, Eterna Bleach
          Bypass, Acros, Monochrome, Sepia, Nostalgic Neg.
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

      <h3 className="section-title" style={{ fontSize: 16 }}>
        Albums
      </h3>
      <p>
        Create an album on the Albums page, then fill it via the bulk bar ("Add to album" — you can
        create a new album right there too) or from a photo's detail page. Removing a photo from an
        album, or deleting the whole album, never deletes the photos themselves.
      </p>

      <h3 className="section-title" style={{ fontSize: 16 }}>
        Map
      </h3>
      <p>
        The Map shows a pin for every photo with GPS coordinates in its EXIF data (phones add these
        automatically; many cameras don't). RAW+JPEG pairs appear as one pin. Click a pin to open
        the photo.
      </p>

      <h3 className="section-title" style={{ fontSize: 16 }}>
        External sources
      </h3>
      <p>
        <em>Settings → External sources.</em> An external source is a folder that is{" "}
        <strong>indexed in place</strong> — nothing is copied or moved, unlike Import. Ideal for a
        NAS or an existing archive you don't want to reorganize. Sources are re-scanned at app
        start and on demand. If the drive is unplugged the source shows as{" "}
        <strong>Disconnected</strong> and its photos are hidden until it returns. "Remove" only
        forgets the index — the files stay untouched.
      </p>

      <h3 className="section-title" style={{ fontSize: 16 }}>
        Immich
      </h3>
      <p>
        <em>Settings → Immich integration:</em> enter your server's address and an API key (create
        one in Immich under <em>Account Settings → API Keys</em>), then "Test connection". Once
        configured you can upload during import or send any selection later. Only JPEGs are
        uploaded — RAW files always stay local.
      </p>

      <h3 className="section-title" style={{ fontSize: 16 }}>
        Backup, restore &amp; maintenance
      </h3>
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
          <strong>Sync database to library:</strong> removes database entries whose files vanished
          from disk and reports files in the library folder that aren't imported.
        </li>
        <li>
          <strong>Rebuild all thumbnails:</strong> regenerates every thumbnail/preview from the
          originals.
        </li>
      </ul>

      <h3 className="section-title" style={{ fontSize: 16 }}>
        Keyboard shortcuts
      </h3>
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
            <td>Grids</td>
            <td>
              <kbd>Shift</kbd> + click
            </td>
            <td>Select a range of photos (in select mode)</td>
          </tr>
        </tbody>
      </table>

      <h3 className="section-title" style={{ fontSize: 16 }}>
        Troubleshooting
      </h3>
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
          macOS: <code>~/Library/Application Support/Photo Manager/logs/backend.log</code>
        </li>
        <li>
          Windows: <code>%APPDATA%\Photo Manager\logs\backend.log</code>
        </li>
        <li>
          Linux: <code>~/.config/Photo Manager/logs/backend.log</code>
        </li>
      </ul>
      <h4>"Your photo library folder can't be found" at startup</h4>
      <p>
        Your library lives on a drive that isn't connected. Reconnect it and the app continues
        normally — or pick a new location (existing photos are not moved automatically).
      </p>
      <h4>Photos from an external source are missing</h4>
      <p>
        Check <em>Settings → External sources</em>: a "Disconnected" source means its drive or
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
  );
}

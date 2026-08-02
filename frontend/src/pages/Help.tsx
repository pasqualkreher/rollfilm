// In-app user guide. Content is maintained by hand — keep it in sync with the
// actual features (this is what "Help" in the nav and the first-run welcome
// guide point at).

import type { ReactNode } from "react";

const SECTIONS: { id: string; title: string }[] = [
  { id: "basics", title: "The basics: where your photos live" },
  { id: "importing", title: "Importing photos" },
  { id: "import-library", title: "Importing a second library" },
  { id: "browsing", title: "Browsing the library" },
  { id: "search", title: "Search" },
  { id: "culling", title: "Culling: stars, colors, tags and Selects" },
  { id: "selects", title: "Selects: your shortlist" },
  { id: "trash", title: "Deleting & the Trash" },
  { id: "photo-view", title: "The photo view" },
  { id: "editing", title: "Editing photos" },
  { id: "auto-develop", title: "Auto develop" },
  { id: "albums", title: "Albums" },
  { id: "map", title: "Map" },
  { id: "external-sources", title: "External sources" },
  { id: "immich", title: "Immich" },
  { id: "appearance", title: "Appearance & themes" },
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
          Everything Rollfilm can do, in the order you'll meet it.
        </p>

        <nav className="help-toc" aria-label="Contents">
          {SECTIONS.map((s) => (
            <button key={s.id} className="help-toc-link" onClick={() => jumpTo(s.id)}>
              {s.title}
            </button>
          ))}
        </nav>

        <H id="basics">The basics: where your photos live</H>
        <p>Rollfilm keeps everything for a library together in one place:</p>
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
        <p>
          <strong>New here?</strong> The Settings page has a guided tour — press{" "}
          <em>"Show me around"</em> at the top of Settings and it walks you through every section,
          from appearance to backups. You can skip out at any step and rerun it anytime.
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
            Rollfilm checks every staged file against your library.{" "}
            <strong>"Already in library"</strong> means byte-identical — these can't be imported
            again. Nothing is flagged for merely looking similar, so a burst or a bracketed set
            comes in complete. "Hide duplicates" (on by default) keeps them out of view. Exception:
            a photo that so far
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
            <strong>"Add N photos to library"</strong> copies the selection into your library
            folder; "Discard batch" throws the staging session away.
          </li>
        </ol>


        <H id="import-library">Importing a second library</H>
        <p>
          Took a small drive travelling, made a library on it and culled the trip there? Back home,{" "}
          <em>Import → Import a library</em> folds it into this one. Importing that drive as a plain
          folder would bring the photos across too — but leave behind exactly the part the trip was
          spent on. This carries it with them:
        </p>
        <ul>
          <li>
            Stars, colour labels, tags and every edit come across with each photo. Albums and tags
            merge <strong>by name</strong>, so "Iceland 2026" joins the album you already have
            instead of becoming a second one with the same name. RAW+JPEG pairs stay paired.
          </li>
          <li>
            A photo this library already has (byte for byte) keeps its file where it is and only
            takes over the ratings and edits you gave it on the trip — the newer decision wins.
          </li>
          <li>
            Nothing here is removed, and <strong>the other drive is only ever read</strong>. Its
            Trash stays behind (you threw those away on purpose), as do photos it merely indexes in
            place from somewhere else.
          </li>
          <li>
            The copy runs in the background: you can keep browsing, editing, even import a card
            while it works. It shows how far along it is and roughly how long is left, and it can be
            stopped — a stopped import keeps everything that already came across, and running it
            again picks up where it left off.
          </li>
        </ul>
        <p>
          Both libraries have to be on the same Rollfilm version. If the travel one is older, open
          it once with this version (<em>Settings → Library folder</em>) so it can update itself,
          then merge it.
        </p>

        <H id="browsing">Browsing the library</H>
        <p>
          The Library is a newest-first timeline grouped by month, with a{" "}
          <strong>date scrubber</strong> on the right edge — drag it to jump years at a time.
        </p>
        <ul>
          <li>
            <strong>Filters:</strong> album, minimum star rating, color label, tags (a photo must
            carry <em>all</em> selected tags), camera, lens, a focal-length range slider and a
            capture-date range. The options <strong>cross-filter</strong> each other: pick a camera
            and the lens and focal-length choices narrow to what that camera actually shot. "Clear"
            resets everything.
          </li>
          <li>
            <strong>View mode:</strong> show RAW + JPEG, only JPEGs, or only RAWs. With{" "}
            <strong>"Merge RAW+JPG"</strong> a pair appears as a single card — rating, labeling or
            deleting it applies to both files.
          </li>
          <li>
            <strong>Thumbnail size:</strong> S / M / L.
          </li>
          <li>
            <strong>Selection &amp; bulk actions:</strong> press "Select", click photos (shift-click
            for a range), then use the bottom bar: set stars or a color label, add a tag, add to an
            album, add to Selects, send to Immich, <strong>Auto develop</strong> the whole selection
            or <strong>apply a saved editor preset</strong> to it (see "Editing photos" and "Auto
            develop"), <strong>Reset…</strong> chosen aspects back to the just-imported state (pick
            any of stars, colors, tags, albums, edits, crop &amp; geometry) — or delete.
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
            <strong>Selects</strong> is your shortlist basket — add photos from anywhere and hand
            them out in one go. See the next section.
          </li>
        </ul>

        <H id="selects">Selects: your shortlist</H>
        <p>
          The <strong>Selects</strong> tab is a temporary shortlist: while you browse, add the shots
          you want to hand out — from the Library's bulk bar ("Add to Selects"), inside an album, or
          on a photo's page. The nav shows a live count. It's not an album and nothing about the
          photos changes; it's the tray where a picking session ends before the photos leave the
          app.
        </p>
        <ul>
          <li>
            <strong>Review the set:</strong> everything is pre-selected — untick the ones you're
            dropping (shift-click for a range), or remove them from the list entirely. The actions
            always apply to your current selection, or to the whole list when nothing is ticked.
          </li>
          <li>
            <strong>Export…</strong> gets the photos out, in one of two ways: as finished{" "}
            <strong>JPEGs with your edits baked in</strong> (quality and size of your choice), or as
            the <strong>original files, 1:1</strong> — exactly as they are in your library, RAW
            stays RAW, every meta tag kept. Several photos download as a zip.
          </li>
          <li>
            <strong>Add to Immich</strong> uploads the JPEGs of the set to your Immich server (shown
            only when the integration is configured; RAW files are skipped).
          </li>
          <li>
            <strong>Remove from selects</strong> takes the selected photos out of the tray when
            you're done (with everything selected it empties it) — the photos themselves stay
            untouched in your library.
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
          double-click to jump between fit and 100%. The panel beside the photo holds its EXIF
          details (capture date, camera, <strong>lens</strong>, ISO, aperture, shutter, focal
          length), tags, albums, a <strong>"Similar photos"</strong> strip (found by visual
          similarity), and <strong>"Export…"</strong> — a full-resolution JPEG with your edits baked
          in at a quality and size you choose, or the original file 1:1 with all meta tags (several
          photos at once export from the Selects page). The <strong>trash can</strong> next to the
          file name deletes the photo (see "Deleting &amp; the Trash").
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
            <strong>Film simulation:</strong> built-in Fuji-style looks (Provia, Velvia, Astia,
            Classic Chrome, Classic Neg., Nostalgic Neg., Eterna, Acros and more) with a strength
            slider — the look becomes the base your other adjustments build on.
          </li>
          <li>
            <strong>Curves:</strong> a point curve per channel (luma, red, green, blue) drawn over
            that channel's histogram, or the parametric region sliders. Click to add a point and drag
            it in one go, Shift-drag to hold its input value, arrow keys to nudge, double-click to
            remove. The target button aims the curve at the photo: point at a tone and drag up or
            down, and the point for exactly that tone moves with you.
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
            distortion, vignette, mist, grain and grain size, plus a <strong>white frame</strong> — a
            matte border drawn around the photo that saves and exports with it like any other
            adjustment.
          </li>
          <li>
            <strong>Masks</strong> (local adjustments): radial, linear, brush, luminance and color
            regions, each with its own set of sliders, combined by adding, subtracting or
            intersecting. <strong>Select subject</strong> finds a region for you — sky, water,
            greenery, people, buildings or ground — and drops it in as a mask you can then refine
            like any other. The first subject on a photo takes a few seconds to analyse (the
            detection model downloads itself once, on first use); any further subject on the same
            photo is instant. Change the crop or straighten afterwards and the mask says so, with a
            button to find it again in the new frame. The selected mask is marked on the photo so
            you can see what it covers; the marking steps out of the way as soon as you move a
            slider, and comes back when you click the mask in the list again.
          </li>
          <li>
            <strong>Presets:</strong> save your current look under a name and reapply it to other
            photos (crop/rotation are not part of a preset). You can also apply a saved preset to a
            whole selection at once from the Library's bulk bar ("Apply preset…").
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
          <li>
            <strong>Getting photos out:</strong> use <strong>Export…</strong> on the photo page (or
            the Selects page for many at once) to render a JPEG with the edits baked in. For the best
            quality, export the edited original — exporting a saved copy re-compresses an
            already-compressed JPEG.
          </li>
        </ul>

        <H id="auto-develop">Auto develop</H>
        <p>
          Auto develop suggests edit settings <strong>learned from your own editing</strong> — there's
          no cloud and no generic "AI look". It's off until you turn it on under{" "}
          <em>Settings → Auto develop</em>, which also explains how it learns.
        </p>
        <p>How it works:</p>
        <ul>
          <li>
            Every photo you've edited — saved in place or saved as a copy — becomes an example. When
            you ask for a suggestion, Auto develop finds the examples that look most{" "}
            <strong>visually similar</strong> to the current photo and blends the settings you chose
            for them, weighting the closest matches most. So it works from a single edited photo, and
            the more you edit, the closer the matches and the better the suggestions.
          </li>
          <li>
            RAW and JPEG photos learn from their own kind where possible (a RAW is developed from
            flat, a camera JPEG only fine-tuned), and it never learns from the photo you're editing or
            its RAW+JPEG partner.
          </li>
          <li>
            It suggests the sliders and color settings, but never <strong>crop, rotation or
            masks</strong> — those belong to one specific photo and don't transfer.
          </li>
        </ul>
        <p>Using it:</p>
        <ul>
          <li>
            <strong>In the editor:</strong> once enabled, an <strong>Auto</strong> button appears in
            the footer. It only fills the sliders with a suggestion — nothing is applied to your photo
            until you <em>Save</em> — so you can tweak it further or reset and try again. Masks you've
            drawn are kept.
          </li>
          <li>
            <strong>On a selection:</strong> pick photos in the Library and press{" "}
            <strong>Auto develop</strong> in the bulk bar to develop each one with its own suggestion.
            Photos with nothing similar to learn from yet (or whose analysis isn't ready) are skipped
            and counted. This one <em>does</em> change the photos — it asks first if any already have
            edits.
          </li>
          <li>
            <strong>Which settings it may change:</strong> in Settings you can limit Auto to specific
            groups — Tone, White balance, Color, Details, Curves, Effects. Unchecked groups keep
            whatever the sliders currently hold, so you can let it handle, say, tone and color while
            you set the rest yourself.
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
          The Immich integration can mirror (parts of) your library to an{" "}
          <a href="https://immich.app" target="_blank" rel="noreferrer">
            Immich
          </a>{" "}
          server — e.g. to view your photos on your phone or share them with family. Only JPEGs are
          ever uploaded; RAW files always stay local.
        </p>
        <h4>Setting it up</h4>
        <ol>
          <li>
            <strong>Server address:</strong> under <em>Settings → Immich integration</em>, enter the
            URL you use to open Immich in the browser, e.g.{" "}
            <code>https://immich.example.com</code> or <code>http://192.168.1.50:2283</code>.
          </li>
          <li>
            <strong>API key:</strong> in Immich (not in this app), click your avatar →{" "}
            <em>Account Settings → API Keys → New API Key</em>. The key is shown{" "}
            <strong>only once</strong> — copy it right away and paste it into the API key field
            here.
          </li>
          <li>
            <strong>Test connection</strong> confirms the address and key work — it should greet
            you with your Immich account name.
          </li>
        </ol>
        <h4>Which API key permissions are needed?</h4>
        <p>
          Newer Immich versions let you restrict an API key to specific permissions when creating
          it. Selecting <strong>"All"</strong> simply works. If you prefer a minimal key, it needs:
        </p>
        <ul>
          <li>
            <strong>Assets:</strong> <code>asset.upload</code> (send photos — also covers
            recognizing photos Immich already has), <code>asset.delete</code> (remove photos you
            trash or delete here)
          </li>
          <li>
            <strong>Albums:</strong> <code>album.create</code>, <code>album.read</code>,{" "}
            <code>album.update</code>, <code>album.delete</code> — plus{" "}
            <code>albumAsset.create</code> / <code>albumAsset.delete</code> for putting photos into
            / taking them out of mirrored albums
          </li>
          <li>
            <strong>User:</strong> <code>user.read</code> (used by "Test connection")
          </li>
        </ul>
        <p>
          Older Immich versions don't ask — their keys always have full access. If something fails
          with a permission error in <em>Recent uploads</em>, recreate the key with "All".
        </p>
        <h4>Sync modes</h4>
        <ul>
          <li>
            <strong>Manual</strong> (default): nothing happens automatically. You push photos
            yourself — the "Also upload to Immich" checkbox during import, or "Add to Immich" on a
            selection.
          </li>
          <li>
            <strong>Selective:</strong> you mark what should live on Immich — the "Sync to Immich"
            checkbox on a selection in the Library, or on an album. Marked photos upload
            automatically and stay in sync.
          </li>
          <li>
            <strong>Full:</strong> every JPEG and every album is mirrored automatically.
          </li>
        </ul>
        <h4>What "in sync" means</h4>
        <p>
          In the selective and full modes, Immich mirrors what's visible in your library. A
          background check runs at every app start and once a minute, so changes follow within
          about a minute even if Immich was briefly unreachable:
        </p>
        <ul>
          <li>New or restored photos are uploaded; photos in the Trash are removed from Immich.</li>
          <li>
            <strong>"Delete forever"</strong> also removes the photo from Immich, permanently.
          </li>
          <li>
            Mirrored albums follow along: adding/removing photos, renaming and deleting an album
            all happen on Immich too (deleting an album never deletes photos — on either side).
          </li>
          <li>
            Unticking a "Sync to Immich" checkbox only <em>stops syncing</em> — photos already on
            Immich stay there. Removing happens exclusively via the Trash.
          </li>
        </ul>
        <p>
          Every upload and removal is listed with ✓ or the exact error under{" "}
          <em>Settings → Immich → Recent uploads</em>; network hiccups are retried automatically.
        </p>

        <H id="appearance">Appearance &amp; themes</H>
        <p>
          Under <em>Settings → Appearance</em> you can pick a color theme (skin). Choose{" "}
          <strong>System</strong> to follow your operating system's light/dark setting, or pick one
          of the light skins (Light, Soft Grey, Sepia, Rosé) or dark skins (Dim, Dark, Vintage, Nord,
          Forest). Each tile previews its own colors, and the choice is remembered per computer — it
          applies to the whole app immediately.
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
              <td>Editor</td>
              <td>
                <kbd>1</kbd>–<kbd>8</kbd>
              </td>
              <td>
                Open a control section: 1 Transform, 2 Tone, 3 Curves, 4 Color, 5 Details,
                6 Effects, 7 Masks, 8 Presets
              </td>
            </tr>
            <tr>
              <td>Editor</td>
              <td>
                <kbd>↑</kbd> / <kbd>↓</kbd>
              </td>
              <td>Step through the sliders of the open section</td>
            </tr>
            <tr>
              <td>Editor</td>
              <td>
                <kbd>←</kbd> / <kbd>→</kbd>
              </td>
              <td>Adjust the focused slider's value</td>
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
        <h4>Quitting says Rollfilm is "still working"</h4>
        <p>
          Some work outlives the screen that started it: uploads to Immich, thumbnails an import
          couldn't hand over ready-made, the search index catching up, a library being merged in.
          Quitting mid-way is safe — your photos and edits are already saved, and everything except
          queued Immich uploads in manual mode is picked up again on the next start.{" "}
          <strong>"Finish in background"</strong> closes the window and quits by itself once it's
          done; <strong>"Quit now"</strong> stops the rest.
        </p>
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
            macOS: <code>~/Library/Application Support/Rollfilm/logs/backend.log</code>
          </li>
          <li>
            Windows: <code>%APPDATA%\Rollfilm\logs\backend.log</code>
          </li>
          <li>
            Linux: <code>~/.config/Rollfilm/logs/backend.log</code>
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

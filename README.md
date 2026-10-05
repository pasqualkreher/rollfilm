<div align="center">

<img src="docs/screenshots/logo.svg" alt="Rollfilm logo" width="90">

# Rollfilm

**From memory card to finished photo. One app, on your own computer.**

Import, cull, search, edit and lay out on a page — in a single window — then mirror
the keepers to your [Immich](https://immich.app) server. Search your library by
describing what you remember, browse it on a map and a timeline, shoot RAW, edit
non-destructively, print what you made.<br>
**No account. No cloud. No Docker. No setup.**

[![Latest release](https://img.shields.io/github/v/release/pasqualkreher/Rollfilm?label=release&color=4c8dae)](https://github.com/pasqualkreher/Rollfilm/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/pasqualkreher/Rollfilm/total?color=4c8dae)](https://github.com/pasqualkreher/Rollfilm/releases)
[![CI](https://github.com/pasqualkreher/Rollfilm/actions/workflows/ci.yml/badge.svg)](https://github.com/pasqualkreher/Rollfilm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20·%20Windows%20·%20Linux-lightgrey)](#download--installation)
[![GitHub stars](https://img.shields.io/github/stars/pasqualkreher/Rollfilm?style=flat&color=f5c518)](https://github.com/pasqualkreher/Rollfilm/stargazers)
[![Donate with PayPal](https://img.shields.io/badge/donate-PayPal-0070ba?logo=paypal&logoColor=white)](https://www.paypal.com/donate/?hosted_button_id=TE6RWWJ7JRPKN)

**[⬇ Download](#download--installation)** · [Why Rollfilm](#why-rollfilm) · [Screenshots](#screenshots) · [Features](#features) · [Contributing](#contributing) · [Donate](#support-the-project) · [rollfilm.org](https://rollfilm.org)

<a href="https://rollfilm.org"><img src="docs/screenshots/library.jpg" alt="Rollfilm library view" width="850"></a>

</div>

## Try it in five minutes

1. **Download** the installer for macOS, Windows or Linux from the [Releases page](https://github.com/pasqualkreher/Rollfilm/releases/latest).
2. **Start it.** There is nothing to configure. On first launch Rollfilm fetches the search model once; after that it works fully offline.
3. **Plug in a card** or point it at a folder. Cull on the import light table, then type *"sunset at the beach"* into search and watch it find the shot.

Your photos stay on your own machine. Rollfilm copies them into a managed library, makes them searchable with natural language, and can optionally mirror your library to an existing Immich server.

> **Project status: work in progress.**
> An early but already very usable release. The core — import pipeline, library organization, semantic search, and especially the Immich integration — works well and is used daily. The built-in photo editor is experimental and should be seen as a fun extra rather than a finished feature (see [Photo editor](#photo-editor-experimental)).

## Why Rollfilm

- **Search by describing, not by tagging.** CLIP embeddings live in your local SQLite database. "Dog in the snow", "red bicycle against a wall" — no tags, no cloud API, no upload.
- **An import you actually look forward to.** Photos are staged and shown on a light table while they copy. Compare, pick, reject and rate while the rest is still coming off the card.
- **An import you can put down.** A session stays open until you end it: cull half a card today, pull it, and pick the same session up tomorrow — it recognises the card when it comes back and copies only what is still missing.
- **A page, not just a grid.** Put photos on a canvas — a photo book page, a poster, a contact sheet — move and crop them by hand, add captions, edit a photo right there, and export a lossless PDF for the print shop.
- **Immich as a destination, not a replacement.** Keep a fast local desktop library and let Rollfilm mirror it to your Immich server: manual, selective or everything. Albums, deletions and RAW+JPEG pairs follow.
- **Your originals are never touched.** Edits, stars, tags and albums live in the database beside the files. Rename or move a photo in Finder and it is matched back by content, not by name.
- **One window for the whole path.** Timeline, map, gear filters, statistics, a non-destructive editor with masks — without switching apps.
- **Nothing to run, nothing to host.** A native desktop app. No account, no server, no Docker, no subscription.

### Is it for you?

| Rollfilm is a good fit if you… | Look elsewhere if you… |
| :--- | :--- |
| shoot RAW+JPEG and want to cull straight off the card | need multiple users, a web UI or mobile access |
| want natural-language search that never leaves your machine | want a finished, Lightroom-class editor today |
| run Immich and want a local library feeding it | need a code-signed, commercially supported app |
| like keeping full control over your files on disk | are looking for a cloud service |

## Screenshots

More on [rollfilm.org](https://rollfilm.org/#gallery).

| | |
| :---: | :---: |
| <img src="docs/screenshots/search.jpg" alt="Semantic search" width="420"><br>**Semantic search**: describe what you remember | <img src="docs/screenshots/map.jpg" alt="Map view" width="420"><br>**Map view**: every geotagged photo |
| <img src="docs/screenshots/import-lighttable.jpg" alt="Import light table" width="420"><br>**Import review**: stage, compare, pick, with the camera settings beside the photo | <img src="docs/screenshots/import-start.jpg" alt="New import session dialog" width="420"><br>**Import start**: copy the card or leave the photos where they are |
| <img src="docs/screenshots/import-sessions.jpg" alt="Open import sessions" width="420"><br>**Import sessions**: an import stays open until you end it, pull the card and come back later | <img src="docs/screenshots/immich-sync.jpg" alt="Immich sync modes" width="420"><br>**Immich sync**: your library, mirrored |
| <img src="docs/screenshots/edit-masks.jpg" alt="Photo editor with a mask" width="420"><br>**Editor**: non-destructive, with masks that find the sky by themselves | <img src="docs/screenshots/edit-compare.jpg" alt="Comparing an edit against the original" width="420"><br>**Compare**: split by a draggable line, or side by side |
| <img src="docs/screenshots/edit-film.jpg" alt="Film simulation list in the editor" width="420"><br>**Film simulations**: over a hundred looks over your own photo | <img src="docs/screenshots/edit-camera-jpg.jpg" alt="A RAW edit compared with the camera JPG" width="420"><br>**Camera JPG**: your RAW edit against the JPG the camera made |
| <img src="docs/screenshots/edit-lens.jpg" alt="Lens correction in the editor" width="420"><br>**Lens correction**: distortion and vignetting from the lens data in the RAW | <img src="docs/screenshots/edit-nr.jpg" alt="Noise reduction at 200 percent" width="420"><br>**Noise reduction**: ISO 12800 at 200%, original left, cleaned right |
| <img src="docs/screenshots/edit-wb.jpg" alt="White balance controls" width="420"><br>**White balance**: Kelvin, tint and the usual lights one click away | <img src="docs/screenshots/edit-presets.jpg" alt="Preset list in the editor" width="420"><br>**Presets**: save a look once, apply it with one click |
| <img src="docs/screenshots/canvas.jpg" alt="Canvas editor with photos laid out on a page" width="420"><br>**Canvas**: lay photos out on a page, print or export it | <img src="docs/screenshots/canvas-edit.jpg" alt="Canvas with the photo editor docked beside the page" width="420"><br>**Canvas edit**: edit a photo right on the page, the original stays untouched |
| <img src="docs/screenshots/albums-wide.jpg" alt="Albums page" width="420"><br>**Albums**: countries, years and months, plus your own | <img src="docs/screenshots/stats.jpg" alt="Library statistics" width="420"><br>**Statistics**: the gear you actually use |

Three quiet skins, each in light and dark, with a switch that can follow the system:

<img src="docs/screenshots/themes.jpg" alt="Appearance dialog with the Stone, Pebble and Paper skins" width="850">

## Features

| | Highlights |
| :--- | :--- |
| **Import** | Staged import wizard with a light table, one start dialog (copy the card or leave the photos in place, with an optional backup folder), sessions that stay open until you end them, RAW+JPEG pairing, byte-identical duplicate detection, EXIF and lens data, reverse geocoding |
| **Organize** | Albums, smart albums, tags with bulk tagging, star ratings, color labels, selects/picks, per-photo notes, trash with retention, a right-click menu on every photo, chips that say which albums and canvases a photo is in |
| **Search** | Local semantic search, image-to-image similarity, gear filters that cross-filter each other, map, exact-scrolling timeline, statistics |
| **Immich** | Three sync modes, background reconciliation every 60 s, album mirroring, durable deletion queue, optional RAW upload |
| **Edit** *(experimental)* | Non-destructive, backend-rendered, lens correction from the camera's own data, twenty film simulations and 105 film stocks, masks with local AI subject selection, tone curves on the histogram, Kelvin white balance, luminance and color noise reduction, presets, auto develop learned from your own edits, virtual copies |
| **Canvas** | Pages or one free sheet, A4/A3/Letter/square or any size in mm, drag, crop-in-frame, rotate, snap, captions, the editor docked beside the page, print view and lossless PDF export |
| **Safety** | Originals never modified, renames survive Finder, backup and restore as one zip, external folders mounted read-only |

<details>
<summary><b>Library &amp; import — full list</b></summary>

- **Staged import wizard** — photos are copied at the speed of the media, reviewed in a virtualized grid that stays responsive at thousands of files, and analyzed in the background while you're already culling
- **Sessions you can come back to** — *Continue later* keeps your ticks, stars, labels and the files already copied; *Open import sessions* on the Import page lists what is still open and *Continue* copies only what isn't copied yet, including photos shot onto the card since. Photos already added in an earlier round stay visible, marked as in the library and blocked from coming in twice
- **The card, not its path** — a session remembers the card itself, so it is recognised even when the computer mounts it under another name, and a different card under the same name is not mistaken for it. An unplugged card shows as *Not connected* until it returns
- **One session, several sources** — *Add folder…* / *Add photos…* in the review collect from more than one card or folder into the same session, each tracked and continued on its own
- **Copy the card, or leave the photos where they are.** One start dialog per import decides: copy everything into an import folder of the session's own, so the card can go back in the camera, or add the photos in place without copying. The import folder can be kept as a backup of everything that was read, and Settings can remember the answer so the dialog never comes up
- **Straight into an album.** An album choice next to *Add to library* files the chosen photos as they come in
- **Camera settings while you cull.** I, or the Info button, opens camera, lens and exposure beside the staged photo
- **RAW support** (via rawpy) with automatic RAW+JPEG pairing; a pair shares its stars, colour label, tags and notes
- **EXIF extraction** (ExifTool) — capture date, camera, **lens**, exposure data — and reverse geocoding of GPS coordinates to country/place
- **Duplicate detection** during import — byte-identical files only, so a burst or a bracketed set comes in complete
- **Import a second library** — take a small drive travelling, cull the trip on it, and fold it into your main library at home *with* the stars, colour labels, edits, tags and albums you gave the photos on the road
- Albums, smart albums, tags (with bulk tagging), star ratings, color labels, and a selects/picks workflow
- **Select without a mode** — Cmd/Ctrl-click or Shift-click the first photo and checkboxes appear on every tile; Cmd/Ctrl+A takes everything, Esc clears, E opens a single picked photo in the editor. A plain click still opens the photo
- **Right-click any photo** — export, save a copy, or show the file in Finder / Explorer; on a selected photo the action applies to the whole selection
- **Export the way it is needed** — JPEG, 16-bit TIFF or the original files; camera data, stars and tags written into the file (or left out, with or without the location); file names from a pattern like `{date}_{seq}`; straight into a folder or as a download; output sharpening and a text watermark; and presets that keep a whole set of choices under a name
- **Where a photo lives** — album and canvas chips beside each photo and on the grid's hover card, each a link into that album or canvas, with an × to take the photo out
- **Rename photos from the app** — the file on disk is renamed with them, the RAW/JPEG partner follows to the same name, and the photo keeps its stars, tags, albums, edits and cached previews
- **Notes** per photo, stored in the database like every other edit
- **Renames survive Finder** — a photo you rename or move outside the app is matched back by its content, not its name, so it keeps everything you gave it instead of being treated as deleted
- **Trash** with configurable retention and automatic background purge — a deletion keeps the photo's stars, tags, albums and edits, and Restore brings it all back
- **Backup & restore** — one zip with every photo plus all ratings, colors, albums, tags and edits, and a one-click "sync database to library" repair

</details>

<details>
<summary><b>Search &amp; browsing — full list</b></summary>

- **Semantic search** — describe what you're looking for in natural language ("sunset at the beach", "dog in the snow"). Powered by CLIP embeddings stored in SQLite via `sqlite-vec`, fully local, no cloud API
- Image-to-image similarity search
- **Gear-aware filters** — narrow the library by camera, lens or a focal-length range slider; the filter options cross-filter each other (pick a camera and the lens list shrinks to what that camera actually shot), and the filter bar can be **pinned open** so it stays put while you cull
- **Smart albums** with the same filter bar as the library — JPEG/RAW, rating, colour label, tags, date range
- **Map view** (Leaflet) of all geotagged photos
- **A timeline that stays out of the way at any size** — the whole library is laid out up front, so the scrollbar is exact from the first frame and the date scrubber on the right lands anywhere in it instantly; only the tiles near the viewport are ever mounted
- **Details without leaving the grid** — hover a tile for an "i" that opens camera, lens, exposure, tags and albums beside it
- **Statistics** — photos per year, plus which camera bodies, lenses and focal-length ranges you actually shoot, how your ratings fall, and what the library is made of
- **Look & feel.** Three light/dark skin pairs (Stone, Pebble, Paper), a light one and a dark one chosen separately with a Light / Dark / Auto switch that can follow the system; rounded or square corners; the interface typeface picked from what your system already has

</details>

<details>
<summary><b>Immich integration ⭐ — full list</b></summary>

One of the highlights of the project: keep your library mirrored to an existing [Immich](https://immich.app) server without giving up local-first management.

- Configure server URL + API key directly in the app (Settings → Immich) — nothing goes into config files
- **Three sync modes:**
  - `manual` — per-import checkbox and on-demand "Add to Immich" buttons
  - `selective` — only photos and albums you flag for sync
  - `full` — every photo and album is mirrored automatically
- **Background reconciliation loop** — runs at startup and every 60 seconds: uploads missing assets, backfills asset IDs (checksum-based, so Immich deduplicates correctly), mirrors app albums to Immich albums, and propagates deletions through a durable pending-deletion queue
- Per-image exponential backoff on failures; event-driven uploads for instant sync after import
- **JPEGs by default, RAWs on request** — an off-by-default option also uploads RAW files; a RAW follows its paired JPEG, so a flagged or mirrored shot arrives as JPEG + RAW (ready for stacking in Immich)
- Immich mirrors only your *visible* library — the local library always remains the recoverable source of truth

</details>

<details>
<summary><b>Canvas — full list</b></summary>

A free design surface: place photos where you want them instead of where the grid puts them, then print or export the result.

- **Make one from a selection** — pick photos in the Library, an album or Selects and choose *Add to… → canvas*; in merged view the RAW partner comes along. A canvas has its own photos, kept on a filmstrip along the bottom until you put them on the paper
- **Two kinds of paper** — *Pages* is a run of sheets of one size, like a photo book, with a rail to add, copy and reorder pages; *Free canvas* is one endless sheet with an optional page guide so you can still design for print
- **Any paper size** — A4, A3, US Letter, two squares, or a width and height in millimetres; separate side and top/bottom margins; a measuring grid that is never printed
- **Laying out** — drag from the filmstrip, resize with locked or free proportions, rotate (Shift for 15° steps), *crop in frame* to move and zoom the picture inside its frame, a coloured border per photo, copy and paste settings between items, stack with bring-to-front / send-to-back, snapping to other items, page edges, centre lines and margins
- **Captions** — text boxes with any font installed on the computer, weight, italic, size in millimetres, colour and alignment
- **Edit a photo on the page** — *Edit photo* docks the full editor beside the paper and develops a virtual copy, so each canvas can have its own version of a picture and the library original is never changed; masks are drawn on the frame itself
- **Print view and export** — the paper alone, page by page, in a focus mode that takes the whole screen; export is a PDF at the exact page size with every photo lossless at full resolution and text as real text, or a single self-contained HTML file. Never a re-compressed JPEG
- **It saves itself** — no Save button and no "discard changes?" question; every change is written a moment later, and undo/redo covers every step
- **Focus mode** — F hides every bar; the paper stays editable and gets the whole window

</details>

<details>
<summary><b>External sources</b></summary>

- **Index photo collections in place** (e.g. a NAS) — read-only, without copying anything into the managed library
- Browse any mounted drive directly from the app

</details>

<a name="photo-editor-experimental"></a>
<details>
<summary><b>Photo editor (experimental) — full list</b></summary>

A non-destructive editor is included, but consider it a gimmick for now — it's fun to play with, not a Lightroom replacement.

- All rendering happens **in the app's backend**, so the live preview is pixel-identical to the exported result
- **Built to keep up** — while a slider is being dragged, only the pixels your screen can actually show are rendered (zoomed in, only the visible tile), so editing stays fluid even on 40MP RAWs
- Edits are stored as values in the database; originals are never touched
- **It saves itself** — no Save button: edits are written a moment after a slider comes to rest and again when you close. Small dots on sliders and sections show where the edits are
- **Focus mode** — F hides the app's bars, P the panel, so the photo gets the whole window
- **Lens correction.** RAW files are corrected for distortion and vignetting from the data the camera stored (Fujifilm, Sony, OM System, Panasonic, DNG), with the Lensfun database for the rest. A switch and two strength sliders under Transform
- **125 film looks** with a strength slider: twenty Fujifilm simulations, from Provia and Velvia to Classic Neg., Acros and Sepia, and 105 film stocks in sections — negative, cinema, slide, black & white (Tri-X, HP5, Delta, T-Max), instant and cross-processed film — that take the stock's colour and keep to the simulations' tone, so no look crushes the shadows. Twenty-one are derived from [spektrafilm](https://github.com/andreavolpato/spektrafilm) by Andrea Volpato, 72 from the [RawTherapee Film Simulation Collection](http://rawtherapee.com/shared/HaldCLUT.zip) by Pat David, Pavlov Dmitry and Michael Ezra (both CC BY-SA 4.0), seven from [spectral_film_lut](https://github.com/JanLohse/spectral_film_lut) by Jan Lohse and five from [t3mujinpack](https://github.com/t3mujin/t3mujinpack) by João Almeida (both MIT). A Basic or AgX tone mapper keeps a look's colours
- **Noise reduction** in three sliders: luminance, luminance detail and colour
- Exposure/contrast/highlights/shadows, white balance in Kelvin with presets for daylight, cloudy, shade, tungsten and fluorescent, HSL color mixer, color grading wheels, crop/rotate/perspective, and effects like grain, vignette, clarity, film-style diffusion and a white matte frame
- **Tone curves drawn over the photo's own histogram**, with a targeted picker: point at something in the image and drag to move the curve where that tone actually lives
- **Masks** — radial, linear, brush, luminance and color, plus **AI subject selection** (sky, water, greenery, people, buildings, ground) run locally with SegFormer. Point at a mask in the list and it marks what it covers
- **Compare against the original, a snapshot or the camera's JPG.** Split by a divider you drag across the photo, or the two side by side. A RAW shot together with a JPG can be held against that JPG. On a RAW the original half is shown with the library's auto-exposure, so the comparison isn't just "the edit is brighter"
- **Presets.** Save a look, apply it from a list with one click, to one photo or a whole selection, and export or import presets as a file
- **Working resolution.** The editor preview renders at 100%, 70% or 50%, a setting for slower machines
- **Physical and virtual copies** — *Save copy* bakes an edit into a new file in the library; a virtual copy is a second, independently editable version of the same file that costs no disk space
- **Auto develop** — an optional "Auto" button that suggests develop settings *learned from your own edits*: a local CLIP k-nearest-neighbor recommender finds the photos you've already edited that look most like the one you're working on and blends their settings. No training step, no cloud — every edit you save immediately makes the next suggestion better. Works on a single photo or a whole selection at once

</details>

## Download & installation

Prebuilt installers for macOS, Windows, and Linux are on the [Releases page](https://github.com/pasqualkreher/Rollfilm/releases/latest) and on [rollfilm.org](https://rollfilm.org/#download).

| Platform | Get it | First launch |
| :--- | :--- | :--- |
| **macOS** (Apple Silicon) | `Rollfilm-<version>-arm64.dmg` | One-time Gatekeeper step, see [below](#macos-apple-silicon) |
| **Windows** | `Rollfilm-Setup-<version>.exe` | SmartScreen: **More info → Run anyway** |
| **Linux** | `Rollfilm-<version>.AppImage` | `chmod +x` and run |

On first start the app downloads the CLIP model for semantic search; after that everything works offline.

> **The installers are not code-signed.** An Apple Developer membership is 99 € a year and a Windows certificate costs on top of that; Rollfilm is an unpaid hobby project. Nothing is wrong with the download — both systems will say so in their own way, and the steps below are how you get past it. Every installer is published with a `.sha256` file next to it if you want to verify what you downloaded.

### macOS (Apple Silicon)

The quickest route — download in the terminal, so macOS never tags the file as quarantined and no dialog ever appears:

```bash
curl -L -o ~/Downloads/Rollfilm.dmg "$(curl -fsSL \
  https://api.github.com/repos/pasqualkreher/Rollfilm/releases/latest \
  | grep -o 'https://[^"]*arm64\.dmg' | head -n1)"
open ~/Downloads/Rollfilm.dmg
```

Drag Rollfilm into `/Applications` and start it.

<details>
<summary><b>Already downloaded in the browser? Two other routes, and what is actually going on</b></summary>

**What's going on:** when a browser downloads a file, it tags it with an attribute called `com.apple.quarantine`. On a tagged app that Apple hasn't notarized, Gatekeeper refuses the first launch. So there are three ways in — one that avoids the tag (the `curl` route above), one that removes it, one that leaves it and approves the app instead. Any of them works; they differ only in whether you want to touch a terminal.

**B · Strip the tag off.** Drag Rollfilm into `/Applications`, then run once:

```bash
xattr -dr com.apple.quarantine "/Applications/Rollfilm.app"
```

This deletes the attribute the browser added (`-d`) from the whole app bundle (`-r`). Afterwards the app is in exactly the state the `curl` route would have produced. You do *not* have to try launching it first.

**C · No terminal at all — approve the app in System Settings.** Drag Rollfilm into `/Applications`, then:

1. Open Rollfilm. macOS refuses and shows a warning — close it.
2. Go to **System Settings → Privacy & Security** and scroll to the bottom.
3. Next to *"Rollfilm was blocked to protect your Mac"* click **Open Anyway**, confirm, and enter your admin password.
4. From then on Rollfilm starts by double-click like any other app.

Step 1 is not optional here — the entry in System Settings only appears *after* a blocked launch attempt. On macOS 14 and older there was a shortcut (right-click → **Open**); Apple removed it in macOS 15 Sequoia.

**The difference:** the `curl` route and B end up identical — no quarantine attribute, so Gatekeeper has nothing to complain about. C leaves the attribute in place and instead records a one-time exception for this specific app. All three are permanent for the copy you installed; a future version you download in a browser goes through the same thing again.

</details>

### Windows

Run `Rollfilm-Setup-<version>.exe`. SmartScreen will warn about an unknown publisher — choose **More info → Run anyway**.

### Linux

Download `Rollfilm-<version>.AppImage`, make it executable (`chmod +x Rollfilm-*.AppImage`) and run it.

### Updates

The app updates itself: it checks the Releases page, downloads the new version in the background and applies it on the next quit. Only what changed is downloaded — some tens of MB, not the whole installer again. (On a Mac the first update after an install is still the whole thing; the app keeps that download in `~/Library/Caches/rollfilm-desktop-updater` as the base for the next ones.)

**On macOS this needs the app to sit somewhere it may replace itself** — in practice: dragged into Applications. The usual updater for Mac apps refuses an unsigned build, so Rollfilm unpacks the new version and trades the app bundle itself once it has quit. Run straight from the disk image, or where macOS doesn't allow the swap, it falls back to telling you a new version exists and opening the release page; updating then means repeating the install. The AppImage additionally carries update information, so AppImageUpdate and similar tools can update it too.

What the updater did, and why an update didn't install, is in `updater.log` — in the app's `logs` folder, next to `backend.log` (on macOS `~/Library/Application Support/rollfilm-desktop/logs/`).

## Who builds this, and how

Rollfilm is a **one-person hobby project**. There is no company behind it, no
team, no roadmap meeting — just me, my own photo library as the test case, and
whatever time is left over in the evening.

It is also **fully vibe coded**: essentially every line is written by an AI
assistant (Claude), with me directing, reviewing, testing and deciding what
ships. Every commit carries that in its trailer. I'm saying it plainly rather
than burying it, because you deserve to know what you are installing and because
it visibly shapes the code — you'll find long comments explaining *why* a
three-line function exists, which is how the reasoning survives between sessions.

What that means in practice:

- **It's tested where it counts.** 550+ backend tests cover the paths that could
  lose your photos or your edits: import, trash, pairing, library sync. Your
  originals are never modified; edits live in the database beside them.
- **It also means one person's blind spots.** Rollfilm is used daily on one
  library, one camera bag, one operating system more than the others. Bug
  reports from a different setup are genuinely the most useful thing you can
  send.
- **Keep a backup.** That is true of any photo manager, and I'd rather say it out
  loud than have you assume otherwise.

If that trade sounds fine to you, welcome. If not, that's a reasonable call too.

## Tech stack

| Layer | Tech |
| --- | --- |
| Backend | Python 3.11+, FastAPI, SQLAlchemy 2.0, Alembic, SQLite + `sqlite-vec` |
| ML / imaging | OpenCLIP (ViT-B-32), Pillow, rawpy, OpenCV, ImageHash, ExifTool |
| Frontend | React 18, TypeScript, Vite, TanStack Query, Leaflet |
| Desktop | Electron 33 + electron-builder, backend bundled with PyInstaller |

Everything runs locally — the only network access is the initial CLIP model download and your own Immich server (if configured).

## Development

Rollfilm is a native desktop app (Electron). You need Node.js 18+, a Python 3.11+ that can load SQLite extensions (on macOS use Homebrew Python — the system build has extension loading compiled out and `sqlite-vec` will fail), and ExifTool on your `PATH` (the packaged app ships its own; development does not).

```bash
# Development (Vite dev server + Electron)
cd electron
npm install
npm run dev

# Build installers (dmg / nsis / AppImage)
npm run dist
```

There is also a GitHub Actions workflow ([.github/workflows/build-desktop.yml](.github/workflows/build-desktop.yml)) that builds macOS, Windows, and Linux installers, and a one-command local build (`node build-desktop.js`).

### Backend standalone

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
python run_server.py   # runs Alembic migrations, then starts the API on localhost
pytest                 # 550+ tests, in-memory database
```

### Configuration

The desktop app configures itself (data directory, ports) and stores everything under your user data folder. The Immich server URL and API key are deliberately **not** environment variables: they are entered in the app under Settings → Immich integration and stored in the database. For backend development, `PM_DATA_DIR` overrides where the library/database live.

### Architecture

```
rollfilm/
├── backend/          FastAPI app
│   └── app/
│       ├── api/      REST routes (images, albums, import, search, tags, ...)
│       ├── services/ Domain logic (immich sync, import pipeline, embeddings,
│       │             thumbnails/editor rendering, EXIF, geocoding, trash, ...)
│       ├── workers/  Background queue (embeddings, Immich uploads)
│       └── db/       SQLAlchemy models + Alembic migrations
├── frontend/         React UI (talks to the backend via REST)
└── electron/         Desktop shell (spawns the bundled backend as a child process)
```

Notable design decisions:
- **Single local user, no auth** — this is a personal desktop app. The bundled backend listens on localhost for the app's own UI; don't expose it to a network as-is (CORS is wide open for localhost use).
- External sources are mounted **read-only** — the app can never modify your originals.
- Database migrations run automatically on startup, with retry logic for external drives.
- Handles cloud-synced folders (iCloud/Nextcloud placeholder files) and exFAT/NTFS drives.

## Known limitations

- The photo editor is experimental (see above)
- **Single user, no authentication** — the backend binds to localhost for the app's own window. Don't put it on a network as-is: there is no login, no accounts and no server mode, and none is planned
- **Not code-signed or notarized** — hence the one-time Gatekeeper and SmartScreen steps above. A matter of certificate cost, not of anything being wrong with the build
- The UI is only really exercised on macOS; Windows and Linux get less day-to-day use

## Contributing

Issues and pull requests are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md) first. The short version: open an issue before building anything big, run `pytest` and the frontend typecheck before opening a PR, and expect replies to take a few days.

- [Report a bug or request a feature](https://github.com/pasqualkreher/Rollfilm/issues/new/choose)
- [Ask a question](https://github.com/pasqualkreher/Rollfilm/discussions) — or see [SUPPORT.md](SUPPORT.md)
- [Report a security problem privately](SECURITY.md) — never as a public issue
- [Code of Conduct](CODE_OF_CONDUCT.md)

## Support the project

Rollfilm is free and open source, built in my spare time. If it's useful to you, a ⭐ on GitHub or a mention to a friend already helps. Bug reports from a setup unlike mine help even more.

If you would like to give something back, a small donation keeps it going:

[![Donate with PayPal](https://img.shields.io/badge/Donate-PayPal-0070ba?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/donate/?hosted_button_id=TE6RWWJ7JRPKN)

Rollfilm has no paid tier, so a donation changes nothing about what the app does for you. More on [rollfilm.org](https://rollfilm.org/#donate).

## License

[MIT](LICENSE) — © Pasqual Kreher. You're free to use, modify, and redistribute this software; the copyright notice must be preserved.

The film lookup tables in `backend/app/services/film_luts/analog/` and `backend/app/services/film_luts/clut/` are not MIT: they are derived from [spektrafilm](https://github.com/andreavolpato/spektrafilm) by Andrea Volpato and from the RawTherapee Film Simulation Collection by Pat David, Pavlov Dmitry and Michael Ezra, and licensed CC BY-SA 4.0 (sources and licence in each folder's `SOURCES.txt`). The ones in `backend/app/services/film_luts/spectral/` are derived from [spectral_film_lut](https://github.com/JanLohse/spectral_film_lut) by Jan Lohse, under its MIT licence.

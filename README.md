<div align="center">

<img src="https://rollfilm.org/logo.svg" alt="Rollfilm logo" width="90">

# Rollfilm

**Import, organize and manage your photos. All on your own computer.**

A privacy-first desktop photo manager with local AI search, map & timeline browsing,
RAW support — and first-class [Immich](https://immich.app) integration.
No account, no cloud, no Docker, no setup.

[![Latest release](https://img.shields.io/github/v/release/pasqualkreher/Rollfilm?label=release&color=4c8dae)](https://github.com/pasqualkreher/Rollfilm/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/pasqualkreher/Rollfilm/total?color=4c8dae)](https://github.com/pasqualkreher/Rollfilm/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20·%20Windows%20·%20Linux-lightgrey)](#download--installation)

**[rollfilm.org](https://rollfilm.org)** · [Download](#download--installation) · [Screenshots](#screenshots) · [Features](#features) · [FAQ](https://rollfilm.org/#faq)

<a href="https://rollfilm.org"><img src="https://rollfilm.org/assets/library.jpg" alt="Rollfilm library view" width="850"></a>

</div>

Your photos stay on your own machine. Rollfilm imports them into a managed library, makes them searchable with natural language, and can optionally mirror your library to an existing Immich server.

> **Project status: work in progress.**
> This is an early but already very usable release that I wanted to share. The core — import pipeline, library organization, semantic search, and especially the Immich integration — works well. The built-in photo editor is experimental and should be seen as a fun extra rather than a finished feature (see [Photo editor](#photo-editor-experimental)).

## Screenshots

More on [rollfilm.org](https://rollfilm.org/#screenshots).

| | |
| :---: | :---: |
| <img src="https://rollfilm.org/assets/search.jpg" alt="Semantic search" width="420"><br>**Semantic search** — describe what you remember | <img src="https://rollfilm.org/assets/map.jpg" alt="Map view" width="420"><br>**Map view** — every geotagged photo |
| <img src="https://rollfilm.org/assets/import-lighttable.jpg" alt="Import light table" width="420"><br>**Import wizard** — stage, compare, pick | <img src="https://rollfilm.org/assets/immich.jpg" alt="Immich integration" width="420"><br>**Immich sync** — your library, mirrored |
| <img src="https://rollfilm.org/assets/edit-film.jpg" alt="Photo editor with film simulations" width="420"><br>**Editor** — non-destructive, with film sims | <img src="https://rollfilm.org/assets/themes.jpg" alt="Color themes" width="420"><br>**20+ themes** — light, dark and in between |

## Features

### Library & import
- **Staged import wizard** — uploads are staged asynchronously, nothing blocks while you keep selecting photos
- **RAW support** (via rawpy) with automatic RAW+JPEG pairing
- **EXIF extraction** (ExifTool) and reverse geocoding of GPS coordinates to country/place
- **Near-duplicate detection** during import using perceptual hashes
- Albums, smart albums, tags (with bulk tagging), star ratings, color labels, and a selects/picks workflow
- **Trash** with configurable retention and automatic background purge

### Search & browsing
- **Semantic search** — describe what you're looking for in natural language ("sunset at the beach", "dog in the snow"). Powered by CLIP embeddings stored in SQLite via `sqlite-vec`, fully local, no cloud API
- Image-to-image similarity search
- **Map view** (Leaflet) of all geotagged photos
- Timeline scrubber, thumbnail grid, lightbox
- **20+ light & dark color themes** — from a clean Light/Dark to Sepia, Nord, Forest and more

### Immich integration ⭐
This is one of the highlights of the project: keep your library mirrored to an existing [Immich](https://immich.app) server without giving up local-first management.

- Configure server URL + API key directly in the app (Settings → Immich) — nothing goes into config files
- **Three sync modes:**
  - `manual` — per-import checkbox and on-demand "Add to Immich" buttons
  - `selective` — only photos and albums you flag for sync
  - `full` — every photo and album is mirrored automatically
- **Background reconciliation loop** — runs at startup and every 60 seconds: uploads missing assets, backfills asset IDs (checksum-based, so Immich deduplicates correctly), mirrors app albums to Immich albums, and propagates deletions through a durable pending-deletion queue
- Per-image exponential backoff on failures; event-driven uploads for instant sync after import
- Immich mirrors only your *visible* library — the local library always remains the recoverable source of truth

### External sources
- **Index photo collections in place** (e.g. a NAS) — read-only, without copying anything into the managed library
- Browse any mounted drive directly from the app

### Photo editor (experimental)
A non-destructive editor is included, but consider it a gimmick for now — it's fun to play with, not a Lightroom replacement.

- All rendering happens **in the app's backend**, so the live preview is pixel-identical to the exported result
- Edits are stored as values in the database; originals are never touched
- Exposure/contrast/highlights/shadows, white balance, HSL color mixer, tone curves, color grading wheels, crop/rotate/perspective, masks, and effects like grain, vignette, clarity, film-style diffusion and a white matte frame
- **Auto develop** — an optional "Auto" button that suggests develop settings *learned from your own edits*: a local CLIP k-nearest-neighbor recommender finds the photos you've already edited that look most like the one you're working on and blends their settings. No training step, no cloud — every edit you save immediately makes the next suggestion better. Works on a single photo or a whole selection at once

## Download & installation

Prebuilt installers for macOS, Windows, and Linux are on the [Releases page](https://github.com/pasqualkreher/Rollfilm/releases/latest) and on [rollfilm.org](https://rollfilm.org/#download).

| Platform | File | Notes |
| --- | --- | --- |
| macOS (Apple Silicon) | `Rollfilm-<version>-arm64.dmg` | See [macOS first launch](#macos-first-launch) below — the app is not code-signed yet. |
| Windows | `Rollfilm Setup <version>.exe` | SmartScreen may warn about an unknown publisher — choose **More info → Run anyway**. |
| Linux | `Rollfilm-<version>.AppImage` | Make it executable (`chmod +x Rollfilm-*.AppImage`) and run it. |

On first start the app downloads the CLIP model for semantic search; after that everything works offline.

### macOS first launch

The app is not notarized with Apple (no paid developer certificate), so Gatekeeper will block it with a "damaged or unverified" warning. After dragging Rollfilm into `/Applications`, remove the quarantine flag once:

```bash
xattr -dr com.apple.quarantine "/Applications/Rollfilm.app"
```

Then start the app normally. Alternatively: right-click the app → **Open** → **Open** on the first launch.

## Tech stack

| Layer | Tech |
| --- | --- |
| Backend | Python 3.11+, FastAPI, SQLAlchemy 2.0, Alembic, SQLite + `sqlite-vec` |
| ML / imaging | OpenCLIP (ViT-B-32), Pillow, rawpy, OpenCV, ImageHash, ExifTool |
| Frontend | React 18, TypeScript, Vite, TanStack Query, Leaflet |
| Desktop | Electron 33 + electron-builder, backend bundled with PyInstaller |

Everything runs locally — the only network access is the initial CLIP model download and your own Immich server (if configured).

## Getting started (development)

Rollfilm is a native desktop app (Electron). Requires Node.js and a Python 3.11+ that supports loading SQLite extensions (on macOS use Homebrew Python, not the system one).

```bash
# Development (Vite dev server + Electron)
cd electron
npm install
npm run dev

# Build installers (dmg / nsis / AppImage)
npm run dist
```

There is also a GitHub Actions workflow ([.github/workflows/build-desktop.yml](.github/workflows/build-desktop.yml)) that builds macOS, Windows, and Linux installers, and a one-command local build (`node build-desktop.js`).

### Backend standalone (development)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e .
python run_server.py   # runs Alembic migrations, then starts the API on localhost
```

## Configuration

The desktop app configures itself (data directory, ports) and stores everything under your user data folder. The Immich server URL and API key are deliberately **not** environment variables: they are entered in the app under Settings → Immich integration and stored in the database. For backend development, `PM_DATA_DIR` overrides where the library/database live.

## Architecture

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

## Known limitations / roadmap

- The photo editor is experimental (see above)
- No test suite yet (pytest is set up, tests are WIP)
- Single-user only — no accounts or sharing

Issues and pull requests are welcome, but please keep in mind this is a hobby project — response times may vary.

## Support

Rollfilm is free and open source, built in my spare time. If it's useful to you, a star on GitHub or a mention to a friend already helps. More on [rollfilm.org](https://rollfilm.org/#about).

## License

[MIT](LICENSE) — © Pasqual Kreher. You're free to use, modify, and redistribute this software; the copyright notice must be preserved.

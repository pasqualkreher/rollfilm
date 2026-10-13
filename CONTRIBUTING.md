# Contributing to Rollfilm

Thanks for looking. Rollfilm is a hobby project maintained by one person, so
please read the first section before you spend real time on a change — it will
tell you whether the effort is likely to land.

## Before you start

**Open an issue first for anything bigger than a bug fix.** A one-person project
has one person's idea of where it is going, and the fastest way to find out
whether a feature fits is to ask before building it. Small fixes, typos and
obviously-correct patches need no ceremony — just send them.

**Response times vary.** This is spare-time work. An issue may sit for a week.
It has not been ignored.

**The photo editor** is a full part of the app: masks, retouch, film looks and
process versions that keep old edits pixel-stable. Changes to its maths go
behind a new process version (see `develop.py`'s header and
`docs/ARCHITECTURE.md`), and a pull request that changes how a stored edit
renders needs a test pinning the old result.

## How this codebase is written

Rollfilm is written by one person **and an AI assistant** — Claude writes
essentially all of the code, and the maintainer directs, reviews, tests and
decides. Every commit says so in its trailer. This is not a footnote; it shapes
what the code looks like and what a good contribution looks like:

- **Comments explain *why*, at length.** You will find twenty-line comments above
  a three-line function describing the bug that made it necessary. That is
  deliberate — it is how intent survives when the person writing the next change
  has no memory of the last one. If you touch code with such a comment and the
  reasoning no longer holds, update the comment in the same commit; a stale
  "this is why" is worse than none.
- **Match the surrounding density.** A patch of bare code in a file full of
  reasoning reads as unfinished, and vice versa.
- **You do not have to use AI to contribute**, and you do not have to disclose it
  if you do. Either way the same rule applies: you are responsible for what you
  send. If you cannot explain why a change is correct, it is not ready.

## Getting set up

Requirements:

- **Node.js** (18+)
- **Python 3.11+ that can load SQLite extensions.** On macOS use Homebrew Python,
  not the system one — the system build has extension loading compiled out, and
  `sqlite-vec` will fail at import.
- **ExifTool** on your `PATH` (`brew install exiftool`, `apt install
  libimage-exiftool-perl`). The packaged app ships its own; development does not.

The whole app, the way it actually runs:

```bash
cd electron
npm install
npm run dev      # Vite dev server + Electron, backend spawned as a child process
```

Backend on its own, when you are working on the API:

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.lock         # macOS
# Linux / Windows: the lock pins CPU-only torch, which lives on PyTorch's index
# pip install -r requirements.lock --extra-index-url https://download.pytorch.org/whl/cpu
pip install --no-deps -e .
PM_API_OPEN=1 python run_server.py       # runs migrations, then serves on localhost
```

`PM_DATA_DIR` decides where the library and database live — point it somewhere
throwaway rather than at a real photo library. `PM_API_OPEN=1` lets a backend
started from the source tree take requests without the desktop app's per-launch
token (the packaged backend ignores it).

### Dependencies are pinned

`backend/requirements.lock` pins every Python package, for every platform and
for Python 3.11 and up: CI installs from it, the installer builds install from
it, and `build_backend.sh` installs from it again before freezing, so a release
bundles exactly what the tests ran against. `pyproject.toml` keeps only the
lower bounds. The lock is made with [uv](https://docs.astral.sh/uv/), and the
command is in its first lines:

```bash
cd backend
uv pip compile pyproject.toml --all-extras --universal --python-version 3.11 \
  --torch-backend cpu --emit-index-url -o requirements.lock
```

Run as it is, that keeps every pin and only adds what a new or changed
dependency in `pyproject.toml` needs. To move a package on, add
`--upgrade-package <name>` (or `--upgrade` for everything), then reinstall from
the lock and run the full test suite before committing the two files together.
`--torch-backend cpu` is why torch is pinned to the `+cpu` builds off macOS;
`--universal` is why one file serves every platform.

The exiftool the app bundles is pinned the same way: `ETVER_PINNED` and
`ETSHA256_PINNED` in `backend/build_backend.sh`, both taken from
<https://exiftool.org/checksums.txt> and changed together. A download whose
SHA-256 does not match stops the build. (`build_backend.ps1`, the Windows
build, does not check the hash yet.)

Frontend on its own:

```bash
cd frontend
npm install
npm run dev
```

## Before you open a pull request

Run what CI runs (`.github/workflows/ci.yml`):

```bash
cd backend  && pytest                    # 800+ tests, well under a minute
cd frontend && npx tsc --noEmit && npm run build
```

Both must be clean. A red test suite is the one thing guaranteed to stall a PR.
CI additionally runs the backend suite on macOS and freezes the backend with
PyInstaller to start it once (`backend-smoke`); a release is only built from a
commit on which all of that passed.

**Testing the UI is the maintainer's job.** Do not feel obliged to script a
browser or record a video — a typecheck, a build and a clear description of what
you changed is enough. Say what you did and did not verify.

## Writing tests

`backend/tests/` holds them. They run against an in-memory (or `tmp_path`)
SQLite database and a `tmp_path` library, so they are fast and touch nothing
real. `test_api_flows.py` shows how to drive the real app over HTTP with
`TestClient` and an overridden `get_db`.

**Schema changes go through Alembic** (`backend/app/db/migrations/versions/`),
never `create_all`. `test_migrations.py` upgrades an empty database from the
first revision to head and compares the result with the models (tables,
columns, nullability), steps the newest revisions down and up again, and
upgrades a database from about ten revisions back with a photo in it. So a
model column without a migration, a migration the model does not mirror, a
second head or a downgrade that does not work fails the suite. It reads the
revisions from the folder; a new migration needs no change to the test.

Test what a user would notice, and name it that way. The existing names are
sentences — `test_a_file_renamed_in_finder_is_followed_not_deleted`,
`test_trashed_photos_never_come_back` — because the list of test names should
read as a list of promises the app makes. Please keep that up.

Anything touching the import pipeline, the trash, pairing or the library sync
wants a test: those are the paths that can lose a user's photos or their edits.

## Commit messages

The project uses an unusual style and PRs are squashed into it, so it is worth
knowing:

- **The subject line is what changed for the user**, as a sentence, not what
  changed in the code. `Months stop disappearing from the date scrubber`, not
  `fix: section key collision in TimelineScrubber`. Release commits append the
  version: `...; 0.1.45`.
- **The body is prose**, in paragraphs, explaining what was wrong, why it was
  wrong, and what was done about it. It is the changelog and the archaeology
  record at once.
- If AI wrote part of it, keep the `Co-Authored-By:` trailer.

You do not have to match this perfectly in your PR — the maintainer will rewrite
the final message. But describing the user-visible effect in your PR description
makes that easy.

## What is unlikely to be merged

- **Adding authentication or multi-user support.** Rollfilm is a single-user
  desktop app whose backend is bound to localhost by design. Accounts, sessions
  and a server mode would touch every route for a use case this build does not
  have.
- **Cloud services, telemetry, or anything that phones home.** The one network
  call is the initial CLIP model download; the only server is your own Immich.
- **Large dependency additions** for something a small amount of code can do. The
  packaged app is already heavy with torch and OpenCV.
- **Reformatting or "modernizing" passes** that touch many files without changing
  behavior. They make the history unreadable for no gain.

## Reporting bugs

Use the [issue templates](https://github.com/pasqualkreher/Rollfilm/issues/new/choose).
The single most useful thing you can include is the backend log:

- **macOS** — `~/Library/Application Support/rollfilm-desktop/logs/backend.log`
- **Windows** — `%APPDATA%\rollfilm-desktop\logs\backend.log`
- **Linux** — `~/.config/rollfilm-desktop/logs/backend.log`

For a security problem, do not open an issue — see [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contribution is licensed under the
[MIT Licence](LICENSE), the same as the rest of the project.

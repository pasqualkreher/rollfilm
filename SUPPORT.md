# Getting help

Rollfilm is built and maintained by one person in their spare time. There is no
support team and no response-time promise — but everything below gets read.

## Start here

**The app won't open after installing.** That is expected and not a bug: the app
isn't code-signed. The [README](README.md#macos-first-launch) has the one-line
fix for macOS; on Windows choose **More info → Run anyway** in the SmartScreen
dialog.

**Something looks broken.** Check the backend log before anything else — it
usually says plainly what went wrong:

- **macOS** — `~/Library/Application Support/rollfilm-desktop/logs/backend.log`
- **Windows** — `%APPDATA%\rollfilm-desktop\logs\backend.log`
- **Linux** — `~/.config/rollfilm-desktop/logs/backend.log`

**Thumbnails missing, photos in the wrong place, counts that look wrong.** Try
**Settings → Sync database to library** first. It reconciles the catalog with
what is actually on disk and fixes most of this without anyone's help.

## Where to ask

| You have | Go to |
| --- | --- |
| A question, or you're unsure it's a bug | [Discussions](https://github.com/pasqualkreher/Rollfilm/discussions) |
| A reproducible bug | [New issue](https://github.com/pasqualkreher/Rollfilm/issues/new/choose) |
| An idea | [Feature request](https://github.com/pasqualkreher/Rollfilm/issues/new/choose) |
| A security problem | [Privately](SECURITY.md) — never a public issue |
| A question about the server/multi-user version | [rollfilm-hosted](https://github.com/pasqualkreher/rollfilm-hosted) |

## What helps most

Your version, your OS, roughly how big your library is and what's in it (RAW,
JPEG, both), and the tail of that log file. Most reports that stall do so
because reproducing them needs a detail nobody thought to mention.

## What this project can't do

- Recover photos. Rollfilm never modifies your originals, but it is not a
  backup — keep one.
- Promise a fix, or a date for one.
- Support running the desktop backend exposed to a network. It is built for a
  single local user; the [hosted build](https://github.com/pasqualkreher/rollfilm-hosted)
  is the one with accounts and authentication.

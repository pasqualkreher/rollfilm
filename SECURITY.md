# Security Policy

## Supported versions

Rollfilm is a one-person hobby project on a fast release cadence, and only the
newest release gets fixes. If you are on an older version, update before
reporting — the issue may already be gone.

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| Anything older | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting instead: go to the repository's
[**Security** tab → **Report a vulnerability**](https://github.com/pasqualkreher/Rollfilm/security/advisories/new).
That opens a private advisory only you and the maintainer can see. If that form
is unavailable to you, contact the maintainer through the address on their
[GitHub profile](https://github.com/pasqualkreher) and say up front that it is a
security report, without details in the first message.

What helps:

- What an attacker can actually do — read another user's photos, run code, reach
  the network — rather than which function looks wrong
- The version you are on, and your OS
- Steps to reproduce, ideally the smallest ones that still work
- Whether it needs the Immich integration, an external source root, or any other
  optional feature switched on

You will get an acknowledgement as soon as the maintainer sees it. This is one
person working in their spare time, so please allow a few days before nudging.
If a fix is warranted it ships in the next release, and you get credit in the
release notes unless you would rather not.

## What is in scope

Rollfilm is a **local desktop application**. Its backend binds to localhost and
is meant to be reachable only by the app's own window. Things that matter:

- Anything that lets a file on disk — a photo, a RAW, an EXIF field — cause code
  execution when imported, scanned or rendered
- Anything that leaks the Immich API key, which is stored in the local database
  and deliberately never sent back to the browser
- Anything that lets a web page you visit in a normal browser reach the local
  backend and read or change your library
- Path traversal out of the library, staging or thumbnail roots
- Anything in the auto-updater that would let a third party ship you a build

## What is out of scope

- **The backend being unauthenticated.** That is the design: a single local user,
  a backend bound to localhost, CORS open for the app's own UI. It is documented
  in the README. Exposing that port to a network is unsupported, and there is no
  authenticated or multi-user mode to fall back on.
- **The app not being code-signed or notarized.** Known, documented, and a matter
  of certificate cost rather than a fixable defect.
- Vulnerabilities in dependencies with no working path to them through Rollfilm.
  A CVE in a transitive package is not by itself a report — show how it is
  reachable here.
- Anything requiring an attacker who already has your user account on the machine.
  At that point they can read the photo files directly.

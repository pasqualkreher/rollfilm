#!/usr/bin/env node
// The body of a GitHub release page, printed to stdout.
//
//   node scripts/release-notes.js v0.1.96
//
// What changed comes from CHANGELOG.md, written by hand for people who use
// the app: the section of this version, as it stands there. Below it the
// downloads, the note about unsigned installers and - folded away - every
// commit since the last published release, for whoever wants the detail.
//
// A version without a CHANGELOG section still gets a page: the commit list
// is then shown open instead of folded, as the release notes were before.
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const REPO = process.env.GITHUB_REPOSITORY || "pasqualkreher/rollfilm";

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// The lines under "## <version>" up to the next "## ", without the heading.
function changelogSection(version) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^## ${version.replace(/\./g, "\\.")}(\\s|$)`).test(l));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body || null;
}

// The newest tag before this one whose release is out - not a pre-release
// that was never published (0.1.94 was one), or its changes would be counted
// for neither version.
function previousRelease(tag) {
  const tags = run("git", ["tag", "--list", "v*", "--sort=-v:refname"]).split("\n").filter(Boolean);
  // Not tagged yet (a dry run before the release): everything is older.
  const older = tags.indexOf(tag) === -1 ? tags : tags.slice(tags.indexOf(tag) + 1);
  let published = null;
  const list = run("gh", ["release", "list", "--repo", REPO, "--limit", "100", "--json", "tagName,isPrerelease,isDraft"]);
  if (list) {
    try {
      published = new Set(
        JSON.parse(list)
          .filter((r) => !r.isPrerelease && !r.isDraft)
          .map((r) => r.tagName)
      );
    } catch {
      published = null;
    }
  }
  return older.find((t) => !published || published.has(t)) || null;
}

function commits(tag, prev) {
  const end = run("git", ["rev-parse", "--verify", "--quiet", `${tag}^{commit}`]) ? tag : "HEAD";
  const range = prev ? `${prev}..${end}` : end;
  // "; 0.1.46" at the end of older subjects: the version is already the title.
  const strip = /;\s*(bump to\s+)?\d+\.\d+\.\d+\s*$/;
  return run("git", ["log", "--format=%s", "--no-merges", range])
    .split("\n")
    .map((s) => s.replace(strip, "").trim())
    .filter((s) => s && !/^release:/i.test(s));
}

function main() {
  const tag = process.argv[2];
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    console.error("usage: node scripts/release-notes.js vX.Y.Z");
    process.exit(2);
  }
  const version = tag.slice(1);
  const section = changelogSection(version);
  const prev = previousRelease(tag);
  const log = commits(tag, prev);
  const dl = (file) => `[${file}](https://github.com/${REPO}/releases/download/${tag}/${file})`;
  const out = [];

  if (section) {
    out.push(section, "");
  } else {
    out.push("### Changes", "", ...log.map((s) => `- ${s}`), "");
  }

  out.push(
    "### Download",
    "",
    "| | |",
    "|---|---|",
    `| **macOS** (Apple silicon) | ${dl(`Rollfilm-${version}-arm64.dmg`)} |`,
    `| **Windows** | ${dl(`Rollfilm-Setup-${version}.exe`)} |`,
    `| **Linux** | ${dl(`Rollfilm-${version}.AppImage`)} |`,
    "",
    "Already using Rollfilm? It updates itself and tells you what's new.",
    "",
    "<details>",
    "<summary>First start: the installers are not code-signed</summary>",
    "",
    "macOS and Windows each say so in their own way. The one-time way past it is in the",
    `[README](https://github.com/${REPO}#download--installation). Every installer has a`,
    "`.sha256` file beside it if you want to verify the download.",
    "",
    "</details>"
  );

  if (section && log.length > 0) {
    out.push(
      "",
      "<details>",
      `<summary>All ${log.length} commits${prev ? ` since ${prev.slice(1)}` : ""}</summary>`,
      "",
      ...log.map((s) => `- ${s}`),
      "",
      "</details>"
    );
  }

  process.stdout.write(out.join("\n") + "\n");
}

main();

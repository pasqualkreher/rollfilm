#!/usr/bin/env node
// Gives the freshly built AppImage its "update information" and a .zsync file.
//
//   node scripts/appimage-update-info.js electron/dist-app
//
// An AppImage can say where its next version lives: a short string in the
// `.upd_info` section of its runtime, plus a <name>.AppImage.zsync published
// next to it. AppImageUpdate, AppImageLauncher, Gear Lever and the AppImage
// catalog all read it; without it they can only say "cannot be updated".
// electron-builder leaves the section empty and offers no option for it, so
// it is filled in here, after the build.
//
// The app's own updater (electron-updater) must not notice. It trusts two
// things about the file: the sha512 in latest-linux.yml, and the block map
// electron-builder appended to the AppImage, which is what lets an update
// fetch ~15 MB instead of all ~590 MB. Writing into the file invalidates
// both, so the order is: cut the block map off, write the string, build the
// block map again with the very tool electron-builder used, and put the new
// numbers into latest-linux.yml.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const electronDir = path.join(root, "electron");

function fail(msg) {
  console.error(`appimage-update-info: ${msg}`);
  process.exit(1);
}

// "gh-releases-zsync|<owner>|<repo>|latest|<pattern>" - the newest release of
// the repo the app is published to, and the asset in it that matches.
function updateInformation() {
  const pkg = JSON.parse(fs.readFileSync(path.join(electronDir, "package.json"), "utf8"));
  const publish = [].concat(pkg.build.publish).find((p) => p.provider === "github");
  if (!publish) fail("electron/package.json has no github publish entry");
  return `gh-releases-zsync|${publish.owner}|${publish.repo}|latest|${pkg.build.productName}-*.AppImage.zsync`;
}

// Where a named section sits in a 64-bit little-endian ELF file - which is
// what the runtime at the front of an x86-64 or arm64 AppImage is.
function findSection(fd, name) {
  const head = Buffer.alloc(64);
  fs.readSync(fd, head, 0, 64, 0);
  if (head.readUInt32BE(0) !== 0x7f454c46) fail("not an ELF file");
  if (head[4] !== 2 || head[5] !== 1) fail("not a 64-bit little-endian ELF file");
  const shoff = Number(head.readBigUInt64LE(0x28));
  const shentsize = head.readUInt16LE(0x3a);
  const shnum = head.readUInt16LE(0x3c);
  const shstrndx = head.readUInt16LE(0x3e);

  const table = Buffer.alloc(shentsize * shnum);
  fs.readSync(fd, table, 0, table.length, shoff);
  const section = (i) => ({
    name: table.readUInt32LE(i * shentsize),
    offset: Number(table.readBigUInt64LE(i * shentsize + 0x18)),
    size: Number(table.readBigUInt64LE(i * shentsize + 0x20)),
  });

  const strtab = section(shstrndx);
  const names = Buffer.alloc(strtab.size);
  fs.readSync(fd, names, 0, names.length, strtab.offset);
  for (let i = 0; i < shnum; i++) {
    const s = section(i);
    const end = names.indexOf(0, s.name);
    if (names.toString("latin1", s.name, end) === name) return s;
  }
  return null;
}

// Writes the string into the runtime. The block map has to come off first:
// it is the tail of the file - the deflated map, then its length as four
// big-endian bytes - and it describes bytes that are about to change.
function embed(file, info, blockMapSize) {
  const fd = fs.openSync(file, "r+");
  try {
    const section = findSection(fd, ".upd_info");
    if (!section) fail("the AppImage runtime has no .upd_info section");
    if (info.length >= section.size) fail(`update information does not fit into ${section.size} bytes`);
    const current = Buffer.alloc(section.size);
    fs.readSync(fd, current, 0, section.size, section.offset);
    const present = current.toString("latin1", 0, current.indexOf(0));
    if (present === info) return;
    if (present !== "") fail(`.upd_info already holds something else: ${present}`);

    // Only cut what is provably the block map latest-linux.yml describes.
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(4);
    fs.readSync(fd, tail, 0, 4, size - 4);
    if (tail.readUInt32BE(0) !== blockMapSize) {
      fail("the end of the AppImage is not the block map latest-linux.yml describes");
    }
    fs.ftruncateSync(fd, size - blockMapSize - 4);

    const data = Buffer.alloc(section.size);
    data.write(info, "latin1");
    fs.writeSync(fd, data, 0, data.length, section.offset);
  } finally {
    fs.closeSync(fd);
  }
}

// Same call electron-builder makes for an AppImage (appendBlockmap): the map
// goes onto the end of the file, the new size and hashes come back as JSON.
function appendBlockMap(file) {
  const { appBuilderPath } = require(require.resolve("app-builder-bin", { paths: [electronDir] }));
  const res = spawnSync(appBuilderPath, ["blockmap", "--input", file, "--compression", "deflate"], {
    encoding: "utf8",
  });
  if (res.status !== 0) fail(`app-builder blockmap failed: ${res.stderr || res.error}`);
  const out = JSON.parse(res.stdout);
  if (!out.sha512 || !out.size || !out.blockMapSize) fail(`unexpected app-builder output: ${res.stdout}`);
  return out;
}

function writeZsync(file) {
  const base = path.basename(file);
  // -u is the URL the .zsync points at; a bare file name means "next to me",
  // which is where the release has it.
  const res = spawnSync("zsyncmake", ["-u", base, "-o", `${base}.zsync`, base], {
    cwd: path.dirname(file),
    stdio: "inherit",
  });
  if (res.error && res.error.code === "ENOENT") {
    // A local build is still a good build without it; a release is not.
    if (process.env.CI) fail("zsyncmake not found (apt-get install zsync)");
    console.warn("zsyncmake not found - no .zsync written (apt-get install zsync)");
    return;
  }
  if (res.status !== 0) fail(`zsyncmake failed (exit ${res.status})`);
  console.log(`${base}.zsync written`);
}

function main() {
  const distDir = path.resolve(process.argv[2] || path.join(electronDir, "dist-app"));
  const ymlFile = path.join(distDir, "latest-linux.yml");
  if (!fs.existsSync(ymlFile)) fail(`${ymlFile} not found - was the AppImage built?`);
  const yml = fs.readFileSync(ymlFile, "utf8");

  // One AppImage, named once: the rewrite below replaces every sha512 in the
  // file, which is only right while they all describe the same artifact.
  if ((yml.match(/^\s*- url:/gm) || []).length !== 1) fail("latest-linux.yml lists more than one file");
  const name = ((yml.match(/^path:\s*(.+)$/m) || [])[1] || "").trim();
  const listedSize = Number((yml.match(/^\s*size:\s*(\d+)$/m) || [])[1]);
  const blockMapSize = Number((yml.match(/^\s*blockMapSize:\s*(\d+)$/m) || [])[1]);
  if (!name || !listedSize || !blockMapSize) fail("latest-linux.yml has no path / size / blockMapSize");
  const file = path.join(distDir, name);

  const info = updateInformation();
  embed(file, info, blockMapSize);

  // A file shorter than the yml says is one whose block map was cut off -
  // just now, or by a run that died before it got this far. A second run
  // over a finished file changes nothing.
  if (fs.statSync(file).size !== listedSize) {
    const out = appendBlockMap(file);
    fs.writeFileSync(
      ymlFile,
      yml
        .replace(/^(\s*sha512:\s*).+$/gm, `$1${out.sha512}`)
        .replace(/^(\s*size:\s*)\d+$/m, `$1${out.size}`)
        .replace(/^(\s*blockMapSize:\s*)\d+$/m, `$1${out.blockMapSize}`)
    );
    console.log(`update information: ${info}`);
    console.log(`latest-linux.yml: size ${out.size}, blockMapSize ${out.blockMapSize}`);
  } else {
    console.log("update information already present");
  }
  writeZsync(file);
}

main();

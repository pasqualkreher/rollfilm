#!/usr/bin/env node
// Writes a SHA-256 sidecar (<file>.sha256) next to every file it is given.
//
//   node scripts/checksum.js electron/dist-app/Rollfilm-1.2.3-arm64.dmg
//
// The installers are unsigned, so nothing in the OS vouches for them. A hash
// published next to each one is the only way somebody who just pulled down a
// 384 MB file can tell a good download from a broken or tampered one.
//
// Hashing lives in node rather than in the workflow because the three CI
// runners disagree about what's on PATH: macOS ships `shasum`, Linux ships
// `sha256sum`, Windows reliably ships neither. The file is streamed, not read
// into memory - the AppImage is over half a gigabyte.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: node scripts/checksum.js <file> [file ...]");
    process.exit(1);
  }
  for (const file of files) {
    const digest = await sha256(file);
    // Same layout as `sha256sum`, so `sha256sum -c` can verify the sidecar.
    fs.writeFileSync(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`);
    console.log(`${digest}  ${path.basename(file)}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

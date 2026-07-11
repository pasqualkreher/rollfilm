#!/usr/bin/env node
// Cross-platform desktop build: detects the OS and produces the matching
// installer in electron/dist-app/.
//
//   macOS   -> .dmg
//   Windows -> NSIS installer .exe
//   Linux   -> .AppImage
//
// Usage:  node build-desktop.js
//
// Prerequisite (one-time): the backend venv with PyInstaller -
//   cd backend
//   python -m venv .venv
//   .venv/bin/pip install -e . pyinstaller        (Windows: .venv\Scripts\pip)
//   + CPU torch/torchvision from the pytorch index
//
// Everything else (npm installs, renderer build, PyInstaller bundle, exiftool
// staging, electron-builder) is handled here.
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const backendDir = path.join(root, "backend");
const frontendDir = path.join(root, "frontend");
const electronDir = path.join(root, "electron");
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

function run(label, cmd, args, opts = {}) {
  console.log(`\n==> ${label}`);
  console.log(`    ${cmd} ${args.join(" ")}`);
  // shell:true so npm/npx resolve on Windows (npm.cmd) as well as unix.
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: true, ...opts });
  if (res.status !== 0) fail(`${label} failed (exit ${res.status ?? "?"})`);
}

// --- Preflight -------------------------------------------------------------
const pyinstaller = isWin
  ? path.join(backendDir, ".venv", "Scripts", "pyinstaller.exe")
  : path.join(backendDir, ".venv", "bin", "pyinstaller");
if (!fs.existsSync(pyinstaller)) {
  fail(
    `Backend venv with PyInstaller not found (${pyinstaller}).\n` +
      `  Create it first:\n` +
      `    cd backend\n` +
      (isWin
        ? `    python -m venv .venv\n    .venv\\Scripts\\pip install -e . pyinstaller`
        : `    python3 -m venv .venv\n    .venv/bin/pip install -e . pyinstaller`)
  );
}

for (const dir of [frontendDir, electronDir]) {
  if (!fs.existsSync(path.join(dir, "node_modules"))) {
    run(`npm install (${path.basename(dir)})`, "npm", ["install"], { cwd: dir });
  }
}

// --- Build steps -----------------------------------------------------------
run("Build renderer (frontend)", "npm", ["run", "build"], { cwd: frontendDir });
run("Stage renderer into electron/", "npm", ["run", "copy:renderer"], { cwd: electronDir });

if (isWin) {
  run(
    "Build backend bundle (PyInstaller) + exiftool",
    "powershell",
    ["-ExecutionPolicy", "Bypass", "-File", "build_backend.ps1"],
    { cwd: backendDir }
  );
} else {
  run("Build backend bundle (PyInstaller) + exiftool", "sh", ["build_backend.sh"], { cwd: backendDir });
}

const targetFlag = isMac ? "--mac" : isWin ? "--win" : "--linux";
run(`Package installer (electron-builder ${targetFlag})`, "npx", ["electron-builder", targetFlag], {
  cwd: electronDir,
});

// --- Report ----------------------------------------------------------------
const outDir = path.join(electronDir, "dist-app");
const wanted = isMac ? ".dmg" : isWin ? ".exe" : ".AppImage";
const artifacts = fs
  .readdirSync(outDir)
  .filter((f) => f.endsWith(wanted))
  .map((f) => path.join(outDir, f));
console.log(`\n✔ Done. Installer${artifacts.length === 1 ? "" : "s"}:`);
for (const a of artifacts) {
  const mb = (fs.statSync(a).size / 1024 / 1024).toFixed(0);
  console.log(`  ${a} (${mb} MB)`);
}
if (artifacts.length === 0) console.log(`  (nothing matching *${wanted} in ${outDir} - check the log above)`);

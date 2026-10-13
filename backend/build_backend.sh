#!/bin/sh
# Builds the self-contained backend bundle for the desktop app and stages it
# (plus a portable exiftool) under electron/resources/, ready for electron-builder.
#
# Prereq: the backend .venv exists (python -m venv .venv). Its packages are
#         brought to the exact versions in requirements.lock below, so every
#         build bundles what the tests ran against; CONTRIBUTING.md says how
#         to update the lock.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"

VENV="$HERE/.venv"
[ -x "$VENV/bin/python" ] || {
  echo "error: $VENV/bin/python not found. Create the backend venv first." >&2
  exit 1
}
echo "==> Installing the pinned dependencies from requirements.lock"
# The lock is universal: torch and torchvision are pinned to the plain PyPI
# wheels on macOS and to the +cpu builds everywhere else, and those exist
# only on PyTorch's own index (the CUDA default is gigabytes the app never
# uses). Packages already at the pinned version are left alone, so the
# OpenMP rawpy below survives a rebuild.
TORCH_INDEX=""
if [ "$(uname)" != "Darwin" ]; then
  TORCH_INDEX="--extra-index-url https://download.pytorch.org/whl/cpu"
fi
# shellcheck disable=SC2086 # TORCH_INDEX is two words or nothing.
"$VENV/bin/python" -m pip install -r requirements.lock $TORCH_INDEX
# The project itself without dependencies: the lock already holds them all,
# and resolving again here could pull in something newer than the lock.
"$VENV/bin/python" -m pip install --no-deps -e .
"$VENV/bin/python" -c "import PyInstaller" 2>/dev/null || {
  echo "error: PyInstaller is not installed in $VENV." >&2
  exit 1
}

if [ "$(uname)" = "Darwin" ]; then
  # rawpy's macOS wheels run LibRaw's demosaic on one core; the 100% zoom of a
  # raw is ~3x faster with it multi-threaded. Idempotent (skips a venv that
  # already has it), so only the first build pays the ~2 min compile.
  echo "==> rawpy with a multi-threaded (OpenMP) LibRaw"
  "$VENV/bin/python" build_rawpy_openmp.py
fi

echo "==> Building backend with PyInstaller (this is slow — torch is large)"
# `python -m PyInstaller` instead of the bin/pyinstaller entry script: the
# script hardcodes the venv's absolute path in its shebang, which breaks
# whenever the checkout is moved after the venv was created.
"$VENV/bin/python" -m PyInstaller photo_manager_backend.spec \
  --noconfirm --clean \
  --distpath "$HERE/pyi-dist" \
  --workpath "$HERE/pyi-build"

DEST="$HERE/../electron/resources/backend"
echo "==> Staging backend at $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$HERE/pyi-dist/photo-manager-backend/." "$DEST/"

echo "==> Bundling portable exiftool"
# A pinned version, not whatever exiftool.org/ver.txt says today: a release
# build must bundle the exiftool the app was tested with, and a new upstream
# release on the day of a tag must not change it unseen. The tarball comes
# from the SourceForge mirror (exiftool.org no longer serves versioned
# tarballs reliably), so its SHA-256 is checked against the one exiftool.org
# publishes at https://exiftool.org/checksums.txt - the mirror is a third
# party. To update: set both values from that page, in the same commit.
# EXIFTOOL_VERSION / EXIFTOOL_SHA256 in the environment override the pair,
# but only together. The standalone Image::ExifTool distribution is a
# self-contained Perl program (uses the system /usr/bin/perl at runtime) -
# the `exiftool` script plus its lib/ directory next to it.
ETVER_PINNED="13.59"
ETSHA256_PINNED="668ea3acececb7235fbd0f4900e72d5f12c9b07e5c778fd36cb1e9b5828fd65a"
if [ -n "${EXIFTOOL_VERSION:-}" ]; then
  ETVER="$EXIFTOOL_VERSION"
  ETSHA256="${EXIFTOOL_SHA256:-}"
else
  ETVER="$ETVER_PINNED"
  ETSHA256="$ETSHA256_PINNED"
fi
if [ -z "$ETSHA256" ]; then
  echo "error: no SHA-256 for exiftool $ETVER. Set EXIFTOOL_SHA256 from https://exiftool.org/checksums.txt." >&2
  exit 1
fi
TARBALL="Image-ExifTool-$ETVER.tar.gz"
EXIFTOOL_DIR="$HERE/../electron/resources/exiftool"
rm -rf "$EXIFTOOL_DIR"
mkdir -p "$EXIFTOOL_DIR"
curl -fsSL "https://sourceforge.net/projects/exiftool/files/$TARBALL/download" -o "/tmp/$TARBALL"
# shasum ships with macOS, sha256sum with Linux; either prints the hash first.
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "/tmp/$TARBALL" | cut -d' ' -f1)
else
  ACTUAL=$(shasum -a 256 "/tmp/$TARBALL" | cut -d' ' -f1)
fi
if [ "$ACTUAL" != "$ETSHA256" ]; then
  echo "error: $TARBALL has SHA-256 $ACTUAL, expected $ETSHA256. Not bundling it." >&2
  rm -f "/tmp/$TARBALL"
  exit 1
fi
echo "    $TARBALL SHA-256 verified"
tar -xzf "/tmp/$TARBALL" -C /tmp
cp "/tmp/Image-ExifTool-$ETVER/exiftool" "$EXIFTOOL_DIR/exiftool"
cp -R "/tmp/Image-ExifTool-$ETVER/lib" "$EXIFTOOL_DIR/lib"
chmod +x "$EXIFTOOL_DIR/exiftool"

echo "==> Done. Bundle: $DEST ; exiftool: $EXIFTOOL_DIR"

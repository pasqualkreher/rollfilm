#!/bin/sh
# Builds the self-contained backend bundle for the desktop app and stages it
# (plus a portable exiftool) under electron/resources/, ready for electron-builder.
#
# Prereq: the backend .venv exists with deps + pyinstaller installed
#         (python -m venv .venv && .venv/bin/pip install -e . pyinstaller
#          + CPU torch/torchvision from the pytorch index).
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"

VENV="$HERE/.venv"
[ -x "$VENV/bin/python" ] || {
  echo "error: $VENV/bin/python not found. Create the backend venv first." >&2
  exit 1
}
"$VENV/bin/python" -c "import PyInstaller" 2>/dev/null || {
  echo "error: PyInstaller is not installed in $VENV." >&2
  exit 1
}

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
# Version from exiftool.org, tarball from the SourceForge mirror (exiftool.org
# no longer serves versioned tarballs reliably). The standalone Image::ExifTool
# distribution is a self-contained Perl program (uses the system /usr/bin/perl
# at runtime) — the `exiftool` script plus its lib/ directory next to it.
ETVER="${EXIFTOOL_VERSION:-$(curl -fsSL https://exiftool.org/ver.txt)}"
TARBALL="Image-ExifTool-$ETVER.tar.gz"
EXIFTOOL_DIR="$HERE/../electron/resources/exiftool"
rm -rf "$EXIFTOOL_DIR"
mkdir -p "$EXIFTOOL_DIR"
curl -fsSL "https://sourceforge.net/projects/exiftool/files/$TARBALL/download" -o "/tmp/$TARBALL"
tar -xzf "/tmp/$TARBALL" -C /tmp
cp "/tmp/Image-ExifTool-$ETVER/exiftool" "$EXIFTOOL_DIR/exiftool"
cp -R "/tmp/Image-ExifTool-$ETVER/lib" "$EXIFTOOL_DIR/lib"
chmod +x "$EXIFTOOL_DIR/exiftool"

echo "==> Done. Bundle: $DEST ; exiftool: $EXIFTOOL_DIR"

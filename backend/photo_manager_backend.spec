# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Photo Manager backend (onedir).
#
# Produces a self-contained backend the Electron app runs with no system Python.
# Bundles the FastAPI app, Alembic migrations, and the heavy ML/imaging deps.
# Build via build_backend.sh (which also stages exiftool alongside it).

from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = [
    ("alembic.ini", "."),
    ("app/db/migrations", "app/db/migrations"),
]
binaries = []
# Things imported dynamically (not visible to static analysis).
hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    "sqlite_vec",
    "exiftool",
]
hiddenimports += collect_submodules("uvicorn")

# Grab data files + native libs (torch dylibs, libraw vendored by rawpy, the
# open_clip BPE vocab, sqlite-vec's extension, OpenCV's native module, etc.).
for pkg in (
    "torch",
    "torchvision",
    "open_clip",
    # SegFormer for the "select the sky/water/..." masks. The weights are NOT
    # bundled - they're fetched into the model cache on first use, like CLIP's -
    # but the modelling code is loaded by name at runtime, so it has to be here.
    "transformers",
    "rawpy",
    "sqlite_vec",
    "PIL",
    "imagehash",
    "cv2",
    "reverse_geocoder",  # bundled cities k-d tree dataset (rg_cities1000.csv)
    "pycountry",  # ISO country-code → name tables (JSON data files)
    "certifi",  # cacert.pem - the trust store run_server.py falls back to
):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    ["run_server.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="photo-manager-backend",
    console=True,
    disable_windowed_traceback=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="photo-manager-backend",
)

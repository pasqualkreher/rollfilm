"""Step 1 of fitting the film simulations to the camera: pair each RAF's own
linear demosaic with the JPEG the camera wrote into it.

A Fuji RAF carries the full-size JPEG the camera rendered with the film
simulation that was set, and its maker notes say which one (FilmMode) and with
which recipe on top (highlight / shadow tone, colour, colour chrome, dynamic
range). That is a measured reference for every simulation the library was
shot with. This script reads a library (read-only), picks a spread of files
per camera, simulation and recipe, and stores for each one a small, blurred
pair: the app's scene-linear base and the camera JPEG, both area-averaged to
the same ~100px grid. At that size lens corrections, sharpening and grain no
longer matter and a pixel is a clean colour sample.

    python -m tools.film_sim_fit.extract <library> <cache dir> [--per-group N]

Nothing is written to the library; the cache dir receives one .npz per photo
and survey.csv.
"""

from __future__ import annotations

import argparse
import csv
import io
import random
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
import rawpy
from PIL import Image, ImageOps

TAGS = [
    "Model", "FilmMode", "Saturation", "DevelopmentDynamicRange", "HighlightTone",
    "ShadowTone", "ColorChromeEffect", "ColorChromeFXBlue", "WhiteBalanceFineTune", "ISO",
]

# FilmMode / Saturation codes of the maker notes -> the app's film_sim names.
FILM_MODE = {
    0: "provia", 256: "provia", 272: "provia", 288: "astia", 304: "provia",
    512: "velvia", 768: "provia", 1024: "velvia", 1280: "pro_neg_std", 1281: "pro_neg_hi",
    1536: "classic_chrome", 1792: "eterna", 2048: "classic_neg",
    2304: "eterna_bleach_bypass", 2560: "nostalgic_neg", 2816: "reala_ace",
}
MONO = {
    768: "monochrome", 769: "monochrome_r", 770: "monochrome_ye", 771: "monochrome_g",
    784: "sepia", 1280: "acros", 1281: "acros_r", 1282: "acros_ye", 1283: "acros_g",
}
# Saturation codes of the colour setting -> the camera's Color steps (-4..+4).
COLOR_STEP = {0: 0, 128: 1, 192: 3, 224: 4, 256: -1, 384: -2, 1024: -3, 1216: -4, 160: 2, 400: -2}

GRID = 96  # long edge of the stored pair
KEEP = 0.7  # central part of the frame that is compared (lens corrections differ at the rim)


def survey(library: Path, out: Path) -> list[dict]:
    """One row per RAF with the recipe the camera rendered its JPEG with."""
    cmd = ["exiftool", "-r", "-ext", "raf", "-q", "-q", "-n", "-csv", *[f"-{t}" for t in TAGS], str(library)]
    text = subprocess.run(cmd, capture_output=True, text=True, check=False).stdout
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        def num(key: str) -> float | None:
            try:
                return float(r.get(key) or "")
            except ValueError:
                return None

        film, sat = num("FilmMode"), num("Saturation")
        sim = FILM_MODE.get(int(film)) if film is not None else MONO.get(int(sat)) if sat is not None else None
        if sim is None:
            continue
        mono = film is None
        rows.append({
            "path": r["SourceFile"],
            "model": r.get("Model", ""),
            "sim": sim,
            # The camera's own scale: +1 is one step harder / more colour.
            "highlight": -(num("HighlightTone") or 0.0) / 16.0,
            "shadow": -(num("ShadowTone") or 0.0) / 16.0,
            "color": 0 if mono else COLOR_STEP.get(int(sat or 0), 0),
            "chrome": (num("ColorChromeEffect") or 0.0) / 32.0,
            "chrome_blue": (num("ColorChromeFXBlue") or 0.0) / 32.0,
            "dr": int(num("DevelopmentDynamicRange") or 100),
            "iso": int(num("ISO") or 0),
        })
    with (out / "survey.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return rows


def pick(rows: list[dict], per_group: int, seed: int = 7) -> list[dict]:
    """A spread: up to `per_group` files of every camera x simulation x recipe."""
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        key = (r["model"], r["sim"], r["highlight"], r["shadow"], r["color"], r["chrome"], r["chrome_blue"], r["dr"])
        groups[key].append(r)
    rng = random.Random(seed)
    chosen = []
    for key in sorted(groups):
        files = sorted(groups[key], key=lambda r: r["path"])
        rng.shuffle(files)
        chosen.extend(files[:per_group])
    return chosen


def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _centre(arr: np.ndarray) -> np.ndarray:
    h, w = arr.shape[:2]
    dy, dx = int(h * (1 - KEEP) / 2), int(w * (1 - KEEP) / 2)
    return arr[dy : h - dy, dx : w - dx]


def _grid(arr: np.ndarray) -> np.ndarray:
    h, w = arr.shape[:2]
    scale = GRID / max(h, w)
    return cv2.resize(arr, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)


def pair(path: Path) -> dict | None:
    """The photo's linear base (LibRaw's output, exactly as the app decodes it,
    before any camera matrix the app adds itself) and its camera JPEG, both
    linear, centre-cropped and area-averaged to the same grid; plus how flat
    each cell is (a weight: cells on an edge are poor colour samples)."""
    with rawpy.imread(str(path)) as raw:
        try:
            thumb = raw.extract_thumb()
        except rawpy.LibRawError:
            return None
        if thumb.format != rawpy.ThumbFormat.JPEG:
            return None
        jpeg_bytes = bytes(thumb.data)
        rgb16 = raw.postprocess(
            use_camera_wb=True, half_size=True, no_auto_bright=True,
            highlight_mode=rawpy.HighlightMode.Blend, gamma=(1, 1), output_bps=16,
        )
    lin = np.asarray(rgb16, dtype=np.float32) / 65535.0
    im = Image.open(io.BytesIO(jpeg_bytes))
    im.draft("RGB", (1600, 1600))
    im = ImageOps.exif_transpose(im).convert("RGB")
    jpg = _srgb_to_linear(np.asarray(im, dtype=np.float32) / 255.0).astype(np.float32)
    # The camera can crop its JPEG (16:9, 1:1, digital teleconverter): then
    # the two do not show the same picture.
    if abs(lin.shape[1] / lin.shape[0] - jpg.shape[1] / jpg.shape[0]) > 0.02:
        return None
    lin_c, jpg_c = _centre(lin), _centre(jpg)
    a, b = _grid(lin_c), _grid(jpg_c)
    if a.shape != b.shape:
        b = cv2.resize(b, (a.shape[1], a.shape[0]), interpolation=cv2.INTER_AREA)
    # Flatness of each cell, from the JPEG at 4x the grid.
    fine = cv2.resize(jpg_c, (a.shape[1] * 4, a.shape[0] * 4), interpolation=cv2.INTER_AREA)
    luma = fine @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    cells = luma.reshape(a.shape[0], 4, a.shape[1], 4)
    spread = cells.std(axis=(1, 3)) / (cells.mean(axis=(1, 3)) + 0.02)
    # Same picture? A teleconverter crop keeps the aspect ratio.
    la = np.log(a @ np.array([0.2126, 0.7152, 0.0722]) + 1e-3)
    lb = np.log(b @ np.array([0.2126, 0.7152, 0.0722]) + 1e-3)
    corr = float(np.corrcoef(la.ravel(), lb.ravel())[0, 1])
    if corr < 0.9:
        return None
    return {"lin": a.astype(np.float32), "jpg": b.astype(np.float32), "spread": spread.astype(np.float32), "corr": corr}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("library", type=Path)
    ap.add_argument("cache", type=Path)
    ap.add_argument("--per-group", type=int, default=12)
    args = ap.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    rows = survey(args.library, args.cache)
    chosen = pick(rows, args.per_group)
    print(f"{len(rows)} RAFs with a known simulation, {len(chosen)} picked", flush=True)
    kept = 0
    for i, r in enumerate(chosen):
        out = args.cache / (Path(r["path"]).stem + ".npz")
        if out.exists():
            kept += 1
            continue
        try:
            p = pair(Path(r["path"]))
        except Exception as e:  # a damaged file must not stop the run
            print("skip", r["path"], e, file=sys.stderr)
            continue
        if p is None:
            continue
        np.savez_compressed(out, **p, **{k: np.asarray(v) for k, v in r.items()})
        kept += 1
        if i % 25 == 0:
            print(f"{i}/{len(chosen)} ({kept} kept)", flush=True)
    print(f"done: {kept} pairs in {args.cache}")


if __name__ == "__main__":
    main()

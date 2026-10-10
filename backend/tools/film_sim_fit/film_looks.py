"""The greens of the film looks, measured against Provia.

The user: "many looks have a strange, too bright green - not the Fuji sims".
The film stocks (ANALOG_SIMS: spektrafilm and spectral_film_lut, baked from
the textbook F-Gamut) are not given the scene mix process version 7 gives
Fujifilm's cubes (film_sims._SCENE_MIX), and the film scans (CLUT_SIMS) are
laid over Provia's finished picture, whose own colour push they then add to.
This measures, per look, where foliage lands against Provia as the app
renders it (process 7) - hue drift, chroma, lightness - as shipped and under
two candidates, without touching the app:

  M  the scene mix in front of the film stocks' cubes as well
     (reference.scene_mix with the shipped matrix; a scan is mixed already
     through Provia, so M is "as shipped" for it);
  N  the scan laid over a neutral picture instead of Provia: the app's own
     default tone map (raw.default_tone_to_srgb's Reinhard shoulder, white at
     the stills anchor) of the same scene, the kind of render the HaldCLUTs
     were made for (a scan of the film over a camera-standard picture);
     then the grey ramp matched to Provia's as it is today (_film_factors).

    python -m tools.film_sim_fit.film_looks [file.RAF ...] [--demo-lib DIR]
        [--max-photos N] [--csv out.csv] [--sheet out.jpg] [--sheet-looks a,b]
        [--sheet-max N]

Without files, every RAF under --demo-lib (default ~/Desktop/DemoLib). The
"foliage" band is what Provia shows as green (reference.FOLIAGE); "all" is
every colour. Numbers are app minus Provia, in Oklab: a NEGATIVE foliage hue
drift is toward yellow (green sits near 140 degrees, yellow near 100), a
positive one toward cyan; chroma as a ratio; dL in L*100. The sheet writes,
per photo and look, shipped | M or N | Provia | dE heat map.
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import sys
from pathlib import Path

import numpy as np

from app.services import film_sims
from tools.film_sim_fit import reference
from tools.film_sim_fit.reference import LUMA, hue_report, srgb_encode

SHEET_DEFAULT = (
    "kodak_portra_400", "kodak_gold_200", "kodak_vision3_500t", "fujifilm_xtra_400", "cinestill_800t",
    "fuji_superia_400", "agfa_ultra_color_100", "kodak_kodachrome_25", "fuji_superia_200",
)
# Pixels measured per run (sampled from every photo alike).
SAMPLE_PX = 300_000


def _flog2_inverse(code: np.ndarray) -> np.ndarray:
    return np.where(
        code >= 0.100686685370811,
        (10.0 ** ((code - 0.384316) / 0.245281) - 0.064829) / 5.555556,
        (code - 0.092864) / 8.799461,
    )


def neutral_scene_cube(n: int = 65) -> np.ndarray:
    """Candidate N's base: a scene cube (F-Log2 / F-Gamut code values in,
    display sRGB out) of the app's neutral rendering - back to BT.709, the
    Reinhard shoulder with its white at the stills anchor (so sensor clipping,
    fed through apply_official's anchor, lands on white as it does for
    Provia), sRGB encoded."""
    axis = np.linspace(0.0, 1.0, n)
    grid = np.stack(np.meshgrid(axis, axis, axis, indexing="ij"), axis=-1)
    fgamut = np.clip(_flog2_inverse(grid), 0.0, None)
    to_709 = np.linalg.inv(film_sims._FGAMUT_FROM_709.astype(np.float64))
    lin = np.clip(fgamut @ to_709.T, 0.0, None)
    white = float(film_sims._STILLS_ANCHOR)
    toned = lin * (1.0 + lin / (white * white)) / (1.0 + lin)
    return np.ascontiguousarray(srgb_encode(np.clip(toned, 0.0, 1.0)), dtype=np.float32)


@contextlib.contextmanager
def scans_on_neutral():
    """Candidate N: the film scans composed on the neutral picture."""
    neutral = neutral_scene_cube()
    n = neutral.shape[0]
    saved = film_sims._clut_scene_cube

    def on_neutral(sim: str):
        clut = film_sims.clut_cube(sim)
        if clut is None:
            return None
        return film_sims._sample_cube(neutral.reshape(n * n, n, 3), clut).reshape(n, n, n, 3)

    film_sims._clut_scene_cube = on_neutral
    film_sims._film_factors.cache_clear()
    try:
        yield
    finally:
        film_sims._clut_scene_cube = saved
        film_sims._film_factors.cache_clear()


def render(sim: str, px: np.ndarray, candidate: str | None = None) -> np.ndarray:
    """The look on the scene colours `px` as the app renders it on process 7
    (mix=True: Fuji and scan cubes mixed, film stocks not), or under a
    candidate: "M" every cube mixed, "N" the scans on the neutral picture."""
    scene = px.reshape(-1, 1, 3).astype(np.float32)
    if candidate == "M2":
        # The mix's chromaticity only: each pixel's BT.709 luminance put back
        # to what it was, so the mix turns the hue and not the brightness.
        mixed = scene @ film_sims._SCENE_MIX.T.astype(np.float32)
        before = np.maximum(scene @ LUMA, 1e-6)
        after = np.maximum(mixed @ LUMA, 1e-6)
        mixed *= (before / after)[..., None]
        return film_sims.apply_official(np.ascontiguousarray(mixed), sim, 1.0, mix=False).reshape(px.shape)
    if candidate == "M":
        with reference.scene_mix(film_sims._SCENE_MIX):
            return film_sims.apply_official(scene, sim, 1.0, mix=False).reshape(px.shape)
    if candidate == "N":
        with scans_on_neutral():
            return film_sims.apply_official(scene, sim, 1.0, mix=True).reshape(px.shape)
    return film_sims.apply_official(scene, sim, 1.0, mix=True).reshape(px.shape)


def family(sim: str) -> str:
    if sim in film_sims.SPECTRAL_SIMS:
        return "spectral"
    if sim in film_sims.ANALOG_SIMS:
        return "spektrafilm"
    return "scan"


def measure(px: np.ndarray, sims: list[str]) -> list[dict]:
    """Per look: the foliage and all-colour numbers against Provia (process
    7) and against the plain scene, as shipped and per candidate."""
    provia = render("provia", px)
    scene = srgb_encode(np.clip(px, 0.0, 1.0))
    rows = []
    for sim in sims:
        fam = family(sim)
        row = {"look": sim, "family": fam}
        variants = ["shipped", "M", "M2"] if fam != "scan" else ["shipped", "N"]
        for variant in variants:
            out = render(sim, px, None if variant == "shipped" else variant)
            rep = hue_report(out, provia)
            row[f"{variant}:foliage"] = rep["foliage"]
            row[f"{variant}:all"] = rep["all"]
            if variant == "shipped":
                row["shipped:scene"] = hue_report(out, scene)["foliage"]
        rows.append(row)
        print(f"  {sim:28} {fam:11}", end="")
        for variant in variants:
            f = row[f"{variant}:foliage"]
            print(f" | {variant:7} foliage hue {f.get('hue_drift', 0):+6.1f} chroma x{f.get('chroma_ratio', 0):.2f} dL {f.get('dL', 0):+5.1f}", end="")
        print(flush=True)
    return rows


def write_csv(rows: list[dict], out: Path) -> None:
    keys = ["look", "family"]
    for v in ("shipped", "M", "M2", "N"):
        for band in ("foliage", "all"):
            for k in ("hue_drift", "chroma_ratio", "dL", "dE"):
                keys.append(f"{v}:{band}:{k}")
    keys += ["shipped:scene:hue_drift", "shipped:scene:chroma_ratio", "shipped:scene:dL"]
    with out.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(keys)
        for row in rows:
            line = []
            for key in keys:
                parts = key.split(":")
                if len(parts) == 1:
                    line.append(row[key])
                else:
                    d = row.get(f"{parts[0]}:{parts[1]}") or {}
                    line.append(d.get(parts[2], ""))
            w.writerow(line)


def sheet(rafs: list[Path], sims: list[str], out: Path) -> None:
    """Per photo and look: shipped | M or N | Provia | dE shipped vs Provia."""
    from PIL import Image

    rows = []
    for path in rafs:
        frame = reference._frame(path)
        flat = frame.reshape(-1, 3)
        provia = render("provia", flat)
        for sim in sims:
            fam = family(sim)
            shipped = render(sim, flat)
            cand = "N" if fam == "scan" else "M"
            tiles = [
                (shipped, f"shipped: {sim}  {path.stem}"),
                (render(sim, flat, cand), "N: scan on neutral" if cand == "N" else "M: with scene mix"),
                (provia, "Provia (process 7)"),
            ]
            shown = [reference._label((t.reshape(frame.shape) * 255.0 + 0.5).astype(np.uint8), text) for t, text in tiles]
            shown.append(reference._label(reference._heat(shipped.reshape(frame.shape), provia.reshape(frame.shape)), "dE shipped vs Provia, 0..8"))
            rows.append(np.concatenate(shown, axis=1))
    width = max(r.shape[1] for r in rows)
    rows = [np.pad(r, ((0, 0), (0, width - r.shape[1]), (0, 0))) for r in rows]
    Image.fromarray(np.concatenate(rows, axis=0)).save(out, quality=88)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("rafs", nargs="*", type=Path)
    ap.add_argument("--demo-lib", type=Path, default=Path.home() / "Desktop" / "DemoLib")
    ap.add_argument("--max-photos", type=int, default=54)
    ap.add_argument("--csv", type=Path)
    ap.add_argument("--sheet", type=Path)
    ap.add_argument("--sheet-looks", default=",".join(SHEET_DEFAULT))
    ap.add_argument("--sheet-max", type=int, default=4)
    ap.add_argument("--looks", help="only these looks (comma separated)")
    args = ap.parse_args()

    rafs = args.rafs or sorted(args.demo_lib.glob("**/*.RAF"))[: args.max_photos]
    if not rafs:
        sys.exit("no RAF files")
    print(f"{len(rafs)} photos", flush=True)
    px = np.concatenate([reference._photo(p) for p in rafs])
    rng = np.random.default_rng(7)
    if len(px) > SAMPLE_PX:
        px = px[rng.choice(len(px), SAMPLE_PX, replace=False)]
    sims = args.looks.split(",") if args.looks else list(film_sims._FILM_SIMS)
    rows = measure(px, sims)
    if args.csv:
        write_csv(rows, args.csv)
        print("wrote", args.csv)
    if args.sheet:
        sheet(rafs[: args.sheet_max], args.sheet_looks.split(","), args.sheet)
        print("wrote", args.sheet)


if __name__ == "__main__":
    main()

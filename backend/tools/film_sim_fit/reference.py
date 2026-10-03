"""Step 4: the simulations against Fujifilm's stills rendering.

Fujifilm's cubes (import_official.py) are made for F-Log2 video. A camera
renders a still with the same looks but not the same way round the edges, and
nothing Fujifilm publishes says how. What does: the camera-matching profiles
Adobe ships for X cameras, which abpy/FujifilmCameraProfiles turned into plain
cubes - one per look, "to be applied to an image with linear contrast", i.e.
the linear RAW with 1.0 = sensor clipping in, the still out. No recipe in them
(they are the look at the camera's defaults), and none of the user's photos.

Against those, per look Fujifilm publishes a cube for:

  * below middle grey the two tone curves are the same curve (<= 0.01), once
    the cube is fed ~0.9 stops more light: the anchor;
  * above it the still runs on to white at sensor clipping, where the video
    cube has only reached ~0.88 and keeps a long shoulder: the stills shoulder,
    as stops of extra light per position below clipping.

Both come out the same for all nine looks, so the app carries one number and
one table (film_sims._STILLS_ANCHOR / _STILLS_SHOULDER, process version 4).
`--fit` prints them as found here; without it the report says how far the
app's rendering is from the still, per look, before (process 3) and after.

Colour is reported, not corrected: at equal lightness Fujifilm's cube comes out
~15% lower in chroma than abpy's still. One shared 3x3 would halve that, but
abpy's input is Adobe's linear profile, not LibRaw's matrix - the difference
may be Adobe's - and the user's own camera JPEGs do not show such a gap.

    python -m tools.film_sim_fit.reference <cache dir> [--fit] [file.RAF ...]

The cubes are fetched into the cache dir (abpy's repository at a fixed commit;
CC BY-NC-SA 4.0 - a reference to measure against, nothing of it is written
into the app by this file).
"""

from __future__ import annotations

import argparse
import json
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

from app.services import develop_v2, film_sims
from tools.film_sim_fit.official import read_cube

SOURCE = "https://raw.githubusercontent.com/abpy/FujifilmCameraProfiles/b5a1f16abfb2759b337c83d69d9dc49470e7e518/"
# The app's film_sim name -> abpy's file name.
ABPY = {
    "provia": "provia", "velvia": "velvia", "astia": "astia", "classic_chrome": "classic chrome",
    "classic_neg": "classic neg", "pro_neg_std": "pro neg std", "pro_neg_hi": "pro neg hi",
    "reala_ace": "reala ace", "eterna": "eterna", "eterna_bleach_bypass": "bleach bypass",
    "nostalgic_neg": "nostalgic neg",
}
# "Provia to <look>": the still rendered as Provia in, the same still as the look out.
CONVERSIONS = {"classic_neg": "Classic Neg", "eterna_bleach_bypass": "Bleach Bypass", "nostalgic_neg": "Nostalgic Neg"}
# The looks both Fujifilm and abpy publish: what the anchor and shoulder are measured on.
SHARED = [s for s in ABPY if s in film_sims.OFFICIAL_SIMS]

LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
# Positions below sensor clipping (linear, 1.0 = clipping) the shoulder is tabulated at.
SHOULDER_X = np.linspace(0.10, 1.0, 46, dtype=np.float32)


def srgb_encode(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, None)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055).astype(np.float32)


def srgb_decode(v: np.ndarray) -> np.ndarray:
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4).astype(np.float32)


def _fetch(cache: Path, rel: str) -> Path:
    path = cache / rel
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(SOURCE + urllib.parse.quote(rel)) as resp:
            path.write_bytes(resp.read())
    return path


def _cube(path: Path) -> np.ndarray:
    flat = read_cube(path).numpy()
    n = round(len(flat) ** (1 / 3))
    return flat.reshape(n, n, n, 3)


def stills_cube(cache: Path, sim: str) -> np.ndarray:
    """abpy's cube for the look, indexed [r][g][b]: linear contrast (sRGB
    encoded, 1.0 = sensor clipping) in, the still out."""
    return _cube(_fetch(cache, f"cube lut/{ABPY[sim]}_sRGB.cube"))


def conversion_cube(cache: Path, sim: str) -> np.ndarray:
    """abpy's "Provia to <look>" cube, indexed [r][g][b]: display in, display out."""
    return _cube(_fetch(cache, f"provia conversion luts/Provia to {CONVERSIONS[sim]} sRGB.cube"))


def still(cube: np.ndarray, lin: np.ndarray) -> np.ndarray:
    """A list of linear colours (1.0 = sensor clipping) as the still shows them."""
    return film_sims._sample_cube(srgb_encode(np.clip(lin, 0.0, 1.0)), cube)


def official(sim: str, scene: np.ndarray, stills_white: float | None = None) -> np.ndarray:
    """A list of scene colours through the app's rendering of the look."""
    return film_sims.apply_official(scene.reshape(-1, 1, 3).astype(np.float32), sim, stills_white).reshape(scene.shape)


def _grey(v: np.ndarray) -> np.ndarray:
    return np.repeat(np.asarray(v, dtype=np.float32)[:, None], 3, axis=1)


def fit_anchor(cache: Path) -> dict[str, float]:
    """Per look, the factor the cube wants its light multiplied by for its
    grey ramp to lie on the still's, measured from the deep shadows up to
    middle grey (where neither curve has started its shoulder)."""
    x = np.geomspace(0.004, 0.10, 60).astype(np.float32)
    trial = np.geomspace(1.2, 2.8, 400)
    out = {}
    for sim in SHARED:
        ref = still(stills_cube(cache, sim), _grey(x)) @ LUMA
        err = [np.abs(official(sim, _grey(x * k)) @ LUMA - ref).mean() for k in trial]
        out[sim] = float(trial[int(np.argmin(err))])
    return out


def fit_shoulder(cache: Path, anchor: float) -> dict[str, np.ndarray]:
    """Per look, at each SHOULDER_X: how many stops more light than the anchor
    alone the cube has to be given to show what the still shows there."""
    scene = np.geomspace(1e-3, 60.0, 6000).astype(np.float32)
    out = {}
    for sim in SHARED:
        ref = still(stills_cube(cache, sim), _grey(SHOULDER_X)) @ LUMA
        ramp = np.maximum.accumulate(official(sim, _grey(scene)) @ LUMA)
        wanted = np.interp(np.minimum(ref, ramp.max() - 1e-4), ramp, scene)
        out[sim] = np.log2(wanted / (anchor * SHOULDER_X))
    return out


def shared_shoulder(per_look: dict[str, np.ndarray]) -> np.ndarray:
    """One table for all looks: the median, never negative, never turning back."""
    return np.maximum.accumulate(np.maximum(np.median(np.array(list(per_look.values())), axis=0), 0.0))


def colours(n: int, seed: int = 3) -> np.ndarray:
    """Linear colours of every hue, saturation 0..0.85, the brightest channel
    anywhere between deep shadow and sensor clipping."""
    rng = np.random.default_rng(seed)
    base = rng.uniform(0.0, 1.0, (n, 3)).astype(np.float32)
    base /= base.max(axis=1, keepdims=True)
    sat = rng.uniform(0.0, 0.85, (n, 1)).astype(np.float32)
    return (1.0 - (1.0 - base) * sat) * rng.uniform(0.02, 1.0, (n, 1)).astype(np.float32)


def oklab(srgb: np.ndarray) -> np.ndarray:
    return develop_v2.linear_to_oklab(srgb_decode(np.clip(srgb, 0.0, 1.0)))


def _errors(app: np.ndarray, ref: np.ndarray) -> dict:
    a, r = oklab(app), oklab(ref)
    d = np.linalg.norm(a - r, axis=1) * 100.0
    chroma = float(np.hypot(a[:, 1], a[:, 2]).mean() / max(float(np.hypot(r[:, 1], r[:, 2]).mean()), 1e-6))
    return {
        "dE": round(float(d.mean()), 2), "dE_p90": round(float(np.percentile(d, 90)), 2),
        "lightness": round(float(np.abs(a[:, 0] - r[:, 0]).mean() * 100.0), 2), "chroma_ratio": round(chroma, 2),
    }


def report(cache: Path, rafs: list[Path]) -> dict:
    """Per look, how far the app's rendering is from the still: process 3 (the
    cube as it stands) and process 4 (anchor and stills shoulder), on the grey
    ramp, on synthetic colours and on the photos given."""
    ramp = np.linspace(0.005, 1.0, 200).astype(np.float32)
    x = colours(20000)
    photos = [_photo(p) for p in rafs]
    out = {}
    for sim in SHARED:
        cube = stills_cube(cache, sim)
        row = {}
        for process, white in (("3", None), ("4", 1.0)):
            grey = np.abs(official(sim, _grey(ramp), white) @ LUMA - still(cube, _grey(ramp)) @ LUMA)
            row[process] = {
                "grey_max": round(float(grey.max()), 3),
                "grey_below_middle": round(float(grey[ramp <= 0.10].max()), 3),
                "grey_at_clip": round(float(grey[-1]), 3),
                "colours": _errors(official(sim, x, white), still(cube, x)),
            }
            if photos:
                px = np.concatenate(photos)
                row[process]["photos"] = _errors(official(sim, px, white), still(cube, px))
        out[sim] = row
    return out


def _photo(path: Path) -> np.ndarray:
    """A RAF as a list of linear colours, lifted by the app's auto exposure and
    cut off at sensor clipping - the frame as a camera at base ISO would have
    recorded it, which is what abpy's cubes expect."""
    import cv2

    from app.services import raw as raw_service

    lin, gain = raw_service.load_linear_base(path, half_size=True)
    lin = cv2.resize(lin, (240, round(lin.shape[0] * 240 / lin.shape[1])), interpolation=cv2.INTER_AREA)
    return np.clip(lin.reshape(-1, 3) * gain, 0.0, 1.0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cache", type=Path)
    ap.add_argument("rafs", nargs="*", type=Path)
    ap.add_argument("--fit", action="store_true", help="print the anchor and shoulder as measured")
    args = ap.parse_args()

    if args.fit:
        anchors = fit_anchor(args.cache)
        for sim, k in anchors.items():
            print(f"{sim:22} anchor {k:.3f} ({np.log2(k):+.2f} EV)")
        anchor = round(float(np.median(list(anchors.values()))), 2)
        per_look = fit_shoulder(args.cache, anchor)
        for sim, e in per_look.items():
            print(f"{sim:22} shoulder " + " ".join(f"{v:5.2f}" for v in e[::5]))
        print(f"_STILLS_ANCHOR = {anchor}")
        print("_STILLS_SHOULDER =", np.round(shared_shoulder(per_look), 2).tolist())
        return

    result = report(args.cache, args.rafs)
    for sim, row in result.items():
        for process, r in row.items():
            c = r.get("photos", r["colours"])
            print(
                f"{sim:22} process {process}: grey max {r['grey_max']:.3f} (below middle {r['grey_below_middle']:.3f}, "
                f"at clip {r['grey_at_clip']:.3f})   colours dE {c['dE']:.2f} (p90 {c['dE_p90']:.2f}, "
                f"lightness {c['lightness']:.2f}, chroma x{c['chroma_ratio']:.2f})"
            )
    (args.cache / "reference.json").write_text(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()

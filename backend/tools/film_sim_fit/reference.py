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
        [--hues] [--candidates] [--sheet out.jpg [--sheet-max N]]

`--hues` splits the colour error by Oklab hue (12 bands of 30 degrees) and
reports a "foliage" band on top - is the gap a chroma scale the same for every
hue, or does green drift? `--candidates` measures, without touching the app,
what would close it: K1 one chroma factor per look after the cube, K2 one 3x3
shared by all looks in front of the F-Gamut matrix. `--sheet` writes the
photos as App | K1 | K2 | still | difference for Provia and Classic Neg.
`--process-7` renders the app's side with the mix it ships (film_sims._SCENE_MIX,
process version 7) instead of the plain input: the check that the app does
what the candidate measured.

The cubes are fetched into the cache dir (abpy's repository at a fixed commit;
CC BY-NC-SA 4.0 - a reference to measure against, nothing of it is written
into the app by this file).
"""

from __future__ import annotations

import argparse
import contextlib
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


# Set by --process-7: the app's rendering with its own scene mix (process 7).
APP_MIX = False


def official(sim: str, scene: np.ndarray, stills_white: float | None = None) -> np.ndarray:
    """A list of scene colours through the app's rendering of the look."""
    return film_sims.apply_official(
        scene.reshape(-1, 1, 3).astype(np.float32), sim, stills_white, mix=APP_MIX
    ).reshape(scene.shape)


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

    frame = _frame(path)
    small = cv2.resize(frame, (240, round(frame.shape[0] * 240 / frame.shape[1])), interpolation=cv2.INTER_AREA)
    return small.reshape(-1, 3)


# --- by hue ------------------------------------------------------------------

HUE_BANDS = 12
# Foliage as the still shows it: Oklab hue (degrees), chroma and lightness.
FOLIAGE = {"hue": (95.0, 165.0), "chroma": 0.04, "lightness": (0.2, 0.8)}
# Looks the sheet shows: the camera's default and the user's.
SHEET_SIMS = ("provia", "classic_neg")
_PHOTOS: dict[Path, np.ndarray] = {}
WIDTH = 520


def _lch(lab: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    return lab[:, 0], np.hypot(lab[:, 1], lab[:, 2]), np.degrees(np.arctan2(lab[:, 2], lab[:, 1])) % 360.0


def _band_errors(a: np.ndarray, r: np.ndarray, sel: np.ndarray) -> dict:
    """App vs still on the colours `sel` picks (Oklab in): dE, the signed hue
    drift in degrees (app minus still, weighted by the still's chroma, only
    where both have some), chroma ratio and lightness difference."""
    a, r = a[sel], r[sel]
    if len(a) == 0:
        return {"n": 0}
    la, ca, ha = _lch(a)
    lr, cr, hr = _lch(r)
    d = np.linalg.norm(a - r, axis=1) * 100.0
    both = (ca > 0.02) & (cr > 0.02)
    drift = 0.0
    if both.any():
        diff = (ha[both] - hr[both] + 180.0) % 360.0 - 180.0
        drift = float(np.average(diff, weights=cr[both]))
    return {
        "n": int(len(a)), "dE": round(float(d.mean()), 2), "hue_drift": round(drift, 1),
        "chroma_ratio": round(float(ca.mean() / max(float(cr.mean()), 1e-6)), 3),
        "dL": round(float((la - lr).mean() * 100.0), 2),
    }


def hue_report(app: np.ndarray, ref: np.ndarray) -> dict:
    """Per hue band of the still (and for foliage), how the app's rendering
    differs from it. Grey colours (still chroma under 0.01) are left out of
    the bands: they have no hue."""
    a, r = oklab(app), oklab(ref)
    lr, cr, hr = _lch(r)
    out = {}
    for i in range(HUE_BANDS):
        lo = i * 360.0 / HUE_BANDS
        sel = (cr >= 0.01) & (hr >= lo) & (hr < lo + 360.0 / HUE_BANDS)
        out[f"{int(lo):03d}"] = _band_errors(a, r, sel)
    f = FOLIAGE
    sel = (hr >= f["hue"][0]) & (hr < f["hue"][1]) & (cr > f["chroma"]) & (lr > f["lightness"][0]) & (lr < f["lightness"][1])
    out["foliage"] = _band_errors(a, r, sel)
    out["all"] = _band_errors(a, r, cr >= 0.01)
    return out


# --- candidates ----------------------------------------------------------------

def scale_chroma(srgb: np.ndarray, k: float) -> np.ndarray:
    """K1: display colours with their Oklab chroma multiplied by k, lightness
    and hue kept, fitted back into the gamut."""
    lab = oklab(srgb)
    lab[:, 1:] *= k
    return srgb_encode(develop_v2.oklab_to_linear(lab))


def fit_chroma(sim: str, cube: np.ndarray, x: np.ndarray) -> float:
    """K1 per look: the chroma factor after the cube that brings the app's
    rendering closest to the still on the colours x."""
    app, ref = official(sim, x, 1.0), still(cube, x)
    trial = np.linspace(0.95, 1.45, 51)
    err = [np.linalg.norm(oklab(scale_chroma(app, k)) - oklab(ref), axis=1).mean() for k in trial]
    return float(trial[int(np.argmin(err))])


@contextlib.contextmanager
def scene_mix(m: np.ndarray):
    """K2: run the app's rendering with the 3x3 m (rows sum to 1) applied to
    the scene colours before the F-Gamut matrix."""
    saved = film_sims._FGAMUT_FROM_709
    film_sims._FGAMUT_FROM_709 = (saved @ m).astype(np.float32)
    try:
        yield
    finally:
        film_sims._FGAMUT_FROM_709 = saved


def _mix_of(p: np.ndarray) -> np.ndarray:
    """The 3x3 with rows summing to 1 that six off-diagonal numbers describe."""
    m = np.eye(3)
    m[0, 1], m[0, 2], m[1, 0], m[1, 2], m[2, 0], m[2, 1] = p
    m[0, 0], m[1, 1], m[2, 2] = 1.0 - m[0, 1] - m[0, 2], 1.0 - m[1, 0] - m[1, 2], 1.0 - m[2, 0] - m[2, 1]
    return m


def fit_mix(cache: Path, x: np.ndarray, sims: list[str]) -> np.ndarray:
    """K2: one scene 3x3 for all the looks given, least Oklab error against
    the stills on the colours x."""
    from scipy.optimize import minimize

    refs = {sim: oklab(still(stills_cube(cache, sim), x)) for sim in sims}

    def cost(p: np.ndarray) -> float:
        with scene_mix(_mix_of(p)):
            return float(np.mean([np.linalg.norm(oklab(official(sim, x, 1.0)) - refs[sim], axis=1).mean() for sim in sims]))

    res = minimize(cost, np.zeros(6), method="Powell", options={"xtol": 1e-3, "ftol": 1e-5, "maxfev": 2000})
    return _mix_of(res.x)


def candidates(cache: Path, x: np.ndarray, px: np.ndarray | None) -> dict:
    """Per look: the error by hue as it stands, and after K1 and K2, on the
    synthetic colours and on the photos' pixels. K2 is fitted on a sample of
    both, shared by the nine looks the stills exist for."""
    rng = np.random.default_rng(1)
    sample = x[rng.choice(len(x), 4000, replace=False)]
    if px is not None:
        sample = np.concatenate([sample, px[rng.choice(len(px), 12000, replace=False)]])
    mix = fit_mix(cache, sample, SHARED)
    out = {"mix": np.round(mix, 4).tolist(), "looks": {}}
    for sim in SHARED:
        cube = stills_cube(cache, sim)
        k = fit_chroma(sim, cube, sample)
        row = {"chroma_factor": k}
        for label, data in (("colours", x), ("photos", px)):
            if data is None:
                continue
            ref = still(cube, data)
            with scene_mix(mix):
                mixed = official(sim, data, 1.0)
            row[label] = {
                "as_is": hue_report(official(sim, data, 1.0), ref),
                "K1": hue_report(scale_chroma(official(sim, data, 1.0), k), ref),
                "K2": hue_report(mixed, ref),
            }
        out["looks"][sim] = row
    return out


# --- the sheet -----------------------------------------------------------------

def _frame(path: Path) -> np.ndarray:
    """The RAF at WIDTH px, linear, lifted by the app's auto exposure, cut off
    at sensor clipping (HxWx3)."""
    if path not in _PHOTOS:
        import cv2

        from app.services import raw as raw_service

        lin, gain = raw_service.load_linear_base(path, half_size=True)
        lin = cv2.resize(lin, (WIDTH, round(lin.shape[0] * WIDTH / lin.shape[1])), interpolation=cv2.INTER_AREA)
        _PHOTOS[path] = np.clip(lin * gain, 0.0, 1.0)
    return _PHOTOS[path]


def _label(tile: np.ndarray, text: str) -> np.ndarray:
    import cv2

    tile = np.ascontiguousarray(tile)
    cv2.putText(tile, text, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(tile, text, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
    return tile


def _heat(app: np.ndarray, ref: np.ndarray, top: float = 8.0) -> np.ndarray:
    """Oklab dE x100 between two display frames as a colour map, 0 .. top."""
    import cv2

    d = np.linalg.norm(oklab(app.reshape(-1, 3)) - oklab(ref.reshape(-1, 3)), axis=1).reshape(app.shape[:2]) * 100.0
    heat = cv2.applyColorMap((np.clip(d / top, 0.0, 1.0) * 255.0).astype(np.uint8), cv2.COLORMAP_JET)
    return cv2.cvtColor(heat, cv2.COLOR_BGR2RGB)


def sheet(cache: Path, rafs: list[Path], out: Path, chroma: dict[str, float] | None, mix: np.ndarray | None) -> None:
    """One row per photo and look: the app | K1 | K2 | the still | the
    difference app vs still (blue 0 .. red 8 dE)."""
    from PIL import Image

    rows = []
    for path in rafs:
        frame = _frame(path)
        flat = frame.reshape(-1, 3)
        for sim in SHEET_SIMS:
            cube = stills_cube(cache, sim)
            app = official(sim, flat, 1.0)
            ref = still(cube, flat)
            tiles = [(app, f"app{' process 7' if APP_MIX else ''}: {sim}  {path.stem}")]
            if chroma:
                tiles.append((scale_chroma(app, chroma[sim]), f"K1 chroma x{chroma[sim]:.2f}"))
            if mix is not None:
                with scene_mix(mix):
                    tiles.append((official(sim, flat, 1.0), "K2 scene 3x3"))
            tiles.append((ref, "Fujifilm still (abpy)"))
            shown = [_label((t.reshape(frame.shape) * 255.0 + 0.5).astype(np.uint8), text) for t, text in tiles]
            shown.append(_label(_heat(app.reshape(frame.shape), ref.reshape(frame.shape)), "dE app vs still, 0..8"))
            rows.append(np.concatenate(shown, axis=1))
    width = max(r.shape[1] for r in rows)
    rows = [np.pad(r, ((0, 0), (0, width - r.shape[1]), (0, 0))) for r in rows]
    Image.fromarray(np.concatenate(rows, axis=0)).save(out, quality=88)


def _print_hues(label: str, rep: dict) -> None:
    keys = [k for k in rep if k not in ("all", "foliage")]
    print(f"  {label:9} all dE {rep['all']['dE']:.2f} hue {rep['all']['hue_drift']:+.1f} chroma x{rep['all']['chroma_ratio']:.2f} dL {rep['all']['dL']:+.2f}"
          f" | foliage dE {rep['foliage'].get('dE', 0):.2f} hue {rep['foliage'].get('hue_drift', 0):+.1f}"
          f" chroma x{rep['foliage'].get('chroma_ratio', 0):.2f} dL {rep['foliage'].get('dL', 0):+.2f} (n {rep['foliage']['n']})")
    print("            hue  " + " ".join(f"{k:>7}" for k in keys))
    print("            dE   " + " ".join(f"{rep[k].get('dE', 0):7.2f}" for k in keys))
    print("            drift" + " ".join(f"{rep[k].get('hue_drift', 0):+7.1f}" for k in keys))
    print("            chr x" + " ".join(f"{rep[k].get('chroma_ratio', 0):7.2f}" for k in keys))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cache", type=Path)
    ap.add_argument("rafs", nargs="*", type=Path)
    ap.add_argument("--fit", action="store_true", help="print the anchor and shoulder as measured")
    ap.add_argument("--hues", action="store_true", help="the colour error split by hue band")
    ap.add_argument("--candidates", action="store_true", help="K1 / K2 measured against the stills")
    ap.add_argument("--sheet", type=Path, help="write the photos as app | candidates | still | difference")
    ap.add_argument("--sheet-max", type=int, default=12, help="photos on the sheet")
    ap.add_argument("--process-7", action="store_true", help="the app's side with its shipped scene mix")
    args = ap.parse_args()
    global APP_MIX
    APP_MIX = args.process_7

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

    if args.hues or args.candidates or args.sheet:
        x = colours(20000)
        px = np.concatenate([_photo(p) for p in args.rafs]) if args.rafs else None
        chroma, mix = None, None
        if args.candidates:
            cand = candidates(args.cache, x, px)
            mix = np.array(cand["mix"])
            chroma = {sim: row["chroma_factor"] for sim, row in cand["looks"].items()}
            print("K2 scene 3x3 (rows sum to 1):", cand["mix"])
            for sim, row in cand["looks"].items():
                print(f"{sim:22} K1 chroma x{row['chroma_factor']:.2f}")
                for label in ("photos", "colours"):
                    if label in row:
                        for variant in ("as_is", "K1", "K2"):
                            _print_hues(f"{label[:7]} {variant}", row[label][variant])
            (args.cache / "candidates.json").write_text(json.dumps(cand, indent=1))
        elif args.hues:
            hues = {}
            for sim in SHARED:
                cube = stills_cube(args.cache, sim)
                print(sim)
                hues[sim] = {"colours": hue_report(official(sim, x, 1.0), still(cube, x))}
                _print_hues("colours", hues[sim]["colours"])
                if px is not None:
                    hues[sim]["photos"] = hue_report(official(sim, px, 1.0), still(cube, px))
                    _print_hues("photos", hues[sim]["photos"])
            (args.cache / "hues.json").write_text(json.dumps(hues, indent=1))
        if args.sheet:
            sheet(args.cache, args.rafs[: args.sheet_max], args.sheet, chroma, mix)
            print(args.sheet)
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

"""Step 5: scene cubes for the looks Fujifilm publishes none for.

Fujifilm's pack has ten looks. The other ten the app offers used to sit behind
the app's own tone map as display cubes - a different tone path from the
official ten, so they answered differently to light and to highlights. Here
each gets a cube of the same kind as Fujifilm's (F-Log2 / F-Gamut in, display
out, 65 nodes, film_luts/derived/<sim>.npy) by taking the published look it is
closest to and adding only what sets it apart, read off a source that has both:

  pro_neg_hi             Fujifilm's Pro Neg. Std + bastibe's (Pro Neg Hi - Pro Neg Std)
  nostalgic_neg          the cube measured from the camera's JPEGs (film_luts/
                         nostalgic_neg.npy, fit.py) behind the app's render,
                         lifted so middle grey lands where Fujifilm's looks put it
  acros_ye / _r / _g     Fujifilm's Acros x bastibe's (Acros+filter / Acros)
  monochrome, + filters  Fujifilm's Provia tonality x bastibe's (Mono.. / Provia)
  sepia                  the same, per channel (the tint comes with it)

Nothing is fitted. Tone curve, highlight roll-off and the anchor are Fujifilm's
(film_sims.apply_official), so all twenty looks render down one path. The
exception is Nostalgic Neg., which nobody publishes under a free licence
(abpy's is non-commercial): its cube is the camera's own JPEGs as fit.py
measured them, the tone included. Baked the same way, the measured Classic
Chrome, Classic Neg., Eterna and Reala Ace (commit 5349b969) came within
2.6-4.6/255 of Fujifilm's cubes on average.

Each rule is checked on looks Fujifilm does publish before anything is written:
the same construction has to reproduce Fujifilm's own Classic Neg., Bleach
Bypass, Classic Chrome and Acros closely, or the run stops.

    python -m tools.film_sim_fit.derive <abpy cache dir> <dir with bastibe's HaldCLUTs>

The second directory holds the "Fuji XTrans V8" HaldCLUTs of
bastibe/Fujifilm-Auto-Settings-for-Darktable at commit BASTIBE_COMMIT, under
their own names (acros.png, acros-red.png, mono.png, ...). bastibe made them
with his LUT-Maker from neutral renders and the camera's JPEGs; 16 nodes an
axis, applied to a neutral sRGB render of the RAW.

Sources and licences. bastibe's LUTs are GPL: the nine cubes made from them
are under the GPL v3 too (GPL_LICENSE.txt beside them, SOURCES.txt says
where they come from). Nostalgic Neg. is this project's own measurement.
abpy/FujifilmCameraProfiles (CC BY-NC-SA 4.0, reference.py fetches it) is
only measured against here - the checks below - and nothing made from it is
written. Deleting a cube puts its look back on
the display cube / recipe.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch

from app.services import develop_v2, film_sims
from tools.film_sim_fit import fit as FT
from tools.film_sim_fit import reference as R
from tools.film_sim_fit.official import read_hald

N = 65
BASTIBE_REPO = "https://github.com/bastibe/Fujifilm-Auto-Settings-for-Darktable"
BASTIBE_COMMIT = "79a458ce9bc28c870091c978b829aaed8dbdb45a"
# The app's film_sim name -> bastibe's file name.
BASTIBE = {
    "provia": "provia", "acros": "acros", "acros_ye": "acros-yellow", "acros_r": "acros-red",
    "acros_g": "acros-green", "monochrome": "mono", "monochrome_ye": "mono-yellow",
    "monochrome_r": "mono-red", "monochrome_g": "mono-green", "sepia": "sepia",
    "pro_neg_std": "pro_neg_std", "pro_neg_hi": "pro_neg_high", "classic_chrome": "classic_chrome",
}
_FLOG2_CUT2 = 0.100686685370811
# A ratio of two luminances near black is noise: both get this much added.
_EPS = 0.002

SOURCES = """Scene cubes for the film simulations Fujifilm publishes no LUT for, built by
backend/tools/film_sim_fit/derive.py.

nostalgic_neg.npy
    The cube measured from the camera's own JPEGs (../nostalgic_neg.npy,
    backend/tools/film_sim_fit/fit.py), baked into a scene cube. Part of
    Rollfilm, under its MIT licence.

acros_ye.npy, acros_r.npy, acros_g.npy, monochrome.npy, monochrome_ye.npy,
monochrome_r.npy, monochrome_g.npy, sepia.npy, pro_neg_hi.npy
    Derived from the "Fuji XTrans V8" LUTs of Fujifilm Auto Settings for
    Darktable by Bastian Bechtold
    ({repo}, commit
    {commit}), licensed GPL
    (version 3, GPL_LICENSE.txt). Modified by Pasqual Kreher: each look is
    taken as its ratio to (Pro Neg. Hi: its Oklab difference from) the
    source's own Acros / Provia / Pro Neg. Std, laid over Fujifilm's cube for
    that look and resampled to a 65-node scene cube. These nine files are
    under the same licence.

Removing a file puts its look back on the cube or recipe it had before.
"""


def _scene_nodes() -> np.ndarray:
    """The linear BT.709 colour of every cube node, (N^3, 3) in [r][g][b] order."""
    axis = np.linspace(0.0, 1.0, N)
    r, g, b = np.meshgrid(axis, axis, axis, indexing="ij")
    code = np.stack([r, g, b], axis=-1).reshape(-1, 3)
    fgamut = np.where(
        code >= _FLOG2_CUT2,
        (10.0 ** ((code - film_sims._FLOG2_D) / film_sims._FLOG2_C) - film_sims._FLOG2_B) / film_sims._FLOG2_A,
        (code - film_sims._FLOG2_F) / film_sims._FLOG2_E,
    )
    return (fgamut @ np.linalg.inv(film_sims._FGAMUT_FROM_709.astype(np.float64)).T).astype(np.float32)


def _raw_nodes(scene: np.ndarray) -> np.ndarray:
    """What the sensor recorded at each node (linear, 1.0 = clipping): the
    node's scene colour with the anchor and stills shoulder taken back off, as
    film_sims puts them on for a frame at the camera's own exposure."""
    y, factor = film_sims._stills_factors(1.0)
    lifted = y * factor
    luma = scene @ R.LUMA
    below, above = luma / factor[0], luma / factor[-1]
    raw = np.where(luma <= lifted[0], below, np.where(luma >= lifted[-1], above, np.interp(luma, lifted, y)))
    return np.clip(scene * (raw / np.maximum(luma, 1e-9))[:, None], 0.0, 1.0).astype(np.float32)


def _official(sim: str) -> np.ndarray:
    return film_sims.official_cube(sim).reshape(-1, 3)


def _hald(src: Path, sim: str) -> np.ndarray:
    flat = read_hald(src / f"{BASTIBE[sim]}.png").numpy()
    n = round(len(flat) ** (1 / 3))
    return flat.reshape(n, n, n, 3)


def _look(cube: np.ndarray, encoded: np.ndarray) -> np.ndarray:
    return film_sims._sample_cube(np.clip(encoded, 0.0, 1.0).astype(np.float32), cube)


def _lin_luma(display: np.ndarray) -> np.ndarray:
    return R.srgb_decode(display) @ R.LUMA


def converted(cache: Path, sim: str) -> np.ndarray:
    """Fujifilm's Provia, then abpy's Provia-to-`sim` cube: display to display."""
    return _look(R.conversion_cube(cache, sim), _official("provia"))


def shifted(cache: Path, base: str, sim: str, raw: np.ndarray) -> np.ndarray:
    """Fujifilm's `base`, moved in Oklab by what separates abpy's `sim` from
    abpy's `base` for the same recorded colour."""
    x = R.srgb_encode(raw)
    delta = R.oklab(_look(R.stills_cube(cache, sim), x)) - R.oklab(_look(R.stills_cube(cache, base), x))
    return R.srgb_encode(develop_v2.oklab_to_linear(R.oklab(_official(base)) + delta))


def shifted_bastibe(src: Path, base: str, sim: str, x: np.ndarray) -> np.ndarray:
    """Fujifilm's `base`, moved in Oklab by what separates bastibe's `sim` from
    bastibe's `base` for the same colour (the same rule as `shifted`)."""
    over = R.oklab(_look(_hald(src, sim), x))
    under = R.oklab(_look(_hald(src, base), x))
    return R.srgb_encode(develop_v2.oklab_to_linear(R.oklab(_official(base)) + over - under))


def measured(sim: str, scene: np.ndarray) -> np.ndarray:
    """The look as fit.py measured it from the camera's JPEGs (a display cube
    behind the app's render, film_luts/<sim>.npy), as a scene cube: the app's
    render of what the sensor recorded at each node, with the gain that puts
    middle grey (0.097 of clipping) at the 0.46 every Fujifilm look has there,
    looked up in the measured cube. Clipping comes out white: the render's
    shoulder has its white point at the gain. Nodes below F-Log2's black
    (negative scene values) are black."""
    cube = film_sims._measured_cube(sim)
    raw = _raw_nodes(np.maximum(scene, 0.0))

    def render(r: np.ndarray, gain: float) -> np.ndarray:
        v = FT.app_render(torch.from_numpy(r.astype(np.float32)), torch.full((len(r),), gain))
        return _look(cube, v.numpy().astype(np.float32))

    grey = np.full((1, 3), 0.097, np.float32)
    trial = np.geomspace(1.0, 12.0, 600)
    gain = float(trial[int(np.argmin([abs(float(render(grey, g)[0] @ R.LUMA) - 0.46) for g in trial]))])
    print(f"{sim}: measured cube behind the app's render at gain {gain:.2f}")
    return render(raw, gain)


def _neutral_input(src: Path, cache: Path, raw: np.ndarray) -> np.ndarray:
    """The recorded colours as bastibe's cubes expect them: a neutral render,
    which sits at another brightness than abpy's linear one. The factor is the
    one that lays bastibe's Provia grey ramp on abpy's, up to middle grey."""
    ramp = np.geomspace(0.01, 0.12, 40).astype(np.float32)
    target = R.still(R.stills_cube(cache, "provia"), R._grey(ramp)) @ R.LUMA
    provia = _hald(src, "provia")
    trial = np.geomspace(0.4, 4.0, 400)
    err = [np.abs(_look(provia, R.srgb_encode(R._grey(ramp * k))) @ R.LUMA - target).mean() for k in trial]
    k = float(trial[int(np.argmin(err))])
    print(f"bastibe's neutral render = abpy's linear x {k:.2f}")
    return R.srgb_encode(np.clip(raw * k, 0.0, 1.0))


def filtered(src: Path, base: str, sim: str, x: np.ndarray, tonality: str | None = None) -> np.ndarray:
    """A monochrome look: the luminance of Fujifilm's `tonality` cube (`base`
    itself unless given) times what bastibe's `sim` shows against bastibe's
    `base` for the same colour, channel by channel (equal channels for a grey
    look, a tint for Sepia)."""
    def ratio(x: np.ndarray) -> np.ndarray:
        over = R.srgb_decode(_look(_hald(src, sim), x))
        under = _lin_luma(_look(_hald(src, base), x))
        return (over + _EPS) / (under + _EPS)[:, None]

    # A filter leaves a grey as bright as it was: the ratio is taken against
    # the one a grey of the same brightness gets (its luminance only, so
    # Sepia keeps its tint), which pins the grey ramp to Fujifilm's.
    grey = R.srgb_encode(np.repeat((R.srgb_decode(x) @ R.LUMA)[:, None], 3, axis=1))
    out = _lin_luma(_official(tonality or base))[:, None] * ratio(x) / (ratio(grey) @ R.LUMA)[:, None]
    if sim != "sepia":
        out = np.repeat((out @ R.LUMA)[:, None], 3, axis=1)
    return R.srgb_encode(np.clip(out, 0.0, 1.0))


def _check(name: str, made: np.ndarray, sim: str, limit: float) -> None:
    """`made` against Fujifilm's own cube for `sim`, on ordinary scene colours."""
    rng = np.random.default_rng(1)
    scene = (0.18 * 2.0 ** rng.uniform(-5, 2, (40000, 1)) * rng.uniform(0.3, 1.0, (40000, 3))).astype(np.float32)
    code = film_sims._flog2(np.maximum(scene @ film_sims._FGAMUT_FROM_709.T, 0.0))
    a = film_sims._sample_cube(code, made.reshape(N, N, N, 3).astype(np.float32))
    b = film_sims._sample_cube(code, film_sims.official_cube(sim))
    d = np.abs(a - b) * 255.0
    print(f"check {name:34} against Fujifilm's {sim:22} mean {d.mean():.1f}/255  p99 {np.percentile(d, 99):.1f}")
    if d.mean() > limit:
        raise SystemExit(f"{name}: {d.mean():.1f}/255 from Fujifilm's own cube (limit {limit})")


def main() -> None:
    cache, src = Path(sys.argv[1]), Path(sys.argv[2])
    scene = _scene_nodes()
    raw = _raw_nodes(scene)
    x = _neutral_input(src, cache, raw)

    _check("Provia + abpy conversion", converted(cache, "classic_neg"), "classic_neg", 2.5)
    _check("Provia + abpy conversion", converted(cache, "eterna_bleach_bypass"), "eterna_bleach_bypass", 2.5)
    _check("Provia + abpy difference", shifted(cache, "provia", "classic_chrome", raw), "classic_chrome", 4.0)
    _check("Provia x bastibe ratio", filtered(src, "provia", "acros", x), "acros", 4.0)
    _check("Provia + bastibe difference", shifted_bastibe(src, "provia", "classic_chrome", x), "classic_chrome", 4.0)

    cubes = {
        "nostalgic_neg": measured("nostalgic_neg", scene),
        "pro_neg_hi": shifted_bastibe(src, "pro_neg_std", "pro_neg_hi", x),
        "monochrome": filtered(src, "provia", "monochrome", x),
        "sepia": filtered(src, "provia", "sepia", x),
    }
    for f in ("ye", "r", "g"):
        cubes[f"acros_{f}"] = filtered(src, "acros", f"acros_{f}", x)
        cubes[f"monochrome_{f}"] = filtered(src, "provia", f"monochrome_{f}", x)

    out = film_sims._DERIVED_DIR
    out.mkdir(parents=True, exist_ok=True)
    for sim, cube in sorted(cubes.items()):
        np.save(out / f"{sim}.npy", np.clip(cube, 0.0, 1.0).reshape(N, N, N, 3).astype(np.float16))
        print(f"{sim:22} -> {out.name}/{sim}.npy")
    (out / "SOURCES.txt").write_text(SOURCES.format(repo=BASTIBE_REPO, commit=BASTIBE_COMMIT))


if __name__ == "__main__":
    main()

"""Import the film scan looks: black & white, colour, instant and cross-processed
film stocks from the RawTherapee Film Simulation Collection (Pat David, Pavlov
Dmitry, Michael Ezra; CC BY-SA 4.0 - README.txt in
http://rawtherapee.com/shared/HaldCLUT.zip), and five stocks that collection
has not from t3mujinpack (João Almeida; MIT - LICENSE.txt in
https://github.com/t3mujin/t3mujinpack), as display cubes in the app's format
(film_luts/clut/<sim>.npy, 33 nodes, float16, indexed [r][g][b]).

    python -m tools.film_sim_fit.import_clut <cache dir>

The HaldCLUTs (8 bit, sRGB in and out) are fetched into the cache dir at a
pinned commit each: the collection's from the mirror the G'MIC and Natron
projects use, t3mujinpack's from its own repository. Of the 290 the collection
has, the ones taken are one per stock: no pushed or pulled variants (exposure
is not part of a look), no "generic" doubles, none of the stocks the analog
film looks already render from a scene cube, not the print film set, whose
author states no licence, and not FP-3000B's high-contrast and negative
versions, which render like the one taken. FP-100C's cool and
reclaimed-negative versions are looks of their own and are taken.

A black & white stock whose cube is grey to within the 8 bits it was stored in
is made exactly grey, as Fujifilm's Acros is on import; one that is toned (a
Polaroid) keeps its tone. For each look the grey ramp is printed - black,
middle grey, white, whether it ever turns back, how far it leaves neutral -
and what thinning the file's nodes to 33 costs on random colours.
"""

from __future__ import annotations

import shutil
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

from app.services import film_sims
from tools.film_sim_fit.official import read_hald

COMMIT = "af7b50d4caf6244fb6895a647f5b6a84efe7931a"
SOURCE = f"https://raw.githubusercontent.com/NatronGitHub/clut/{COMMIT}/"
T3MUJIN_COMMIT = "0b421f3e25209ed78253d1724a29cc6255c5e7fe"
T3MUJIN_SOURCE = f"https://raw.githubusercontent.com/t3mujin/t3mujinpack/{T3MUJIN_COMMIT}/"
# t3mujinpack's HaldCLUTs lie in this folder of its repository; the mirror has
# none of that name.
_T3MUJIN_DIR = "haldcluts/"
NODES = 33

# The app's film_sim name -> the HaldCLUT in the mirror, or in t3mujinpack
# (without ".png").
CLUTS = {
    "kodak_portra_160_nc": "negative_color/kodak_portra_160_nc",
    "kodak_portra_160_vc": "negative_color/kodak_portra_160_vc",
    "kodak_portra_400_nc": "negative_old/kodak_portra_400_nc",
    "kodak_portra_400_uc": "negative_old/kodak_portra_400_uc",
    "kodak_portra_400_vc": "negative_old/kodak_portra_400_vc",
    "kodak_colorplus_200": "haldcluts/t3mujinpack - Color Negative - Kodak ColorPlus 200",
    "fuji_160c": "negative_new/fuji_160c",
    "fuji_800z": "negative_new/fuji_800z",
    "fuji_superia_100": "negative_old/fuji_superia_100",
    "fuji_superia_200": "negative_color/fuji_superia_200",
    "fuji_superia_400": "negative_old/fuji_superia_400",
    "fuji_superia_800": "negative_old/fuji_superia_800",
    "fuji_superia_1600": "negative_old/fuji_superia_1600",
    "fuji_superia_hg_1600": "negative_color/fuji_superia_hg_1600",
    "fuji_superia_reala_100": "negative_color/fuji_superia_reala_100",
    "fuji_superia_xtra_800": "negative_color/fuji_superia_x-tra_800",
    "agfa_vista_100": "haldcluts/t3mujinpack - Color Negative - Agfa Vista 100",
    "agfa_vista_200": "negative_color/agfa_vista_200",
    "agfa_vista_400": "haldcluts/t3mujinpack - Color Negative - Agfa Vista 400",
    "agfa_ultra_color_100": "negative_color/agfa_ultra_color_100",
    "kodak_elite_color_200": "negative_color/kodak_elite_color_200",
    "kodak_elite_color_400": "negative_color/kodak_elite_color_400",
    "fuji_velvia_50": "colorslide/fuji_velvia_50",
    "fuji_fortia_sp_50": "haldcluts/t3mujinpack - Color Slide - Fuji Fortia SP 50",
    "fuji_astia_100f": "colorslide/fuji_astia_100f",
    "fuji_provia_400f": "colorslide/fuji_provia_400f",
    "fuji_provia_400x": "colorslide/fuji_provia_400x",
    "fuji_sensia_100": "colorslide/fuji_sensia_100",
    "kodak_kodachrome_25": "colorslide/kodak_kodachrome_25",
    "kodak_kodachrome_200": "colorslide/kodak_kodachrome_200",
    "kodak_ektachrome_100_g": "haldcluts/t3mujinpack - Color Slide - Kodak Ektachrome 100 G",
    "kodak_ektachrome_100_gx": "colorslide/kodak_e-100_gx_ektachrome_100",
    "kodak_ektachrome_100_vs": "colorslide/kodak_ektachrome_100_vs",
    "kodak_elite_chrome_200": "colorslide/kodak_elite_chrome_200",
    "kodak_elite_chrome_400": "colorslide/kodak_elite_chrome_400",
    "kodak_elite_extracolor_100": "colorslide/kodak_elite_extracolor_100",
    "agfa_precisa_100": "colorslide/agfa_precisa_100",
    "kodak_tri_x_400": "bw/kodak_tri-x_400",
    "kodak_tmax_100": "bw/kodak_t-max_100",
    "kodak_tmax_400": "bw/kodak_t-max_400",
    "kodak_tmax_3200": "bw/kodak_t-max_3200",
    "kodak_bw_400cn": "bw/kodak_bw_400_cn",
    "kodak_hie": "bw/kodak_hie_(hs_infra)",
    "ilford_hp5_plus_400": "bw/ilford_hp5_plus_400",
    "ilford_hps_800": "bw/ilford_hps_800",
    "ilford_fp4_plus_125": "bw/ilford_fp4_plus_125",
    "ilford_delta_100": "bw/ilford_delta_100",
    "ilford_delta_400": "bw/ilford_delta_400",
    "ilford_delta_3200": "bw/ilford_delta_3200",
    "ilford_pan_f_plus_50": "bw/ilford_pan_f_plus_50",
    "ilford_xp2": "bw/ilford_xp2",
    "fuji_neopan_acros_100": "bw/fuji_neopan_acros_100",
    "fuji_neopan_1600": "bw/fuji_neopan_1600",
    "agfa_apx_25": "bw/agfa_apx_25",
    "agfa_apx_100": "bw/agfa_apx_100",
    "rollei_retro_80s": "bw/rollei_retro_80s",
    "rollei_retro_100_tonal": "bw/rollei_retro_100_tonal",
    "rollei_ortho_25": "bw/rollei_ortho_25",
    "rollei_ir_400": "bw/rollei_ir_400",
    "polaroid_664": "bw/polaroid_664",
    "polaroid_665": "instant_pro/polaroid_665",
    "polaroid_667": "bw/polaroid_667",
    "polaroid_669": "instant_pro/polaroid_669",
    "polaroid_672": "bw/polaroid_672",
    "polaroid_690": "instant_pro/polaroid_690",
    "polaroid_px_70": "instant_consumer/polaroid_px-70",
    "polaroid_px_680": "instant_consumer/polaroid_px-680",
    "polaroid_time_zero": "instant_consumer/polaroid_time_zero_(expired)",
    "polaroid_polachrome": "colorslide/polaroid_polachrome",
    "fuji_fp_100c": "instant_pro/fuji_fp-100c",
    "fuji_fp_100c_cool": "instant_pro/fuji_fp-100c_cool",
    "fuji_fp_100c_negative": "instant_pro/fuji_fp-100c_negative",
    "fuji_fp_3000b": "instant_pro/fuji_fp-3000b",
    "kodak_elite_100_xpro": "negative_color/kodak_elite_100_xpro",
    "fuji_superia_200_xpro": "colorslide/fuji_superia_200_xpro",
    "lomography_xpro_slide_200": "colorslide/lomography_x-pro_slide_200",
    "lomography_redscale_100": "negative_color/lomography_redscale_100",
}
assert tuple(CLUTS) == film_sims.CLUT_SIMS, set(CLUTS) ^ set(film_sims.CLUT_SIMS)

# A cube this close to grey everywhere is a grey one stored in 8 bits.
_GREY_WITHIN = 2.0 / 255.0

_SOURCES = """Display cubes for the film scan looks (sRGB in, sRGB out, 33 nodes),
imported by backend/tools/film_sim_fit/import_clut.py.

Derived from the RawTherapee Film Simulation Collection, version 2015-09-20,
by Pat David, Pavlov Dmitry and Michael Ezra
http://rawtherapee.com/shared/HaldCLUT.zip
(as mirrored at https://github.com/NatronGitHub/clut, commit {commit})
Licensed CC BY-SA 4.0 - https://creativecommons.org/licenses/by-sa/4.0/
Modified by Pasqual Kreher: each HaldCLUT is thinned from 144 nodes an axis
to 33 and stored as a numpy array; the black & white stocks that are grey to
within their 8 bits are made exactly grey. These files are under the same
licence.

{films}

Five more are derived from t3mujinpack by João Almeida
https://github.com/t3mujin/t3mujinpack (commit {t3mujin_commit})
Licensed MIT - copyright and permission notice in T3MUJINPACK_LICENSE.txt,
next to this file. Thinned and stored the same way.

{t3mujin_films}

The trademarked names in the file names are there to say which film stock a
cube is made to approximate. Neither the authors nor Rollfilm are affiliated
with or endorsed by the companies that own them.

Removing a file leaves its look in the list without effect: the picture stays
as it is.
"""


def _fetch(cache: Path, rel: str, source: str | None = None) -> Path:
    path = cache / rel
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        source = source or (T3MUJIN_SOURCE if rel.startswith(_T3MUJIN_DIR) else SOURCE)
        with urllib.request.urlopen(source + urllib.parse.quote(rel)) as resp:
            path.write_bytes(resp.read())
    return path


def main() -> None:
    cache = Path(sys.argv[1])
    out_dir = film_sims._CLUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    luma = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    colours = np.random.default_rng(0).random((1, 20000, 3)).astype(np.float32)
    print(f"{'':28s} black  grey  white  back  tint  thin(mean/max)")
    for sim, rel in CLUTS.items():
        path = _fetch(cache, rel + ".png")
        cube = read_hald(path, NODES).numpy().reshape(NODES, NODES, NODES, 3)
        with Image.open(path) as image:
            own = round(image.height ** (2 / 3))
        full = read_hald(path, own).numpy().reshape(own, own, own, 3)
        grey = bool((cube.max(axis=-1) - cube.min(axis=-1)).max() < _GREY_WITHIN)
        if grey:
            cube = np.repeat(cube.mean(axis=-1, keepdims=True), 3, axis=-1)
        np.save(out_dir / f"{sim}.npy", cube.astype(np.float16))
        ramp = cube[np.arange(NODES), np.arange(NODES), np.arange(NODES)]
        y = ramp @ luma
        tint = float((ramp.max(axis=-1) - ramp.min(axis=-1)).max())
        thin = np.abs(film_sims._sample_cube(colours, cube) - film_sims._sample_cube(colours, full)) * 255
        print(
            f"{sim:28s} {y[0]:.3f} {y[16]:.3f} {y[-1]:.3f} {float(np.diff(y).min()):+.3f} {tint:.3f}"
            f"  {thin.mean():.2f}/{thin.max():.1f}" + ("  grey" if grey else "")
        )
    films, t3mujin_films = (
        "\n".join(
            f"{sim}.npy\n    {rel}.png" for sim, rel in CLUTS.items() if rel.startswith(_T3MUJIN_DIR) is t3mujin
        )
        for t3mujin in (False, True)
    )
    (out_dir / "SOURCES.txt").write_text(
        _SOURCES.format(commit=COMMIT, films=films, t3mujin_commit=T3MUJIN_COMMIT, t3mujin_films=t3mujin_films),
        encoding="utf-8",
    )
    shutil.copyfile(_fetch(cache, "LICENSE.txt", T3MUJIN_SOURCE), out_dir / "T3MUJINPACK_LICENSE.txt")


if __name__ == "__main__":
    main()

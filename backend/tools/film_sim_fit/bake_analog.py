# /// script
# requires-python = "~=3.13"
# dependencies = [
#     "spektrafilm @ git+https://github.com/andreavolpato/spektrafilm@3bb2c2d2801ff68b92019cf1dbcbb133d60832bc",
# ]
# ///
"""Bake the analog film looks: one scene cube per film stock, of the same kind
as Fujifilm's (F-Log2 / F-Gamut code values in, display sRGB out, 65 points),
rendered by spektrafilm - Andrea Volpato's spectral simulation of a film, its
development and its print (https://github.com/andreavolpato/spektrafilm).

    uv run backend/tools/film_sim_fit/bake_analog.py [--only id,id] [--out DIR]

Runs on its own: spektrafilm wants Python 3.13 and a GUI stack the backend has
no use for, so it is never imported by the app - uv builds the environment from
the header above, pinned to the commit whose lut_mode switches exposure
compensation, halation and print compensation off. Only the cubes ship
(film_luts/analog/<id>.npy, float16, indexed [r][g][b]), under spektrafilm's
licence for LUTs, CC BY-SA 4.0: SPEKTRAFILM_LICENSE.txt is copied next to them
and SOURCES.txt names the author.

A negative is printed on the paper its profile names (a cine negative on Kodak
2383); a slide is scanned, which spektrafilm's own LUT builder does not do - it
would print the slide on paper - so the builder's pipeline is given scan_film
here.

The medium's white and black are put on the display's (spektrafilm's own level
correction, which keeps middle grey where it is): a cube shows 18% grey as
middle grey and runs into white some three stops above it, each stock on its
own shoulder. The grey ramps are printed - film_sims puts the camera's middle
grey on the cube's 0.18 (the anchor) and reads each cube's shoulder itself.
"""

from __future__ import annotations

import argparse
import importlib.resources
import shutil
from pathlib import Path

import numpy as np

COMMIT = "3bb2c2d2801ff68b92019cf1dbcbb133d60832bc"
RESOLUTION = 65

_ENDURA = "kodak_portra_endura"
_CRYSTAL = "fujifilm_crystal_archive_typeii"
_2383 = "kodak_2383"
# Look id (the stock's spektrafilm profile) -> the print it is made on (the one
# its profile names); None for a slide. Every colour stock spektrafilm has: on
# the tone film_sims gives a film look, Portra 160 and 800, Gold 200 and
# UltraMax 400 render nearly as Portra 400 does, Vision3 250D and Verita 200D
# as 50D, Vision3 200T as 500T - they are in the list to be found by name.
FILMS: dict[str, str | None] = {
    "kodak_gold_200": _ENDURA,
    "kodak_ultramax_400": _ENDURA,
    "kodak_ektar_100": _ENDURA,
    "kodak_portra_160": _ENDURA,
    "kodak_portra_400": _ENDURA,
    "kodak_portra_800": _ENDURA,
    "kodak_portra_800_push1": _ENDURA,
    "kodak_portra_800_push2": _ENDURA,
    "fujifilm_c200": _CRYSTAL,
    "fujifilm_xtra_400": _CRYSTAL,
    "fujifilm_pro_400h": _CRYSTAL,
    "kodak_vision3_50d": _2383,
    "kodak_vision3_250d": _2383,
    "kodak_verita_200d": _2383,
    "kodak_vision3_200t": _2383,
    "kodak_vision3_500t": _2383,
    "kodak_kodachrome_64": None,
    "kodak_ektachrome_100": None,
    "fujifilm_provia_100f": None,
    "fujifilm_velvia_100": None,
}
# The black & white stock, which spektrafilm has on its dev branch only: baked
# by bake_analog_bw.py, which pins that commit, so that the cubes above stay
# the ones of the release.
BW_COMMIT = "6cd00c8d4f30b5b550f50f4bbd3753c9f2a48507"
BW_FILMS: dict[str, str | None] = {
    "kodak_doublex": "kodak_2302",
}

_DEFAULT_OUT = Path(__file__).resolve().parents[2] / "app" / "services" / "film_luts" / "analog"

_SOURCES = """Scene cubes for the analog film looks (F-Log2 / F-Gamut code values in,
display sRGB out), baked by backend/tools/film_sim_fit/bake_analog.py.

Derived from spektrafilm by Andrea Volpato
https://github.com/andreavolpato/spektrafilm (commit {commit})
Licensed CC BY-SA 4.0 - full text and attribution requirements in
SPEKTRAFILM_LICENSE.txt, next to this file.
Modified by Pasqual Kreher: the profiles are rendered into 3D LUTs for
Rollfilm, each negative on the print named below, each slide scanned.

{films}

From spektrafilm's dev branch (commit {bw_commit}), made exactly grey:

{bw_films}

Removing a file takes its look out of the scene path.
"""


def _flog2(x: np.ndarray) -> np.ndarray:
    """F-Log2 code values of scene reflectance (as film_sims._flog2)."""
    return np.where(
        x >= 0.000889, 0.245281 * np.log10(5.555556 * x + 0.064829) + 0.384316, 8.799461 * x + 0.092864
    )


def _bake(film: str, print_stock: str | None, resolution: int) -> np.ndarray:
    from spektrafilm_lut_creator.builders import BundleBuilder
    from spektrafilm.utils.gamut_compression import OutputGamutCompressSpec
    from spektrafilm_lut_creator.bundles import BundleSpec

    class _Builder(BundleBuilder):
        def _make_pipeline(self, spec, in_entry, out_entry, stock):
            # BundleBuilder._make_pipeline, with the scan of the film itself
            # in place of the print for a slide.
            from spektrafilm.runtime.params_builder import digest_params, init_params
            from spektrafilm.runtime.pipeline import SimulationPipeline

            params = init_params(film_profile=spec.film_profile, print_profile=stock)
            params.debug.lut_mode = True
            params.io.input_color_space = in_entry.primaries
            params.io.output_color_space = out_entry.primaries
            params.io.input_cctf_decoding = False
            params.io.output_cctf_encoding = False
            params.io.input_gamut_compress = spec.input_gamut_compress
            params.io.output_gamut_compress = spec.output_gamut_compress
            params.io.scan_film = print_stock is None
            params = digest_params(params)
            # lut_mode switches the scanner's level correction off with the
            # image-dependent adjustments, but it depends on the medium alone:
            # the paper's (the slide's) white and black go to display white
            # and black, and the exposure moves so that middle grey stays put.
            # Without it a print's white stops at 0.86 on the screen and a
            # paper's black sits at 0.05.
            params.scanner.white_correction = True
            params.scanner.black_correction = True
            params.scanner.white_level = 1.0
            return SimulationPipeline(params)

    spec = BundleSpec(
        film_profile=film,
        # A slide has no print; the builder still wants one named.
        print_profiles=(print_stock or _ENDURA,),
        input_color_space="flog2",
        output_color_space="sRGB",
        topology="1lut",
        resolution=resolution,
        # The chroma compression into sRGB stays; the lightness roll-off that
        # comes with it is made for values above white, which the level
        # correction leaves none of, and holds white itself down to 0.89.
        output_gamut_compress=OutputGamutCompressSpec(lightness_compression=None),
    )
    (_, lut), = _Builder(spec).build().luts
    # Lut.table is [b][g][r]; the app's cubes are [r][g][b].
    return np.ascontiguousarray(np.asarray(lut.table, dtype=np.float32).transpose(2, 1, 0, 3))


def _grey_ramp(cube: np.ndarray, stops: np.ndarray) -> np.ndarray:
    """The cube's display code values for neutral scene values 0.18 * 2**stops."""
    n = cube.shape[0]
    at = np.clip(_flog2(0.18 * 2.0 ** stops), 0.0, 1.0) * (n - 1)
    diagonal = cube[np.arange(n), np.arange(n), np.arange(n)]
    return np.stack([np.interp(at, np.arange(n), diagonal[:, c]) for c in range(3)], axis=-1)


def write_sources(out: Path) -> None:
    """The licence and SOURCES.txt, for the cubes that lie in `out`."""
    licence = importlib.resources.files("spektrafilm") / "data" / "license" / "SPEKTRAFILM_LICENSE.txt"
    with importlib.resources.as_file(licence) as path:
        shutil.copyfile(path, out / "SPEKTRAFILM_LICENSE.txt")
    films, bw_films = (
        "\n".join(
            f"{film}.npy\n    {film} " + (f"printed on {stock}" if stock else "scanned as a slide")
            for film, stock in stocks.items()
            if (out / f"{film}.npy").is_file()
        )
        for stocks in (FILMS, BW_FILMS)
    )
    (out / "SOURCES.txt").write_text(
        _SOURCES.format(commit=COMMIT, films=films, bw_commit=BW_COMMIT, bw_films=bw_films)
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--only", help="comma-separated look ids (default: all)")
    parser.add_argument("--out", type=Path, default=_DEFAULT_OUT)
    parser.add_argument("--resolution", type=int, default=RESOLUTION)
    args = parser.parse_args()
    only = args.only.split(",") if args.only else list(FILMS)
    unknown = [f for f in only if f not in FILMS]
    if unknown:
        parser.error(f"unknown look: {', '.join(unknown)}")
    args.out.mkdir(parents=True, exist_ok=True)

    stops = np.array([-8.0, -4.0, -2.0, -1.0, 0.0, 1.0, 2.0, 3.0, 3.4, 4.0, 5.0, 6.0])
    print("grey ramp, display luma at stops over 18% grey (max channel spread)")
    print(f"{'':24s}" + "".join(f"{s:+7.1f}" for s in stops))
    for film in only:
        cube = _bake(film, FILMS[film], args.resolution)
        np.save(args.out / f"{film}.npy", cube.astype(np.float16))
        ramp = _grey_ramp(cube, stops)
        luma = ramp @ np.array([0.2126, 0.7152, 0.0722])
        spread = float((ramp.max(axis=1) - ramp.min(axis=1)).max())
        print(f"{film:24s}" + "".join(f"{v:7.3f}" for v in luma) + f"   ({spread:.3f})", flush=True)

    write_sources(args.out)


if __name__ == "__main__":
    main()

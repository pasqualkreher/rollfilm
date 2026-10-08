# /// script
# requires-python = "~=3.13"
# dependencies = [
#     "spectral_film_lut @ git+https://github.com/JanLohse/spectral_film_lut@b8d69398fc71038579c20473378be22103695dd5",
# ]
# ///
"""Bake the analog film looks spektrafilm has no profile for: one scene cube
per film stock, of the same kind as bake_analog.py's (F-Log2 / F-Gamut code
values in, display sRGB out, 65 points), rendered by spectral_film_lut - Jan
Lohse's simulation of a film, its print and its projection from the stocks'
datasheets (https://github.com/JanLohse/spectral_film_lut).

    uv run backend/tools/film_sim_fit/bake_spectral.py [--only id,id] [--out DIR]

Runs on its own, as bake_analog.py does: spectral_film_lut is a GUI program
with a stack the backend has no use for, so it is never imported by the app -
uv builds the environment from the header above, pinned to a commit, and only
its conversion function is called. Only the cubes ship (film_luts/spectral/
<id>.npy, float16, indexed [r][g][b]), with the program's licence, MIT, copied
next to them and SOURCES.txt naming the author.

A negative is printed - a still on its maker's paper, a cine negative on its
maker's print film - and an instant film is looked at as it is.

The cubes are levelled the way bake_analog.py's are, which here has to be done
on the result: the medium's black and white are put on the display's, a
channel each (a paper's black sits near 0.09 on the screen and its white is
tinted), and the exposure is moved until 18% grey is the middle grey the other
analog cubes show. The grey ramps are printed.

CineStill 800T is Kodak's Vision3 500T with the remjet layer taken off, sold
for C-41 development: here it is the Vision3 negative printed on paper, as a
C-41 film is, where the Vision3 looks print on cine print film. The program
has no ECN-2 / C-41 switch; the halation CineStill is known for is the
editor's Halation slider. CineStill 50D, made the same way from Vision3 50D,
rendered within 1.0 CIELAB of 800T on photographs (the paper takes out what
the two differ by) and is left out as a lookalike. The older Eastman cine
negatives print on the print film of their own years.

Colour is taken out of the scene below a two-hundredth of middle grey (the
chroma floor, _NEUTRAL_BELOW): what the sensor records there is noise, and
a saturated colour there - a cube node with red and no green or blue - is
one the simulation renders as a bright red that trilinear lookup would
otherwise pull into the greys next to it, so a grey ramp turns back in its
deepest black.

Not every stock the program has that the app lacks: Aerochrome III, an
infrared film, renders false colour from what a camera's three channels say
about the infrared, which is nothing - foliage comes out blue, not red; the
1950s stocks (5247, 5248, 5250, the 5381 print) are marked "unreliable data"
by the author, Technicolor "very experimental".
"""

from __future__ import annotations

import argparse
import importlib.metadata
from pathlib import Path

import numpy as np

import bake_analog as analog

COMMIT = "b8d69398fc71038579c20473378be22103695dd5"

_ENDURA = "Kodak Portra Endura Paper"
_CRYSTAL = "Fuji Crystal Archive DPII"
_ETERNA_CP = "Fuji Eterna-CP Type 3513DI"
_5383 = "Kodak 5383"
_5384 = "Kodak 5384"
_EXR_5386 = "Kodak EXR 5386"
_2383 = "Kodak Vision 2383"
# Look id -> the stock's name in spectral_film_lut and the print it is made on;
# None for a film that is its own positive.
FILMS: dict[str, tuple[str, str | None]] = {
    "kodak_vericolor_iii": ("Kodak Vericolor III", _ENDURA),
    "kodak_aerocolor_iv": ("Kodak Aerocolor IV 2460", _ENDURA),
    "fuji_pro_160s": ("Fuji Pro 160S", _CRYSTAL),
    "fuji_natura_1600": ("Fuji Natura 1600", _CRYSTAL),
    "fuji_eterna_500": ("Fuji Eterna 500", _ETERNA_CP),
    "fuji_eterna_500_vivid": ("Fuji Eterna 500 Vivid", _ETERNA_CP),
    "fuji_instax_color": ("Fuji Instax color", None),
    "cinestill_800t": ("Kodak Vision3 500T 5219", _ENDURA),
    "kodak_5247_ii": ("Kodak 5247 II", _5383),
    "kodak_exr_200t_5293": ("Kodak EXR 200T 5293", _5384),
    "kodak_exr_100t_5248": ("Kodak EXR 100T 5248", _EXR_5386),
    "kodak_vision_320t_5277": ("Kodak Vision 320T 5277", _2383),
}
# The negative the program balances its intermediate encoding on (its GUI's).
_REFERENCE = "Kodak Vision3 250D 5207"
# Display luma of 18% grey in the analog cubes (bake_analog.py's grey ramps).
_MIDDLE_GREY = 0.45
# Scene luminance (18% grey = 0.18) under which colour fades out to grey.
_NEUTRAL_BELOW = 0.18 / 200
# Stops over 18% grey the medium's white is read at. The seven cubes baked
# before 2026-10-08 read it at F-Log2 code 1.0 (half a stop higher) and at
# exposure compensation 0, and had no chroma floor; rebaking them with this
# would move their top end by under 2%.
_WHITE_STOPS = 6.0

_DEFAULT_OUT = Path(__file__).resolve().parents[2] / "app" / "services" / "film_luts" / "spectral"

_LUMA = np.array([0.2126, 0.7152, 0.0722])

_SOURCES = """Scene cubes for more analog film looks (F-Log2 / F-Gamut code values in,
display sRGB out), baked by backend/tools/film_sim_fit/bake_spectral.py.

Derived from spectral_film_lut by Jan Lohse
https://github.com/JanLohse/spectral_film_lut (commit {commit})
Licensed MIT - copyright and permission notice in SPECTRAL_FILM_LUT_LICENSE.txt,
next to this file.
Modified by Pasqual Kreher: the stocks are rendered into 3D LUTs for Rollfilm,
each negative on the print named below, and levelled - the medium's black and
white on the display's, 18% grey on middle grey.

{films}

The trademarked names are there to say which film stock a cube is made to
approximate. Neither the author nor Rollfilm are affiliated with or endorsed
by the companies that own them.

Removing a file takes its look out of the scene path.
"""


def _flog2_inverse(code: np.ndarray) -> np.ndarray:
    """Scene reflectance of F-Log2 code values (the inverse of analog._flog2)."""
    return np.where(
        code >= 0.100686685370811,
        (10.0 ** ((code - 0.384316) / 0.245281) - 0.064829) / 5.555556,
        (code - 0.092864) / 8.799461,
    )


def _srgb_decode(code: np.ndarray) -> np.ndarray:
    return np.where(code <= 0.04045, code / 12.92, ((code + 0.055) / 1.055) ** 2.4)


def _srgb_encode(lin: np.ndarray) -> np.ndarray:
    lin = np.clip(lin, 0.0, 1.0)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)


def _neutral_black(reflectance: np.ndarray) -> np.ndarray:
    """The scene with its colour faded to grey below _NEUTRAL_BELOW (none at
    all at black, all of it from the floor up, smoothly in between)."""
    luma = reflectance @ _LUMA
    keep = np.clip(luma / _NEUTRAL_BELOW, 0.0, 1.0)
    keep = keep * keep * (3.0 - 2.0 * keep)
    return luma[..., None] + (reflectance - luma[..., None]) * keep[..., None]


def _bake(stocks: dict, film: str, print_stock: str | None, resolution: int) -> tuple[np.ndarray, float]:
    """The levelled cube of `film`, and the exposure compensation (in stops)
    that puts 18% grey on middle grey."""
    import colour
    from spectral_film_lut.utils import film_conversion

    def render(xyz: np.ndarray, exp_comp: float) -> np.ndarray:
        # The GUI's settings for a LUT, with XYZ in (it knows F-Gamut only
        # with F-Log, not F-Log2) and sRGB out.
        code = film_conversion(
            xyz.copy(), stocks[film], stocks[print_stock] if print_stock else None,
            input_colorspace=None, output_gamut="Rec. 709", gamma_func="sRGB",
            color_masking=1.0, apd_intermediate=True, reference_negative=stocks[_REFERENCE],
            upsampling_method="SFL upsampling", exp_comp=exp_comp,
        )
        return _srgb_decode(np.asarray(code, dtype=np.float64))

    def xyz_of(reflectance: np.ndarray) -> np.ndarray:
        return colour.RGB_to_XYZ(reflectance, "ITU-R BT.2020", apply_cctf_decoding=False)

    # The medium's black and white, a channel each: what no light leaves on
    # it, and what six stops over 18% grey leave - where a sensor has long
    # clipped, and as far as a long cine-print shoulder (Vision 320T on 2383)
    # is read. The white is taken at the exposure the look ends up with.
    black = render(xyz_of(np.zeros((1, 1, 3))), 0.0)[0, 0]
    top = xyz_of(np.full((1, 1, 3), 0.18 * 2.0 ** _WHITE_STOPS))

    def level(lin: np.ndarray, white: np.ndarray) -> np.ndarray:
        return np.clip((lin - black) / (white - black), 0.0, 1.0)

    grey = xyz_of(np.full((1, 1, 3), 0.18))
    low, high = -4.0, 4.0
    for _ in range(24):
        exp_comp = (low + high) / 2
        white = render(top, exp_comp)[0, 0]
        shown = float(_srgb_encode(level(render(grey, exp_comp), white))[0, 0] @ _LUMA)
        low, high = (exp_comp, high) if shown < _MIDDLE_GREY else (low, exp_comp)
    exp_comp = (low + high) / 2
    white = render(top, exp_comp)[0, 0]

    axis = np.linspace(0.0, 1.0, resolution)
    grid = np.stack(np.meshgrid(axis, axis, axis, indexing="ij"), axis=-1)
    cube = _srgb_encode(level(render(xyz_of(_neutral_black(np.clip(_flog2_inverse(grid), 0.0, None))), exp_comp), white))
    return np.ascontiguousarray(cube, dtype=np.float32), exp_comp


def write_sources(out: Path) -> None:
    """The licence and SOURCES.txt, for the cubes that lie in `out`."""
    licence = importlib.metadata.distribution("spectral_film_lut").read_text("licenses/LICENSE")
    (out / "SPECTRAL_FILM_LUT_LICENSE.txt").write_text(licence, encoding="utf-8")
    films = "\n".join(
        f"{look}.npy\n    {film} " + (f"printed on {stock}" if stock else "as its own positive")
        for look, (film, stock) in FILMS.items()
        if (out / f"{look}.npy").is_file()
    )
    (out / "SOURCES.txt").write_text(_SOURCES.format(commit=COMMIT, films=films), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--only", help="comma-separated look ids (default: all)")
    parser.add_argument("--out", type=Path, default=_DEFAULT_OUT)
    parser.add_argument("--resolution", type=int, default=analog.RESOLUTION)
    args = parser.parse_args()
    only = args.only.split(",") if args.only else list(FILMS)
    unknown = [f for f in only if f not in FILMS]
    if unknown:
        parser.error(f"unknown look: {', '.join(unknown)}")
    args.out.mkdir(parents=True, exist_ok=True)

    from spectral_film_lut.film_loader import load_filmstocks

    stocks = load_filmstocks(lambda *_: None)
    stops = np.array([-8.0, -4.0, -2.0, -1.0, 0.0, 1.0, 2.0, 3.0, 3.4, 4.0, 5.0, 6.0])
    print("grey ramp, display luma at stops over 18% grey (max channel spread, exposure compensation)")
    print(f"{'':24s}" + "".join(f"{s:+7.1f}" for s in stops))
    for look in only:
        cube, exp_comp = _bake(stocks, *FILMS[look], args.resolution)
        np.save(args.out / f"{look}.npy", cube.astype(np.float16))
        ramp = analog._grey_ramp(cube, stops)
        luma = ramp @ _LUMA
        spread = float((ramp.max(axis=1) - ramp.min(axis=1)).max())
        print(
            f"{look:24s}" + "".join(f"{v:7.3f}" for v in luma) + f"   ({spread:.3f}, {exp_comp:+.2f})",
            flush=True,
        )

    write_sources(args.out)


if __name__ == "__main__":
    main()

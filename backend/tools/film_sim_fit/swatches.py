"""The picker's swatches for the film looks: what each look's cube makes of
a sky blue and of a warm tone (Provia's swatch colours), the shift from the
unaltered colour doubled in Oklab so that it reads on a 16px disc, chroma
pulled in until the colour is in gamut; for a black & white look a dark and a
light grey as the cube renders them. Prints the frontend's `swatch` strings
(FILM_SIMS in frontend/src/utils/adjustments.ts).

    python -m tools.film_sim_fit.swatches [sim ...]       (default: every film look)

The swatches that stand in the frontend from before 2026-10-08 were made the
same way by hand; this reproduces them to within a few 8-bit steps in one
channel, so they are left as they are.
"""

from __future__ import annotations

import sys

import numpy as np

from app.services import film_sims
from app.services.develop_v2 import _linear_to_srgb, _srgb_to_linear, linear_to_oklab, oklab_to_linear

COLOUR = ("#4a7bc8", "#d8a05a")
GREY = ("#2b2b2b", "#d6d6d6")
DOUBLE = 2.0
STEP = 0.025


def _rgb(code: str) -> np.ndarray:
    return np.array([int(code[i : i + 2], 16) / 255.0 for i in (1, 3, 5)], dtype=np.float32)


def _hex(rgb: np.ndarray) -> str:
    return "#" + "".join(f"{int(round(float(v) * 255)):02x}" for v in np.clip(rgb, 0.0, 1.0))


def _in_gamut(lab: np.ndarray) -> np.ndarray:
    """Scale a and b down in steps until linear sRGB lies within 0..1."""
    for scale in np.arange(1.0, -STEP / 2, -STEP):
        lin = oklab_to_linear(np.array([lab[0], lab[1] * scale, lab[2] * scale]).reshape(1, 1, 3))[0, 0]
        if np.all(lin >= 0.0) and np.all(lin <= 1.0):
            return lin
    return oklab_to_linear(np.array([lab[0], 0.0, 0.0]).reshape(1, 1, 3))[0, 0]


def swatch(sim: str) -> str:
    cube = film_sims._sim_cube(sim)
    if cube is None:
        raise SystemExit(f"{sim}: no cube")
    grey = bool((cube.max(axis=-1) - cube.min(axis=-1)).max() < 2.0 / 255.0)
    halves = []
    for code in GREY if grey else COLOUR:
        src = _rgb(code)
        out = film_sims._sample_cube(src.reshape(1, 1, 3), cube)[0, 0]
        if grey:
            halves.append(_hex(out))
            continue
        lab_in = linear_to_oklab(_srgb_to_linear(src).reshape(1, 1, 3))[0, 0]
        lab_out = linear_to_oklab(_srgb_to_linear(out).reshape(1, 1, 3))[0, 0]
        lab = lab_in + DOUBLE * (lab_out - lab_in)
        halves.append(_hex(_linear_to_srgb(_in_gamut(lab))))
    return f"linear-gradient(135deg, {halves[0]} 50%, {halves[1]} 50%)"


def main() -> None:
    sims = sys.argv[1:] or list(film_sims.ANALOG_SIMS + film_sims.CLUT_SIMS)
    for sim in sims:
        print(f'{sim}: swatch: "{swatch(sim)}"')


if __name__ == "__main__":
    main()

# /// script
# requires-python = "~=3.13"
# dependencies = [
#     "spektrafilm @ git+https://github.com/andreavolpato/spektrafilm@6cd00c8d4f30b5b550f50f4bbd3753c9f2a48507",
# ]
# ///
"""Bake the black & white analog film look: Kodak Double-X, printed on Kodak's
black & white print film 2302, as a scene cube of the same kind as the colour
stocks' (see bake_analog.py, whose pipeline and grey ramp this runs).

    uv run backend/tools/film_sim_fit/bake_analog_bw.py [--out DIR]

On its own because spektrafilm has its black & white profiles on the dev branch
only: the header above pins that commit, and the colour cubes stay the ones of
the release bake_analog.py pins. The simulation renders the print neutral to
the third decimal; the cube is made exactly grey, as the black & white film
scans are on import.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

import bake_analog as colour


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=colour._DEFAULT_OUT)
    parser.add_argument("--resolution", type=int, default=colour.RESOLUTION)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    stops = np.array([-8.0, -4.0, -2.0, -1.0, 0.0, 1.0, 2.0, 3.0, 3.4, 4.0, 5.0, 6.0])
    luma = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    print("grey ramp, display luma at stops over 18% grey (max channel spread before it is made grey)")
    print(f"{'':24s}" + "".join(f"{s:+7.1f}" for s in stops))
    for film, print_stock in colour.BW_FILMS.items():
        cube = colour._bake(film, print_stock, args.resolution)
        spread = float(np.ptp(cube, axis=-1).max())
        cube = np.repeat((cube @ luma)[..., None], 3, axis=-1)
        np.save(args.out / f"{film}.npy", cube.astype(np.float16))
        ramp = colour._grey_ramp(cube, stops)[:, 0]
        print(f"{film:24s}" + "".join(f"{v:7.3f}" for v in ramp) + f"   ({spread:.3f})", flush=True)
    colour.write_sources(args.out)


if __name__ == "__main__":
    main()

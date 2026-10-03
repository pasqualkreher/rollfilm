"""Fujifilm's own film simulation cubes, as the app ships them.

Fujifilm publishes 3D LUTs that turn F-Log2 / F-Gamut footage into its film
simulations (fujifilm-x.com/global/support/download/lut; only the GFX ETERNA 55
pack carries all ten looks, the camera packs stop at ETERNA / Bleach Bypass).
This copies the 65-grid F-Log2 cubes into film_luts/official/<sim>.npy, values
untouched: F-Log2 code values in, BT.709 code values out, indexed [r][g][b][3].
film_sims.apply_official feeds them the app's scene-linear picture encoded as
F-Log2, so the simulation renders where Fujifilm defined it - before any tone
curve of this app's own.

    python -m tools.film_sim_fit.import_official <dir with FLog2_to_*_65grid_*.cube>

Fujifilm offers the cubes as a free download and states no terms of use; the
files written here are plain copies of that data in another container.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

from app.services import film_sims
from tools.film_sim_fit.official import OFFICIAL, read_cube


def main() -> None:
    src = Path(sys.argv[1])
    out = film_sims._OFFICIAL_DIR
    out.mkdir(parents=True, exist_ok=True)
    for sim in sorted(film_sims.OFFICIAL_SIMS):
        (path,) = sorted(src.glob(f"FLog2_to_{OFFICIAL[sim]}_65grid_*.cube"))
        flat = read_cube(path).numpy()
        n = round(len(flat) ** (1 / 3))
        cube = np.clip(flat.reshape(n, n, n, 3), 0.0, 1.0)
        if sim in ("acros",):
            # Monochrome by definition; the file carries equal channels already
            # up to rounding, so make it exactly grey.
            cube = np.repeat(cube.mean(axis=-1, keepdims=True), 3, axis=-1)
        np.save(out / f"{sim}.npy", cube.astype(np.float16))
        print(f"{sim:22} <- {path.name}  grid {n}")


if __name__ == "__main__":
    main()

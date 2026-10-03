"""Step 3: look at it. For each RAF, one strip of four pictures:

    no simulation | process 3 | process 4 | the camera's JPEG

all rendered by the app's own pipeline at the exposure the app opens the photo
with (its auto exposure), so the strip shows what the editor shows. Process 3
is Fujifilm's video cube as it stands, process 4 the same look rendered as a
still (film_sims: anchor and stills shoulder). The camera's JPEG carries the
recipe the photo was shot with (tone, colour, colour chrome) on top of the
simulation; the cube is the simulation alone, so the two agree in brightness
and character, not to the last digit.

    python -m tools.film_sim_fit.compare <out.jpg> <file.RAF> [<file.RAF> ...]
"""

from __future__ import annotations

import io
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import rawpy
from PIL import Image, ImageOps

from app.services import develop, raw as raw_service, thumbnails
from tools.film_sim_fit.extract import FILM_MODE, MONO

WIDTH = 520


def _sim_of(path: Path) -> str:
    out = subprocess.run(
        ["exiftool", "-n", "-s3", "-FilmMode", "-Saturation", str(path)], capture_output=True, text=True
    ).stdout.split()
    if len(out) == 2:
        return FILM_MODE.get(int(float(out[0])), "provia")
    return MONO.get(int(float(out[0])), "acros") if out else "provia"


def _render(lin: np.ndarray, gain: float, sim: str, process: str) -> np.ndarray:
    adj = develop.normalize({"film_sim": sim, "process": process, "raw_base": "standard"})
    img = thumbnails.apply_adjustments_linear(lin, gain, adj, include_grain=False, raw_source=True)
    return np.asarray(img)


def strip(path: Path):
    lin, gain = raw_service.load_linear_base(path, half_size=True)
    h = round(lin.shape[0] * WIDTH / lin.shape[1])
    lin = cv2.resize(lin, (WIDTH, h), interpolation=cv2.INTER_AREA)
    with rawpy.imread(str(path)) as raw:
        jpeg = bytes(raw.extract_thumb().data)
    im = Image.open(io.BytesIO(jpeg))
    im.draft("RGB", (WIDTH * 2, WIDTH * 2))
    cam = np.asarray(ImageOps.exif_transpose(im).convert("RGB").resize((WIDTH, h), Image.LANCZOS))
    sim = _sim_of(path)
    tiles = [_render(lin, gain, "none", "4"), _render(lin, gain, sim, "3"), _render(lin, gain, sim, "4"), cam]
    for tile, label in zip(tiles, ("no simulation", f"process 3: {sim}", f"process 4: {sim}", "camera JPEG")):
        tile = tile.copy()
        cv2.putText(tile, label, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(tile, label, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
        yield tile


def main() -> None:
    out, files = Path(sys.argv[1]), [Path(p) for p in sys.argv[2:]]
    rows = [np.concatenate(list(strip(p)), axis=1) for p in files]
    width = max(r.shape[1] for r in rows)
    rows = [np.pad(r, ((0, 0), (0, width - r.shape[1]), (0, 0))) for r in rows]
    Image.fromarray(np.concatenate(rows, axis=0)).save(out, quality=90)
    print(out)


if __name__ == "__main__":
    main()

"""Colour matrices for cameras LibRaw does not know yet.

LibRaw turns a camera's own channels into sRGB with a per-model matrix from its
built-in table. For a model that is newer than the library there is no entry:
the picture then comes out in the sensor's native channels, taken as sRGB as
they stand - flat, with every colour pulled toward grey - and anything layered
on top (film simulations above all) starts from the wrong base.

Such a camera almost always shares its sensor with a model LibRaw does know,
and the matrix describes the sensor (its colour filters), not the body. So the
missing model borrows its sibling's: the same numbers LibRaw would use, applied
the way LibRaw applies them (dcraw's cam_xyz_coeff: sRGB->camera with each row
scaled to sum to 1, so white stays white, inverted).
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import numpy as np

# XYZ->camera, x10000, as in LibRaw's table (the Adobe DNG ColorMatrix for
# D65), keyed by the model name the file carries.
_BORROWED: dict[str, tuple[int, ...]] = {
    # X-Trans CMOS 5 HR (40MP): LibRaw 0.22 lists it for the X-H2, X-T5 and
    # X-T50, all with these numbers; the X-E5 has the same sensor.
    "X-E5": (11809, -5358, -1141, -4248, 12164, 2343, -514, 1097, 5848),
}

# Linear sRGB -> XYZ (D65), the constants dcraw and LibRaw use.
_XYZ_FROM_SRGB = np.array(
    [[0.412453, 0.357580, 0.180423], [0.212671, 0.715160, 0.072169], [0.019334, 0.119193, 0.950227]]
)


def raf_model(path: Path) -> str | None:
    """The model name in a Fuji RAF's header (32 bytes at offset 28), without
    decoding anything; None for any other file."""
    try:
        with open(path, "rb") as f:
            head = f.read(60)
    except OSError:
        return None
    if not head.startswith(b"FUJIFILMCCD-RAW"):
        return None
    return head[28:60].split(b"\0", 1)[0].decode("ascii", "replace").strip() or None


@lru_cache(maxsize=None)
def _to_srgb(model: str) -> np.ndarray | None:
    xyz_cam = _BORROWED.get(model)
    if xyz_cam is None:
        return None
    srgb_cam = (np.array(xyz_cam, dtype=np.float64).reshape(3, 3) / 10000.0) @ _XYZ_FROM_SRGB
    srgb_cam /= srgb_cam.sum(axis=1, keepdims=True)
    return np.linalg.inv(srgb_cam)


def borrowed_xyz_to_camera(path: Path) -> np.ndarray | None:
    """XYZ->camera for a file whose model borrows its matrix, else None."""
    xyz_cam = _BORROWED.get(raf_model(path) or "")
    return None if xyz_cam is None else np.array(xyz_cam, dtype=np.float64).reshape(3, 3) / 10000.0


def missing_matrix(path: Path | None, libraw_has_one: bool) -> np.ndarray | None:
    """The camera->sRGB matrix (3x3, rows sum to 1) the decode has to apply
    itself: LibRaw has none for this file's model and a sibling's is known.
    None when LibRaw did the conversion, or nothing is known either way."""
    if libraw_has_one or path is None:
        return None
    return _to_srgb(raf_model(path) or "")


def apply(lin: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    """Camera channels -> linear sRGB, in place, in bands of rows (a 40MP
    frame's worth of temporaries would otherwise be another half gigabyte).
    Clipped to 0..1 like LibRaw's own conversion."""
    m = matrix.T.astype(np.float32)
    for y0 in range(0, lin.shape[0], 512):
        band = lin[y0 : y0 + 512]
        np.clip(band @ m, 0.0, 1.0, out=band)
    return lin

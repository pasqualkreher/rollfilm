"""A mask must land in the same place whether the frame is rasterised whole or
in a tile.

The editor renders only the visible viewport at native resolution (that is the
whole point - a 40MP render per slider release is seconds of CPU for pixels
nobody can see), so every spatial field has to be computable for a sub-rectangle
without moving. These tests are the guarantee: tile == the same crop of the
whole field, pixel for pixel.
"""

import numpy as np
import pytest

from app.services import masks
from app.services.masks import FieldView

H, W = 160, 240
# Tiles at the corners, in the middle, and one taller than it is wide - the
# offsets are what a wrong normalisation gets wrong.
TILES = [(0, 0, 40, 60), (100, 20, 50, 80), (180, 90, 60, 70), (60, 40, 30, 100)]


def _whole_and_tile(compute, x0, y0, w, h):
    whole = compute(H, W, FieldView.whole(H, W))
    tile = compute(h, w, FieldView(x0, y0, W, H))
    return whole[y0 : y0 + h, x0 : x0 + w], tile


@pytest.mark.parametrize("x0,y0,w,h", TILES)
def test_radial_tile_matches_the_whole_field(x0, y0, w, h):
    p = {"center_x": 0.42, "center_y": 0.55, "radius_x": 0.3, "radius_y": 0.2,
         "rotation": 20.0, "feather": 40}
    expected, tile = _whole_and_tile(
        lambda hh, ww, v: masks._radial_field(hh, ww, p, v), x0, y0, w, h
    )
    assert np.allclose(expected, tile, atol=1e-6)


@pytest.mark.parametrize("x0,y0,w,h", TILES)
def test_linear_tile_matches_the_whole_field(x0, y0, w, h):
    p = {"start_x": 0.2, "start_y": 0.1, "end_x": 0.8, "end_y": 0.9}
    expected, tile = _whole_and_tile(
        lambda hh, ww, v: masks._linear_field(hh, ww, p, v), x0, y0, w, h
    )
    assert np.allclose(expected, tile, atol=1e-6)


@pytest.mark.parametrize("x0,y0,w,h", TILES)
def test_brush_tile_matches_the_whole_field(x0, y0, w, h):
    strokes = [
        [0.15, 0.2, 0.06, 1], [0.35, 0.35, 0.06, 0], [0.55, 0.5, 0.06, 0],
        [0.75, 0.7, 0.06, 0], [0.9, 0.85, 0.06, 0],
    ]
    p = {"strokes": strokes, "feather": 45, "flow": 80, "density": 100}
    expected, tile = _whole_and_tile(
        lambda hh, ww, v: masks._brush_field(hh, ww, p, v), x0, y0, w, h
    )
    assert np.allclose(expected, tile, atol=1e-6)


@pytest.mark.parametrize("x0,y0,w,h", TILES)
def test_a_combined_mask_tiles_the_same_way(x0, y0, w, h):
    """The container, not just one shape: base plus an intersected limit, which
    is the shape a "confine this selection to an area" mask has."""
    mask = {
        "sub_masks": [
            {"type": "radial", "mode": "additive", "visible": True,
             "parameters": {"center_x": 0.5, "center_y": 0.5, "radius_x": 0.45,
                            "radius_y": 0.35, "feather": 30}},
            {"type": "linear", "mode": "intersect", "visible": True,
             "parameters": {"start_x": 0.1, "start_y": 0.0, "end_x": 0.9, "end_y": 1.0}},
        ]
    }
    arr_whole = np.zeros((H, W, 3), dtype=np.float32)
    arr_tile = np.zeros((h, w, 3), dtype=np.float32)

    whole = masks.generate_mask_field(mask, arr_whole, FieldView.whole(H, W))
    tile = masks.generate_mask_field(mask, arr_tile, FieldView(x0, y0, W, H))

    assert np.allclose(whole[y0 : y0 + h, x0 : x0 + w], tile, atol=1e-6)


def test_the_whole_frame_is_still_the_default():
    """Every caller that does not zoom passes no view at all and must be
    unaffected - this is what keeps thumbnails, exports and the un-zoomed
    preview on exactly the pixels they produced before."""
    p = {"center_x": 0.5, "center_y": 0.5, "radius_x": 0.3, "radius_y": 0.3}
    assert np.array_equal(
        masks._radial_field(H, W, p), masks._radial_field(H, W, p, FieldView.whole(H, W))
    )

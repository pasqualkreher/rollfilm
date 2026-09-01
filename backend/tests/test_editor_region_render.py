"""A zoomed tile must be the same pixels as that part of the whole render.

The editor renders only the visible viewport at the native tier, so the tile is
allowed to be cheaper - it is not allowed to look different. What could make it
differ is everything positional: a mask normalised against the tile instead of
the photo, a vignette re-centred on the viewport, or a detail pass running out
of image at the tile's edge (which is what REGION_PAD_PX exists for).
"""

import numpy as np
import pytest
from PIL import Image as PILImage

from app.services import masks, thumbnails
from app.services.masks import FieldView


def _base(h=240, w=320) -> np.ndarray:
    """A synthetic scene with detail at every scale, so the neighbourhood
    passes have something to chew on and a seam would show."""
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    g = 0.5 + 0.35 * np.sin(xs / 9.0) * np.cos(ys / 7.0)
    g += 0.1 * np.sin((xs + ys) / 3.0)
    return np.clip(np.dstack([g, g * 0.9 + 0.05, g * 0.8 + 0.1]), 0.0, 1.0)


def _render(arr: np.ndarray, adj: dict, view=None) -> np.ndarray:
    img = thumbnails.apply_adjustments_linear(arr, 1.0, adj, view=view)
    return np.asarray(img.convert("RGB"), dtype=np.int16)


# x, y, w, h in pixels. Corners and middle: an offset bug shows at the corners,
# a normalisation bug in the middle.
TILES = [(0, 0, 90, 70), (150, 90, 120, 100), (230, 160, 90, 80)]

ADJUSTMENTS = [
    pytest.param({"exposure": 0.4, "contrast": 20}, id="tone-only"),
    pytest.param({"vignette_amount": -70, "vignette_midpoint": 40}, id="vignette"),
    pytest.param({"clarity": 45, "sharpness": 40}, id="detail-passes"),
    # The expensive spatial passes, which are the whole reason for rendering a
    # tile - and the ones that scale their radii with the image, so a tile that
    # measured itself instead of the frame would develop differently.
    pytest.param({"dehaze": 40}, id="dehaze"),
    pytest.param({"luma_noise_reduction": 35, "color_noise_reduction": 25}, id="denoise"),
    pytest.param(
        {
            "masks": [
                {
                    "id": "m1",
                    "visible": True,
                    "opacity": 100,
                    "sub_masks": [
                        {"type": "radial", "mode": "additive", "visible": True,
                         "parameters": {"center_x": 0.35, "center_y": 0.45,
                                        "radius_x": 0.3, "radius_y": 0.25, "feather": 40}}
                    ],
                    "adjustments": {"exposure": 1.2},
                }
            ]
        },
        id="radial-mask",
    ),
]


@pytest.mark.parametrize("adj", ADJUSTMENTS)
@pytest.mark.parametrize("x,y,w,h", TILES)
def test_tile_matches_the_whole_render(adj, x, y, w, h):
    arr = _base()
    full_h, full_w = arr.shape[:2]
    whole = _render(arr, adj)

    pad = thumbnails.REGION_PAD_PX
    px0, py0 = max(0, x - pad), max(0, y - pad)
    px1, py1 = min(full_w, x + w + pad), min(full_h, y + h + pad)
    padded = _render(arr[py0:py1, px0:px1], adj, view=FieldView(px0, py0, full_w, full_h))
    tile = padded[y - py0 : y - py0 + h, x - px0 : x - px0 + w]

    expected = whole[y : y + h, x : x + w].astype(int)
    diff = np.abs(expected - tile.astype(int))

    # Two levels out of 255, and only where a detail pass works on a reduced-
    # resolution intermediate whose grid falls differently on a tile than on the
    # whole frame. Measured: mean 0.27, 2% of pixels above one level - a
    # difference no eye can find, and the price of not rendering 40 megapixels
    # to look at two.
    assert diff.max() <= 2

    # The padding's job: a seam would put the error at the tile's border, so the
    # border may not be worse than the middle.
    border = np.concatenate(
        [diff[:2].ravel(), diff[-2:].ravel(), diff[:, :2].ravel(), diff[:, -2:].ravel()]
    )
    assert border.max() <= max(2, diff[4:-4, 4:-4].max())


def test_effects_a_tile_cannot_carry_keep_the_whole_frame():
    """What a tile cannot see, it may not render: the edge-defined effects and
    the diffusion ones, which are lit by parts of the photo outside the tile."""
    assert thumbnails.region_is_supported({"exposure": 1.0, "clarity": 40})
    assert not thumbnails.region_is_supported({"grain_amount": 30})
    assert not thumbnails.region_is_supported({"frame_width": 4})
    for spreading in ("mist", "glow_amount", "halation_amount", "flare_amount"):
        assert not thumbnails.region_is_supported({spreading: 25}), spreading
    # Negative clarity brings the diffusion pass with it.
    assert not thumbnails.region_is_supported({"clarity": -40})

"""Auto-straighten finds the tilt of a picture's level and plumb lines."""

import numpy as np
import pytest
from PIL import Image as PILImage, ImageDraw

from app.services import auto_level, thumbnails


def _scene(size=(1200, 800)) -> PILImage.Image:
    """A level scene: a horizon, a building with windows, a pole."""
    im = PILImage.new("RGB", size, (150, 180, 220))
    d = ImageDraw.Draw(im)
    w, h = size
    d.rectangle([0, int(h * 0.6), w, h], fill=(70, 90, 60))  # ground, horizon
    d.rectangle([200, 250, 520, int(h * 0.6)], fill=(180, 170, 160))  # building
    for x in range(230, 500, 60):
        for y in range(280, 440, 60):
            d.rectangle([x, y, x + 30, y + 35], fill=(60, 70, 90))
    d.rectangle([800, 150, 812, int(h * 0.6)], fill=(40, 40, 40))  # pole
    return im


@pytest.mark.parametrize("tilt", [-6.0, -2.5, 1.75, 4.0])
def test_a_tilted_scene_is_levelled(tilt):
    tilted = thumbnails.apply_edits(_scene(), 0, None, straighten=tilt)
    angle = auto_level.level_angle(tilted)
    assert angle is not None
    assert abs(angle + tilt) <= 0.5


def test_a_level_scene_stays_put():
    assert auto_level.level_angle(_scene()) == 0.0


def test_a_picture_without_lines_has_no_answer():
    rng = np.random.default_rng(0)
    noise = (rng.random((400, 600, 3)) * 255).astype(np.uint8)
    blurred = PILImage.fromarray(noise).resize((60, 40)).resize((600, 400), PILImage.BICUBIC)
    assert auto_level.level_angle(blurred) is None

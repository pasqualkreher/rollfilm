"""small.jpg, the downscaled tier the dense grid sizes (XS/S) request.

A grid tile is decoded at whatever size the file happens to be, not at the size
it is shown, so serving the full 1600px thumbnail to a 130px tile costs real
decode time and several times the renderer memory. Past the renderer's
decoded-image budget Chromium starts dropping decoded tiles and they paint as
empty cards - which is the failure this tier exists to keep away from.

The tier is written by generate_derivatives, but must also be derivable on
demand: libraries predating it, and photos whose derivatives were moved into
place by an import commit or a library merge, only have thumbnail.jpg.
"""

from pathlib import Path

import pytest
from PIL import Image as PILImage

from app.config import settings
from app.services import thumbnails
from app.services.thumbnails import (
    SMALL_MAX_PX,
    THUMBNAIL_MAX_PX,
    derivative_dir,
    ensure_small,
)


class _Image:
    """Only what the tier derivation touches: the id it caches under."""

    def __init__(self, image_id: str) -> None:
        self.id = image_id


@pytest.fixture()
def cache(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "thumbnail_cache_root", tmp_path / "thumbs")
    return tmp_path / "thumbs"


def _thumbnail(image_id: str, size=(1600, 1067)) -> Path:
    path = derivative_dir(image_id) / "thumbnail.jpg"
    PILImage.new("RGB", size, "blue").save(path, "JPEG")
    return path


def test_the_tier_is_derived_from_an_existing_thumbnail(cache):
    """The on-demand path an old library takes: no render, just a downscale."""
    _thumbnail("image-1")

    dest = ensure_small(_Image("image-1"))

    assert dest == cache / "image-1" / "small.jpg"
    with PILImage.open(dest) as tier:
        assert max(tier.size) == SMALL_MAX_PX
        # Aspect ratio preserved (to within the rounding of a whole pixel) - the
        # grid sizes its tiles from the DB's dimensions, so a tier that had been
        # squared off would sit letterboxed in its card.
        assert tier.size[0] / tier.size[1] == pytest.approx(1600 / 1067, abs=0.002)


def test_the_tier_is_meaningfully_smaller_than_the_thumbnail(cache):
    """The whole point is fewer pixels to decode. If the two ever collapsed onto
    one size, the tier would be pure overhead."""
    _thumbnail("image-2")

    with PILImage.open(ensure_small(_Image("image-2"))) as small:
        small_pixels = small.size[0] * small.size[1]
    with PILImage.open(derivative_dir("image-2") / "thumbnail.jpg") as full:
        full_pixels = full.size[0] * full.size[1]

    assert SMALL_MAX_PX < THUMBNAIL_MAX_PX
    # Roughly a sixth of the decode area at the shipped caps.
    assert small_pixels * 4 < full_pixels


def test_an_existing_tier_is_served_untouched(cache):
    """Deriving is cheap but not free, and it must never happen on a hit - this
    runs on the serve path of every tile in the grid."""
    _thumbnail("image-3")
    dest = ensure_small(_Image("image-3"))
    dest.write_bytes(b"sentinel")

    assert ensure_small(_Image("image-3")) == dest
    assert dest.read_bytes() == b"sentinel"


def test_a_small_thumbnail_is_not_upscaled(cache):
    """A photo whose thumbnail is already under the cap keeps its own pixels.
    Blowing it up would cost bytes and decode time to add nothing."""
    _thumbnail("image-4", size=(500, 400))

    with PILImage.open(ensure_small(_Image("image-4"))) as tier:
        assert tier.size == (500, 400)


def test_a_photo_with_no_thumbnail_falls_back_to_a_render(cache, monkeypatch):
    """Nothing to downscale: the tier can only come from the full on-demand
    render, which writes every tier itself."""
    rendered: list[str] = []

    def fake_regenerate(image, slot_timeout=None):
        rendered.append(image.id)
        _thumbnail(image.id, size=(1600, 1067))

    monkeypatch.setattr(thumbnails, "regenerate_for_image", fake_regenerate)

    with PILImage.open(ensure_small(_Image("image-5"))) as tier:
        assert max(tier.size) == SMALL_MAX_PX
    assert rendered == ["image-5"]

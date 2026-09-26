"""The 100%-zoom full.jpg takes the short way for a photo without edits.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

from datetime import datetime

import numpy as np
import pytest
from PIL import Image as PILImage

from app.db.models import FileType, Image
from app.services import thumbnails


@pytest.fixture()
def photo(tmp_path, monkeypatch):
    path = tmp_path / "shot.jpg"
    ys, xs = np.mgrid[0:300, 0:400].astype(np.float32)
    g = 0.5 + 0.3 * np.sin(xs / 11.0) * np.cos(ys / 9.0)
    rgb = np.dstack([g, g * 0.92 + 0.04, g * 0.85 + 0.08])
    PILImage.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), "RGB").save(path, "JPEG", quality=95)
    image = Image(
        id="full-fast", owner_id=1, file_path=str(path), original_filename="shot.jpg",
        file_hash="hash", file_type=FileType.jpeg, file_size=path.stat().st_size,
        taken_at=datetime(2026, 9, 26, 12, 0, 0), width=400, height=300,
    )
    monkeypatch.setattr("app.services.filesystem.resolve_image_path", lambda img: path)
    monkeypatch.setattr(thumbnails.settings, "thumbnail_cache_root", tmp_path / "thumbs")
    thumbnails.clear_editor_base_caches()
    return image


def test_a_fresh_photo_counts_as_untouched(photo):
    assert thumbnails.is_untouched(photo)
    photo.edit_rotation = 90
    assert not thumbnails.is_untouched(photo)


def test_the_untouched_render_matches_the_pipeline(photo):
    """The short path must be the same picture the full pipeline produces for
    neutral edits - it replaces it, it doesn't approximate it."""
    fast = np.asarray(thumbnails.render_untouched_full(photo)).astype(np.float32)
    slow = np.asarray(thumbnails.render_full_from_stored_edits(photo)).astype(np.float32)
    assert fast.shape == slow.shape == (300, 400, 3)
    assert np.mean(np.abs(fast - slow)) < 1.0
    assert np.max(np.abs(fast - slow)) <= 3.0


def test_generate_full_takes_the_short_path_for_an_untouched_photo(photo, monkeypatch):
    taken = []
    monkeypatch.setattr(thumbnails, "render_untouched_full", lambda img: taken.append("fast") or PILImage.new("RGB", (4, 4)))
    monkeypatch.setattr(thumbnails, "render_full_from_stored_edits", lambda img: taken.append("slow") or PILImage.new("RGB", (4, 4)))
    out = thumbnails.generate_full(photo)
    assert out.exists() and taken == ["fast"]

    out.unlink()
    photo.edit_rotation = 90
    thumbnails.generate_full(photo)
    assert taken == ["fast", "slow"]

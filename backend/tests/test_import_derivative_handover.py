"""The review already renders every photo's thumbnail and preview, so the
library must not render them a second time when the import is committed.

That second pass is what left a freshly imported library showing empty tiles
while the disk ground through a full decode of every photo again - measurably,
it cut the drive's throughput by a third while it ran.
"""

from pathlib import Path

import pytest
from PIL import Image as PILImage

from app.config import settings
from app.services.import_pipeline import (
    adopt_staged_derivatives,
    staged_demosaic_path,
    staged_preview_path,
    staged_thumb_dir,
)
from app.services.thumbnails import derivative_dir, has_derivatives


@pytest.fixture()
def staged(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "import_staging_root", tmp_path / "staging")
    monkeypatch.setattr(settings, "thumbnail_cache_root", tmp_path / "thumbs")
    thumb_dir = staged_thumb_dir("session-1")
    thumb_dir.mkdir(parents=True)
    return thumb_dir


def _jpeg(path: Path, size=(40, 30)) -> None:
    PILImage.new("RGB", size, "blue").save(path, "JPEG")


def test_a_jpeg_hands_its_review_renders_to_the_library(staged):
    _jpeg(staged / "file-1.jpg")
    _jpeg(staged_preview_path(staged, "file-1"))

    assert adopt_staged_derivatives("session-1", "file-1", "image-1") is True
    # has_derivatives is what the post-import worker checks before rendering,
    # so this being true is exactly "the second pass will skip this photo".
    assert has_derivatives("image-1")
    # Moved, not copied: the staging folder is thrown away right afterwards.
    assert not (staged / "file-1.jpg").exists()


def test_a_raw_hands_over_its_demosaiced_thumbnail(staged):
    # A RAW has both: the quick one from its embedded preview and the
    # demosaiced one the grid actually shows. The library wants the latter.
    _jpeg(staged / "file-2.jpg", size=(10, 10))
    _jpeg(staged_demosaic_path(staged, "file-2"), size=(40, 30))
    _jpeg(staged_preview_path(staged, "file-2"))

    assert adopt_staged_derivatives("session-1", "file-2", "image-2") is True
    handed = PILImage.open(derivative_dir("image-2") / "thumbnail.jpg")
    assert handed.size == (40, 30)


def test_a_half_rendered_photo_is_left_to_the_worker(staged):
    """The worker only skips a photo that has BOTH derivatives, so handing over
    one of them would just make it render both anyway - and would have thrown
    away the one good file for nothing."""
    _jpeg(staged / "file-3.jpg")  # preview missing

    assert adopt_staged_derivatives("session-1", "file-3", "image-3") is False
    assert not has_derivatives("image-3")
    assert (staged / "file-3.jpg").exists()


def test_nothing_staged_is_not_an_error(staged):
    assert adopt_staged_derivatives("session-1", "unknown", "image-4") is False

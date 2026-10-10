"""A full-resolution render is kept once, as the 8-bit frame it came out as.

"Save copy" from the editor arrives right after the full.jpg warmer rendered
the same edit, and a second export of a photo repeats the first: each used to
render the frame again. The frame is kept under its key - photo, file, edit,
geometry, size cap - and a render with another key, another photo's decode
or an idle editor lets it go. The frame is also handed through the pipeline
as the float16 the native base is kept in, which must change no pixel.
"""

from datetime import datetime

import numpy as np
import pytest
from PIL import Image as PILImage

from app.db.models import FileType, Image
from app.services import develop, raw as raw_service, thumbnails


@pytest.fixture()
def photo(tmp_path, monkeypatch):
    path = tmp_path / "shot.jpg"
    ys, xs = np.mgrid[0:120, 0:160].astype(np.float32)
    g = 0.5 + 0.3 * np.sin(xs / 11.0) * np.cos(ys / 9.0)
    rgb = np.dstack([g, g * 0.92 + 0.04, g * 0.85 + 0.08])
    PILImage.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), "RGB").save(path, "JPEG", quality=95)
    image = Image(
        id="kept-full", owner_id=1, file_path=str(path), original_filename="shot.jpg",
        file_hash="hash", file_type=FileType.jpeg, file_size=path.stat().st_size,
        taken_at=datetime(2026, 10, 10, 12, 0, 0), width=160, height=120,
        edit_adjustments='{"exposure": 0.3, "contrast": 12}', edit_rev=1,
    )
    monkeypatch.setattr("app.services.filesystem.resolve_image_path", lambda img: path)
    monkeypatch.setattr(thumbnails.settings, "thumbnail_cache_root", tmp_path / "thumbs")
    monkeypatch.setattr(thumbnails.machine, "LOW_RAM", False)
    thumbnails.clear_editor_base_caches()
    yield image
    thumbnails.clear_editor_base_caches()


def _decodes(monkeypatch) -> list:
    calls = []
    real = raw_service.load_linear_base

    def counting(path, **kwargs):
        calls.append(kwargs)
        return real(path, **kwargs)

    monkeypatch.setattr(raw_service, "load_linear_base", counting)
    return calls


def test_the_same_render_is_answered_from_the_kept_frame(photo, monkeypatch):
    calls = _decodes(monkeypatch)
    first = thumbnails.render_full_from_stored_edits(photo)
    assert thumbnails._last_full_render is not None
    timing: dict = {}
    again = thumbnails.render_full_from_stored_edits(photo, timing=timing)
    assert timing.get("full_hit") and len(calls) == 1
    np.testing.assert_array_equal(np.asarray(first), np.asarray(again))
    # The array form is the very frame, read-only.
    arr = thumbnails.render_full_from_stored_edits(photo, timing=timing)
    assert isinstance(arr, PILImage.Image)
    kept = thumbnails._last_full_render[1]
    assert kept.dtype == np.uint8 and not kept.flags.writeable
    np.testing.assert_array_equal(kept, np.asarray(first))


def test_another_edit_or_geometry_or_size_misses(photo):
    thumbnails.render_full_from_stored_edits(photo)
    key = thumbnails._last_full_render[0]
    photo.edit_adjustments = '{"exposure": 0.31}'
    thumbnails.render_full_from_stored_edits(photo)
    assert thumbnails._last_full_render[0] != key
    key = thumbnails._last_full_render[0]
    photo.edit_rotation = 90
    out = thumbnails.render_full_from_stored_edits(photo)
    assert thumbnails._last_full_render[0] != key and out.size == (120, 160)
    key = thumbnails._last_full_render[0]
    thumbnails.render_full_from_stored_edits(photo, max_size=80)
    assert thumbnails._last_full_render[0] != key


def test_a_16_bit_render_is_not_kept(photo):
    thumbnails.clear_editor_base_caches()
    thumbnails.render_full_from_stored_edits(photo, depth16=True)
    assert thumbnails._last_full_render is None


def test_the_kept_frame_goes_with_the_caches(photo):
    thumbnails.render_full_from_stored_edits(photo)
    assert thumbnails._last_full_render is not None
    assert not thumbnails.editor_caches_empty()
    thumbnails.clear_editor_base_caches()
    assert thumbnails._last_full_render is None


def test_another_photos_decode_lets_the_frame_go(photo, tmp_path):
    thumbnails.render_full_from_stored_edits(photo)
    assert thumbnails._last_full_render is not None
    other = tmp_path / "other.jpg"
    PILImage.new("RGB", (40, 30), "blue").save(other, "JPEG")
    thumbnails._cached_native_base("other-photo", str(other), other.stat().st_mtime_ns)
    assert thumbnails._last_full_render is None


def test_the_float16_base_renders_the_same_pixels(photo, monkeypatch):
    """The native base is kept as float16 and now goes through the pipeline
    as it is; the pixels must be the ones the whole-frame float32 upcast gave,
    with geometry on and off, and with the local tone guide (which keeps the
    upcast) in use."""
    for adjustments, rotation, straighten in (
        ({"exposure": 0.3, "contrast": 12, "vibrance": 20}, 0, 0.0),
        ({"exposure": 0.3, "contrast": 12}, 90, 3.0),
        ({"exposure": 0.2, "highlights": -40, "shadows": 30, "process": "2"}, 0, 0.0),
    ):
        adj = develop.normalize(adjustments)
        thumbnails.clear_editor_base_caches()
        new = np.asarray(thumbnails.render_edited_image(photo, rotation, None, adj, straighten=straighten))
        # The reference: the base upcast whole, as before.
        thumbnails.clear_editor_base_caches()
        real = thumbnails._cached_native_base

        def upcast(*a, **k):
            lin, gain = real(*a, **k)
            return lin.astype(np.float32), gain

        monkeypatch.setattr(thumbnails, "_cached_native_base", upcast)
        old = np.asarray(thumbnails.render_edited_image(photo, rotation, None, adj, straighten=straighten))
        monkeypatch.setattr(thumbnails, "_cached_native_base", real)
        np.testing.assert_array_equal(new, old)

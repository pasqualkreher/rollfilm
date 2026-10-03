"""The 100%-zoom full.jpg takes the short way for a photo without edits.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

from datetime import datetime
from pathlib import Path

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
    monkeypatch.setattr(thumbnails, "render_full_from_stored_edits", lambda img, **_: taken.append("slow") or PILImage.new("RGB", (4, 4)))
    out = thumbnails.generate_full(photo)
    assert out.exists() and taken == ["fast"]

    out.unlink()
    photo.edit_rotation = 90
    thumbnails.generate_full(photo)
    assert taken == ["fast", "slow"]


def test_a_superseded_untouched_render_bails_after_the_decode_and_keeps_the_base(photo, monkeypatch):
    """Zapping past a photo whose 100% render is in flight: the decode cannot
    be stopped, but nothing after it runs, no file is written, and the decoded
    base stays cached - coming back is a short render, not another decode."""
    calls = {"stale": 0}

    def stale_after_decode() -> bool:
        calls["stale"] += 1
        # The entry check and the one before the decode pass; the post-decode one trips.
        return calls["stale"] > 2

    with pytest.raises(thumbnails.PreviewSuperseded):
        thumbnails.generate_full(photo, is_stale=stale_after_decode)
    assert not (thumbnails.derivative_dir(photo.id) / "full.jpg").exists()
    assert thumbnails.native_base_ready(photo.id, thumbnails.editor_mtime_ns(photo))
    # And now it is a cache hit: no decode, just the render.
    monkeypatch.setattr(thumbnails.raw_service, "load_linear_base", lambda *a, **k: pytest.fail("decoded again"))
    assert thumbnails.generate_full(photo).exists()


def test_a_render_superseded_while_queued_for_the_decode_never_decodes(photo, monkeypatch):
    """A /full for a photo zapped past while it waited on the decode lock gives
    up before the 7-20s decode, instead of making the next zoom wait it out."""
    calls = {"stale": 0}

    def stale_once_queued() -> bool:
        calls["stale"] += 1
        return calls["stale"] > 1  # the entry check passes; the one under the decode lock trips

    monkeypatch.setattr(thumbnails.raw_service, "load_linear_base", lambda *a, **k: pytest.fail("decoded"))
    with pytest.raises(thumbnails.PreviewSuperseded):
        thumbnails.generate_full(photo, is_stale=stale_once_queued)
    assert not (thumbnails.derivative_dir(photo.id) / "full.jpg").exists()
    assert not thumbnails.native_base_ready(photo.id, thumbnails.editor_mtime_ns(photo))


def test_the_edited_half_tier_takes_the_half_size_decode(photo, monkeypatch):
    """The half tier of an edited raw is an interim picture: always the
    half-size demosaic, never the full-sensor one its padded target asks for."""
    seen = {}

    def spy(path, half_size=False, **kw):
        seen["half_size"] = half_size
        return np.full((30, 40, 3), 0.3, np.float32), 1.0

    monkeypatch.setattr(thumbnails.raw_service, "is_raw", lambda p: True)
    monkeypatch.setattr(thumbnails.raw_service, "raw_dimensions", lambda p: (7728, 5152))
    monkeypatch.setattr(thumbnails.raw_service, "load_linear_base", spy)
    photo.edit_rotation = 90
    thumbnails.render_full_from_stored_edits(photo, max_size=3900, half_decode=True)
    assert seen["half_size"] is True
    thumbnails.render_full_from_stored_edits(photo, max_size=3900)
    assert seen["half_size"] is False


def test_busy_probes_see_a_running_render():
    assert not thumbnails.full_render_busy()
    with thumbnails._full_renders_lock:
        thumbnails._full_renders_inflight += 1
    try:
        assert thumbnails.full_render_busy()
    finally:
        with thumbnails._full_renders_lock:
            thumbnails._full_renders_inflight -= 1
    assert not thumbnails.full_render_busy()
    assert not thumbnails.native_decode_busy()
    with thumbnails._native_decode_lock:
        assert thumbnails.native_decode_busy()


def test_the_banded_tone_stage_matches_the_formula_and_takes_float16():
    from app.services import raw as raw_service

    rng = np.random.default_rng(3)
    lin = (rng.random((600, 70, 3), dtype=np.float32) * 1.3)  # spans several bands, past white
    gain = 1.7
    y = (lin @ raw_service._LUMA) * gain
    ratio = gain * raw_service.reinhard_ratio(y, gain)
    ref = np.clip(raw_service._linear_to_srgb(np.clip(lin * ratio[..., None], 0, 1)) * 255 + 0.5, 0, 255).astype(np.uint8)
    out = raw_service.default_tone_to_srgb(lin, gain)
    assert out.shape == ref.shape and out.dtype == np.uint8
    assert np.abs(out.astype(np.int16) - ref.astype(np.int16)).max() <= 1
    out16 = raw_service.default_tone_to_srgb(lin.astype(np.float16), gain)
    assert np.abs(out16.astype(np.int16) - ref.astype(np.int16)).max() <= 2


def test_the_half_tier_is_the_photo_at_the_editor_bases_size(photo):
    out = thumbnails.generate_half(photo)
    assert out.name == "half.jpg" and out.exists()
    assert max(PILImage.open(out).size) == 400  # the photo is smaller than the tier: its own size
    fast = np.asarray(thumbnails.render_untouched_full(photo)).astype(np.float32)
    half = np.asarray(PILImage.open(out).convert("RGB")).astype(np.float32)
    assert np.mean(np.abs(fast - half)) < 2.0  # same rendering, JPEG apart


def test_the_half_tier_of_an_unedited_jpeg_is_the_file_itself(photo, monkeypatch):
    """The lightbox sharpens a fit view from the half tier without a zoom, for
    every photo rested on. For an unedited JPEG that must cost nothing: the
    file is served as it is, no render and no half.jpg per photo looked at.
    An edit (or a raw) still gets the rendered tier."""
    from app.api.routes import images as images_routes

    path = Path(photo.file_path)
    monkeypatch.setattr(images_routes, "resolve_image_path", lambda img: path)
    assert images_routes.half_tier_file(photo) == path
    assert not (thumbnails.derivative_dir(photo.id) / "half.jpg").exists()

    photo.edit_rotation = 90
    out = images_routes.half_tier_file(photo)
    assert out.name == "half.jpg" and out.exists()


def test_a_saved_edit_clears_the_half_tier_with_the_full_one(photo, monkeypatch):
    d = thumbnails.derivative_dir(photo.id)
    d.mkdir(parents=True, exist_ok=True)
    (d / "full.jpg").write_bytes(b"x")
    (d / "half.jpg").write_bytes(b"x")
    thumbnails.generate_derivatives(photo.id, Path(photo.file_path))
    assert not (d / "full.jpg").exists() and not (d / "half.jpg").exists()


def _derivative(image_id: str, name: str) -> np.ndarray:
    return np.asarray(PILImage.open(thumbnails.derivative_dir(image_id) / name))


def test_an_unedited_jpeg_gets_the_same_thumbnails_without_the_pipeline(photo, tmp_path):
    """A library rebuild pushed every unedited JPEG through the float develop
    pipeline to get back the pixels it started from. The plain path must write
    the very same files."""
    path = Path(photo.file_path)
    thumbnails.generate_derivatives("slow", path)
    thumbnails.generate_untouched_derivatives("plain", path)
    for name in ("preview.jpg", "thumbnail.jpg", "small.jpg"):
        assert np.array_equal(_derivative("slow", name), _derivative("plain", name)), name


def test_a_rebuild_takes_the_plain_path_only_for_unedited_photos(photo, monkeypatch):
    calls = []
    monkeypatch.setattr(
        thumbnails, "generate_untouched_derivatives",
        lambda *a, **k: calls.append("plain"),
    )
    monkeypatch.setattr(thumbnails, "generate_derivatives", lambda *a, **k: calls.append("pipeline"))
    thumbnails.regenerate_for_image(photo)
    photo.edit_rotation = 90
    thumbnails.regenerate_for_image(photo)
    assert calls == ["plain", "pipeline"]

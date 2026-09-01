"""Every editor render tier actually runs.

The tiers are picked apart by name across render_editor_preview_bytes and
_render_editor_bytes, and the native one - the true full-resolution decode used
at 100% zoom - has no other test: it needs a real file on disk, so a refactor
that broke it (a helper deleted along with the cache it sat next to, say) sailed
through the whole suite and only surfaced as a NameError in the running app.
These renders are tiny and cost milliseconds; what they buy is that every tier
is at least executed once.
"""

from datetime import datetime

import numpy as np
import pytest
from PIL import Image as PILImage

from app.db.models import FileType, Image
from app.services import develop, thumbnails


@pytest.fixture()
def photo(tmp_path, monkeypatch):
    path = tmp_path / "shot.jpg"
    # Something with structure, so the detail passes have work to do.
    ys, xs = np.mgrid[0:180, 0:240].astype(np.float32)
    g = 0.5 + 0.3 * np.sin(xs / 11.0) * np.cos(ys / 9.0)
    rgb = np.dstack([g, g * 0.92 + 0.04, g * 0.85 + 0.08])
    PILImage.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), "RGB").save(path, "JPEG")

    image = Image(
        id="tier-smoke", owner_id=1, file_path=str(path), original_filename="shot.jpg",
        file_hash="hash", file_type=FileType.jpeg, file_size=path.stat().st_size,
        taken_at=datetime(2026, 9, 1, 12, 0, 0), width=240, height=180,
    )
    monkeypatch.setattr(
        "app.services.filesystem.resolve_image_path", lambda img: path
    )
    thumbnails.clear_editor_base_caches()
    return image


def _warm_native(photo) -> None:
    """Decode the native base synchronously, so a native request in a test is
    really answered by the native tier. In the app that decode happens on a
    background thread while the request is served from the tier below (see
    warm_native_base) - fine for a user, but a test comparing native output
    would silently compare the stand-in and pass on timing luck."""
    thumbnails._cached_native_base(
        photo.id, photo.file_path, thumbnails.editor_mtime_ns(photo)
    )


@pytest.mark.parametrize(
    "tier",
    [
        pytest.param({"scrub": True}, id="scrub"),
        pytest.param({}, id="accurate"),
        pytest.param({"full_quality": True}, id="full"),
        pytest.param({"ultra": True}, id="ultra"),
        pytest.param({"native": True}, id="native"),
    ],
)
def test_every_tier_renders(photo, tier):
    if tier.get("native"):
        _warm_native(photo)
    adj = develop.normalize({"exposure": 0.3, "contrast": 15, "clarity": 20})
    data = thumbnails.render_editor_preview_bytes(photo, 0, None, adj, **tier)
    assert data[:2] == b"\xff\xd8", "kein JPEG zurückgekommen"
    assert len(data) > 500


def test_a_smaller_base_comes_from_a_bigger_one_without_decoding(photo, monkeypatch):
    """The ladder's whole speed-up: once any base is decoded, the sizes below it
    are downscales, not decodes."""
    from app.services import raw as raw_service

    thumbnails.render_editor_preview_bytes(photo, 0, None, develop.normalize(None), ultra=True)

    def fail(*a, **k):
        raise AssertionError("decoded again instead of deriving from the bigger base")

    monkeypatch.setattr(raw_service, "load_linear_base", fail)
    for tier in ({"full_quality": True}, {}, {"scrub": True}):
        thumbnails.render_editor_preview_bytes(photo, 0, None, develop.normalize(None), **tier)


def test_the_early_cut_renders_the_same_pixels_as_the_whole_frame(photo):
    """The zoomed render slices the base BEFORE converting and running the
    geometry - that is what takes it from ~5s to ~300ms on a 40MP frame. It is
    only allowed to be faster, not different: what comes back must be the same
    part of the same picture the whole-frame render produces.
    """
    from io import BytesIO

    _warm_native(photo)
    adj = develop.normalize({"exposure": 0.4, "contrast": 20, "clarity": 30, "sharpness": 25})
    region = (0.3, 0.25, 0.3, 0.3)

    whole = np.asarray(
        PILImage.open(BytesIO(
            thumbnails.render_editor_preview_bytes(photo, 0, None, adj, native=True)
        )).convert("RGB"), dtype=np.int16
    )
    tile = np.asarray(
        PILImage.open(BytesIO(
            thumbnails.render_editor_preview_bytes(photo, 0, None, adj, native=True, region=region)
        )).convert("RGB"), dtype=np.int16
    )

    h, w = whole.shape[:2]
    x0 = round(region[0] * w)
    y0 = round(region[1] * h)
    expected = whole[y0 : y0 + tile.shape[0], x0 : x0 + tile.shape[1]].astype(int)
    assert tile.shape == expected.shape

    # Both sides went through JPEG, so a couple of levels of encoder noise are
    # expected; a misplaced or differently-developed tile would be nowhere near.
    assert np.abs(expected - tile.astype(int)).mean() < 2.0


def test_geometry_takes_the_long_way(photo):
    """With the frame rotated, the region cannot be a plain slice of the base -
    the render has to run the geometry first and cut afterwards. Same test, but
    it exercises the path the fast one is not allowed to take."""
    from io import BytesIO

    _warm_native(photo)
    adj = develop.normalize({"exposure": 0.2})
    region = (0.3, 0.3, 0.3, 0.3)

    whole = np.asarray(
        PILImage.open(BytesIO(
            thumbnails.render_editor_preview_bytes(photo, 90, None, adj, native=True)
        )).convert("RGB"), dtype=np.int16
    )
    tile = np.asarray(
        PILImage.open(BytesIO(
            thumbnails.render_editor_preview_bytes(photo, 90, None, adj, native=True, region=region)
        )).convert("RGB"), dtype=np.int16
    )
    h, w = whole.shape[:2]
    x0, y0 = round(region[0] * w), round(region[1] * h)
    expected = whole[y0 : y0 + tile.shape[0], x0 : x0 + tile.shape[1]].astype(int)
    assert tile.shape == expected.shape
    assert np.abs(expected - tile.astype(int)).mean() < 2.0


def test_a_superseded_render_bails_between_passes():
    """The pipeline-level abort: once the caller's is_stale turns true, the
    develop pipeline raises PreviewSuperseded at its next checkpoint instead
    of running every remaining pass. Before this, an aborted 2-3s settle
    render kept the CPU busy right through the user's next slider drag."""
    lin = np.full((60, 80, 3), 0.4, dtype=np.float32)
    # Non-neutral on purpose: neutral edits short-circuit before the first
    # checkpoint (correctly - that render is trivially cheap).
    adj = develop.normalize({"exposure": 0.3, "clarity": 20})
    with pytest.raises(thumbnails.PreviewSuperseded):
        thumbnails.apply_adjustments_linear(lin, 1.0, adj, is_stale=lambda: True)


def test_editor_preview_threads_is_stale_into_the_pipeline(photo):
    """End to end: a preview request whose is_stale flips after the entry
    checks bails somewhere inside the render instead of returning bytes."""
    calls = 0

    def stale_after_entry() -> bool:
        nonlocal calls
        calls += 1
        return calls > 2  # the two route-level checks pass; any later one trips

    adj = develop.normalize({"exposure": 0.3, "clarity": 20, "grain_amount": 30})
    with pytest.raises(thumbnails.PreviewSuperseded):
        thumbnails.render_editor_preview_bytes(
            photo, 0, None, adj, is_stale=stale_after_entry
        )

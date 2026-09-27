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


def test_a_budgeted_tile_is_the_same_picture_smaller(photo):
    """`region_px` caps what a zoomed interactive tile renders at - the fix for
    drag frames costing the native cut's pixels instead of the screen's. The
    budgeted tile must be a downscale of the very tile it replaces: same box in
    the frame (meta), fewer pixels in the JPEG, same picture once sized back up.
    """
    from io import BytesIO

    _warm_native(photo)
    adj = develop.normalize({"exposure": 0.4, "contrast": 20})
    region = (0.3, 0.25, 0.3, 0.3)

    full_meta: dict = {}
    full_tile = PILImage.open(BytesIO(
        thumbnails.render_editor_preview_bytes(
            photo, 0, None, adj, region=region, meta=full_meta
        )
    )).convert("RGB")
    small_meta: dict = {}
    small_tile = PILImage.open(BytesIO(
        thumbnails.render_editor_preview_bytes(
            photo, 0, None, adj, region=region, region_px=30,
            meta=small_meta,
        )
    )).convert("RGB")

    # Both name the same box in the same frame - the client composites by
    # these, so they must not move with the render budget.
    assert small_meta["frame"] == full_meta["frame"]
    assert small_meta["box"] == full_meta["box"]
    assert small_meta["box_size"] == full_meta["box_size"]
    assert full_tile.size == tuple(full_meta["box_size"])
    # The budget bit: fewer pixels rendered, capped at the asked-for long edge.
    assert max(small_tile.size) <= 30
    # Same picture: the unbudgeted tile downscaled to the budget matches it.
    expected = np.asarray(full_tile.resize(small_tile.size), dtype=np.int16)
    got = np.asarray(small_tile, dtype=np.int16)
    assert np.abs(expected - got).mean() < 6.0


def test_the_native_settle_tile_honours_the_budget_too(photo):
    """The settle's native region render carries the same on-screen budget as
    the interactive frames: between fit view and 100% zoom the native cut is
    more pixels than the screen shows, and the sharp version arriving seconds
    later was the wait for them. Same box in the frame, smaller bitmap."""
    from io import BytesIO

    _warm_native(photo)
    adj = develop.normalize({"exposure": 0.4, "contrast": 20})
    region = (0.3, 0.25, 0.3, 0.3)
    meta: dict = {}
    tile = PILImage.open(BytesIO(
        thumbnails.render_editor_preview_bytes(
            photo, 0, None, adj, native=True, region=region, region_px=30, meta=meta
        )
    ))
    assert max(tile.size) <= 30
    assert tuple(meta["box_size"]) != tile.size  # box named in frame pixels


def test_a_budget_bigger_than_the_tile_changes_nothing(photo):
    """A tile already within its on-screen budget must render exactly as it
    would have without one - the cap is a ceiling, never an upscale."""
    _warm_native(photo)
    adj = develop.normalize({"exposure": 0.4, "contrast": 20})
    region = (0.3, 0.25, 0.3, 0.3)
    plain = thumbnails.render_editor_preview_bytes(
        photo, 0, None, adj, region=region
    )
    budgeted = thumbnails.render_editor_preview_bytes(
        photo, 0, None, adj, region=region, region_px=4096
    )
    assert budgeted == plain


def test_a_region_tile_reuses_its_tone_stage(photo, monkeypatch):
    """Dragging a post-tone slider while zoomed re-renders the same tile with
    only stages below the tone block changed - the tone block must come from
    the stage cache, not be recomputed per frame. (The native WHOLE frame stays
    uncached on purpose; the tile is viewport-sized, which is the difference.)"""
    _warm_native(photo)
    thumbnails.invalidate_tone_stage()
    region = (0.3, 0.25, 0.3, 0.3)

    calls = 0
    real = thumbnails._linear_tone_block_banded

    def counting(*a, **k):
        nonlocal calls
        calls += 1
        return real(*a, **k)

    monkeypatch.setattr(thumbnails, "_linear_tone_block_banded", counting)
    for saturation in (20, -20):
        thumbnails.render_editor_preview_bytes(
            photo, 0, None,
            develop.normalize({"exposure": 0.4, "saturation": saturation}),
            region=region,
        )
    assert calls == 1, "the tile's tone stage was recomputed instead of reused"


def test_a_region_tile_is_prepared_once(photo, monkeypatch):
    """Cutting, converting and downscaling the tile out of the native base ran
    per zoomed frame, ahead of every cache. The prepared tile is kept between
    frames of the same box and budget - and serving it from the cache must not
    change a pixel."""
    _warm_native(photo)
    region = (0.3, 0.25, 0.3, 0.3)
    thumbnails.invalidate_tone_stage()
    first = thumbnails.render_editor_preview_bytes(
        photo, 0, None, develop.normalize({"exposure": 0.4}), region=region, region_px=40
    )
    assert len(thumbnails._tile_cache) == 1
    resized = []
    real_resize = thumbnails.cv2.resize
    monkeypatch.setattr(thumbnails.cv2, "resize", lambda *a, **k: (resized.append(1), real_resize(*a, **k))[1])
    again = thumbnails.render_editor_preview_bytes(
        photo, 0, None, develop.normalize({"exposure": 0.4}), region=region, region_px=40
    )
    assert again == first
    # The second frame's tile came from the cache: nothing was downscaled to
    # the budget again. (The pipeline itself doesn't resize a plain exposure edit.)
    assert resized == []


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


def test_the_settle_tiers_render_at_the_on_screen_size(tmp_path, monkeypatch):
    """`settle_px` is the canvas's on-screen size: a full/ultra settle renders
    at the ladder rung covering it, never the tier's ceiling when the screen
    shows less - and never a size the screen would show upscaled. Each rung
    derives from the 3900 base, so no rung costs a decode."""
    from io import BytesIO

    from app.services import raw as raw_service

    path = tmp_path / "huge.jpg"
    ys, xs = np.mgrid[0:3000, 0:4000].astype(np.float32)
    g = 0.5 + 0.3 * np.sin(xs / 41.0) * np.cos(ys / 37.0)
    PILImage.fromarray(
        (np.clip(np.dstack([g, g * 0.9, g * 0.8]), 0, 1) * 255).astype(np.uint8), "RGB"
    ).save(path, "JPEG", quality=80)
    image = Image(
        id="settle-px", owner_id=1, file_path=str(path), original_filename="huge.jpg",
        file_hash="hash3", file_type=FileType.jpeg, file_size=path.stat().st_size,
        taken_at=datetime(2026, 9, 12, 12, 0, 0), width=4000, height=3000,
    )
    monkeypatch.setattr("app.services.filesystem.resolve_image_path", lambda img: path)
    thumbnails.clear_editor_base_caches()
    adj = develop.normalize({"exposure": 0.3})

    def long_edge(**kw) -> int:
        data = thumbnails.render_editor_preview_bytes(image, 0, None, adj, **kw)
        return max(PILImage.open(BytesIO(data)).size)

    assert long_edge(ultra=True) == thumbnails.ULTRA_EDITOR_PREVIEW_PX  # no budget: the ceiling

    def fail(*a, **k):
        raise AssertionError("a settle rung decoded instead of deriving from the 3900 base")

    monkeypatch.setattr(raw_service, "load_linear_base", fail)
    assert long_edge(ultra=True, settle_px=2800) == 3000        # the rung above the screen
    assert long_edge(ultra=True, settle_px=99999) == thumbnails.ULTRA_EDITOR_PREVIEW_PX
    assert long_edge(ultra=True, settle_px=1700) == 1800
    assert long_edge(full_quality=True, settle_px=2800) == thumbnails.FULL_EDITOR_PREVIEW_PX  # capped
    assert long_edge(full_quality=True, settle_px=2100) == 2200


def test_a_native_settle_renders_at_the_on_screen_size_and_a_crop_keeps_its_budget(tmp_path, monkeypatch):
    """Above the ultra ceiling the settle asks for native WITH the on-screen
    size: the native base is downscaled to it before the pipeline (a whole
    40MP frame through it was why native used to be gated on zooming in).
    And a budget is the size of the finished picture: with a crop the base
    is sized so the cropped output covers the screen - the old rung maths
    gave a half-frame crop half the pixels it asked for, on every tier."""
    from io import BytesIO

    path = tmp_path / "huge.jpg"
    ys, xs = np.mgrid[0:3000, 0:4000].astype(np.float32)
    g = 0.5 + 0.3 * np.sin(xs / 41.0) * np.cos(ys / 37.0)
    PILImage.fromarray(
        (np.clip(np.dstack([g, g * 0.9, g * 0.8]), 0, 1) * 255).astype(np.uint8), "RGB"
    ).save(path, "JPEG", quality=80)
    image = Image(
        id="native-px", owner_id=1, file_path=str(path), original_filename="huge.jpg",
        file_hash="hash4", file_type=FileType.jpeg, file_size=path.stat().st_size,
        taken_at=datetime(2026, 9, 26, 12, 0, 0), width=4000, height=3000,
    )
    monkeypatch.setattr("app.services.filesystem.resolve_image_path", lambda img: path)
    thumbnails.clear_editor_base_caches()
    _warm_native(image)
    adj = develop.normalize({"exposure": 0.2})
    half = (0.25, 0.25, 0.5, 0.5)

    def long_edge(crop=None, **kw) -> int:
        data = thumbnails.render_editor_preview_bytes(image, 0, crop, adj, **kw)
        return max(PILImage.open(BytesIO(data)).size)

    assert long_edge(native=True) == 4000                      # no budget: the photo's pixels
    assert long_edge(native=True, settle_px=3400) == 3400      # the budget, from the native base
    assert long_edge(native=True, settle_px=9999) == 4000      # never upscaled
    # A half-frame crop shown at 1800px needs a 3600px base, not an 1800px one.
    assert long_edge(crop=half, native=True, settle_px=1800) == 1800
    # The same correction on the preview tiers: 1500px of a half crop is the
    # 3000 rung, whose cropped output covers the screen (it used to be 900).
    assert long_edge(crop=half, ultra=True, settle_px=1500) == 1500
    assert long_edge(crop=half, full_quality=True, settle_px=1000) == 1100  # 2200 rung, halved
    # The cropped ultra frame can't exceed the tier's ceiling - that is the
    # case the native budget exists for: native gives the crop the photo's own
    # pixels (here 2000 - the base is 4000 and is never upscaled).
    assert long_edge(crop=half, ultra=True, settle_px=2800) == thumbnails.ULTRA_EDITOR_PREVIEW_PX // 2
    assert long_edge(crop=half, native=True, settle_px=2800) == 2000


def test_the_scrub_tier_honours_an_adaptive_budget(tmp_path, monkeypatch):
    """`scrub_px` is the editor's adaptive drag resolution: when its measured
    frame times say the fixed scrub tier can no longer track the pointer, it
    asks for fewer pixels. The override must actually size the render, and a
    nonsense value must clamp to the floor instead of erroring."""
    from io import BytesIO

    path = tmp_path / "big.jpg"
    ys, xs = np.mgrid[0:900, 0:1200].astype(np.float32)
    g = 0.5 + 0.3 * np.sin(xs / 17.0) * np.cos(ys / 13.0)
    PILImage.fromarray(
        (np.clip(np.dstack([g, g * 0.9, g * 0.8]), 0, 1) * 255).astype(np.uint8), "RGB"
    ).save(path, "JPEG")
    image = Image(
        id="scrub-px", owner_id=1, file_path=str(path), original_filename="big.jpg",
        file_hash="hash2", file_type=FileType.jpeg, file_size=path.stat().st_size,
        taken_at=datetime(2026, 9, 3, 12, 0, 0), width=1200, height=900,
    )
    monkeypatch.setattr("app.services.filesystem.resolve_image_path", lambda img: path)
    thumbnails.clear_editor_base_caches()
    adj = develop.normalize({"exposure": 0.3, "clarity": 20})

    def scrub_size(**kw) -> tuple[int, int]:
        data = thumbnails.render_editor_preview_bytes(image, 0, None, adj, scrub=True, **kw)
        return PILImage.open(BytesIO(data)).size

    assert max(scrub_size()) == thumbnails.SCRUB_PREVIEW_PX  # the fixed tier
    assert max(scrub_size(scrub_px=560)) == 560              # the ladder's ask
    assert max(scrub_size(scrub_px=1)) == 480                # clamped, no error
    # A budget past the accurate tier is a ceiling, and never an upscale.
    assert max(scrub_size(scrub_px=99999)) == 1200


def test_the_lens_correction_runs_in_the_tile(photo, monkeypatch):
    """The lens correction is on by default for raws. It used to send every
    zoomed frame the long way - the whole native base converted and warped
    (0.6-4s per slider frame at 40MP) to keep a screenful of it. It keeps the
    frame size, so the tile corrects its own box instead: the whole-frame
    correction must not run, and the tile must still be that part of the
    whole corrected render."""
    from io import BytesIO

    from app.services import lens_profile

    prof = lens_profile.parse_fujifilm(
        " ".join(str(v) for v in [515.9, *[0.35, 0.5, 0.61, 0.71, 0.79, 0.87, 0.94, 1.0, 1.06], *[-3.0] * 9]),
        " ".join(str(v) for v in [515.9, *[0.35, 0.5, 0.61, 0.71, 0.79, 0.87, 0.94, 1.0, 1.06], *[2e-3] * 18, 515.9]),
        " ".join(str(v) for v in [515.9, *[0.35, 0.5, 0.61, 0.71, 0.79, 0.87, 0.94, 1.0, 1.06], *[80.0] * 9]),
    )
    corr = lens_profile.Correction(source="fujifilm", label="Camera data", radial=prof)
    monkeypatch.setattr(lens_profile, "profile_for", lambda path: corr)
    _warm_native(photo)
    adj = develop.normalize({"exposure": 0.2})
    region = (0.3, 0.3, 0.3, 0.3)

    whole = np.asarray(
        PILImage.open(BytesIO(
            thumbnails.render_editor_preview_bytes(photo, 0, None, adj, native=True)
        )).convert("RGB"), dtype=np.int16
    )
    whole_frame_calls = []
    real_correct = lens_profile.correct
    monkeypatch.setattr(
        lens_profile, "correct", lambda *a, **k: (whole_frame_calls.append(1), real_correct(*a, **k))[1]
    )
    thumbnails.invalidate_tone_stage()
    tile = np.asarray(
        PILImage.open(BytesIO(
            thumbnails.render_editor_preview_bytes(photo, 0, None, adj, native=True, region=region)
        )).convert("RGB"), dtype=np.int16
    )
    assert whole_frame_calls == []
    h, w = whole.shape[:2]
    x0, y0 = round(region[0] * w), round(region[1] * h)
    expected = whole[y0 : y0 + tile.shape[0], x0 : x0 + tile.shape[1]].astype(int)
    assert tile.shape == expected.shape
    assert np.abs(expected - tile.astype(int)).mean() < 1.0

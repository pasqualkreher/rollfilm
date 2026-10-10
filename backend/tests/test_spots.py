"""Spot heal / clone: what a user judges a retouch on.

A clone puts the source's pixels where the spot was; a heal does the same but
in the spot's own tone; the edge is soft; nothing outside the spot moves; the
cached base the render reads is never written; and a source dragged past the
frame still renders. The exact blend is free to be retuned.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules
at module level is safe."""

import json

import numpy as np

from app.services import develop, spots, thumbnails
from app.services.masks import FieldView

H, W = 120, 160


def _flat(value=0.4, h=H, w=W) -> np.ndarray:
    arr = np.empty((h, w, 3), dtype=np.float32)
    arr[..., 0], arr[..., 1], arr[..., 2] = value, value * 0.9, value * 0.8
    return arr


def _halves(left=0.3, right=0.6) -> np.ndarray:
    """Two flat tones side by side, the split at the middle column."""
    arr = _flat(left)
    arr[:, W // 2 :] = _flat(right)[:, W // 2 :]
    return arr


def _dot(arr: np.ndarray, cx: int, cy: int, r: int, value=0.05) -> np.ndarray:
    """`arr` with a dark disc - the blemish - at (cx, cy)."""
    ys, xs = np.mgrid[0:arr.shape[0], 0:arr.shape[1]]
    out = arr.copy()
    out[(xs - cx) ** 2 + (ys - cy) ** 2 <= r * r] = value
    return out


# The spot sits in the left half (40, 60), its source in the right (120, 60);
# radius 0.08 of the long edge = 12.8 px around a 6 px blemish.
SPOT = {"id": "s1", "kind": "heal", "x": 0.25, "y": 0.5, "src_x": 0.75, "src_y": 0.5,
        "radius": 0.08, "feather": 50, "opacity": 100}
CX, CY, R = 40, 60, 6


def _render(arr: np.ndarray, adj: dict, **kw) -> np.ndarray:
    img = thumbnails.apply_adjustments_linear(arr, 1.0, adj, **kw)
    return np.asarray(img, dtype=np.int16)


# --- schema -------------------------------------------------------------------

def test_spots_normalize_defaults_clamps_and_drops_malformed():
    out = develop.normalize({"spots": [
        {"x": 2, "y": -1, "radius": 9, "feather": 500, "opacity": -3, "kind": "paint"},
        {"y": 0.2},  # no place
        "junk",
        {"id": 7, "x": 0.3, "y": 0.4},
    ]})["spots"]
    assert len(out) == 2
    first, second = out
    assert first["x"] == 1.0 and first["y"] == 0.0
    assert first["src_x"] == 1.0 and first["src_y"] == 0.0  # a missing source sits on the spot
    assert first["radius"] == 0.25 and first["feather"] == 100 and first["opacity"] == 0
    assert first["kind"] == "heal"
    assert second == {"id": "7", "kind": "heal", "x": 0.3, "y": 0.4, "src_x": 0.3, "src_y": 0.4,
                      "radius": 0.02, "feather": 50, "opacity": 100}
    assert develop.normalize({"spots": "nope"})["spots"] == []


def test_an_edit_without_spots_is_stored_as_before():
    """The key exists on every normalized object, but a neutral edit still
    stores NULL and an old blob reads back with no spots."""
    assert develop.dumps({}) is None
    assert develop.is_neutral({"spots": []})
    old = json.dumps({"exposure": 0.5, "masks": []})
    assert develop.loads(old)["spots"] == []
    assert json.loads(develop.dumps({"exposure": 0.5}))["spots"] == []


def test_a_spot_makes_the_edit_non_neutral_and_survives_the_blob():
    adj = {"spots": [SPOT]}
    assert not develop.is_neutral(adj)
    blob = develop.dumps(adj)
    assert blob is not None
    assert develop.loads(blob)["spots"] == [SPOT]


# --- rendering ----------------------------------------------------------------

def test_clone_copies_the_source_disc():
    """A dark speck on a flat tone, cloned from a clean patch: the picture
    renders as if the speck had never been there."""
    clean = _flat()
    dotted = _dot(clean, CX, CY, R)
    got = _render(dotted, {"spots": [{**SPOT, "kind": "clone"}]})
    want = _render(clean, {"spots": []})
    assert np.abs(got - want).max() <= 1


def test_heal_matches_the_surroundings_brightness():
    """The source lies on a brighter tone than the spot. A clone would paste
    that brighter tone; a heal takes the source's texture in the spot's own
    tone, so the speck vanishes into its surroundings."""
    dotted = _dot(_halves(), CX, CY, R)
    healed = _render(dotted, {"spots": [SPOT]})
    cloned = _render(dotted, {"spots": [{**SPOT, "kind": "clone"}]})
    left_tone = healed[20, CX]  # the left half, well outside the spot
    right_tone = healed[20, 120]
    assert np.abs(healed[CY, CX] - left_tone).max() <= 2
    assert np.abs(cloned[CY, CX] - right_tone).max() <= 2
    assert np.abs(cloned[CY, CX] - left_tone).max() > 20  # the two really differ


def test_heal_follows_a_gradient_where_a_clone_shows_a_step():
    """The sky runs from dark to light across the frame; the speck sits on
    it and the only clean source is a flat patch of another shade. A clone
    pastes that shade as a disc; a heal keeps the sky's own run of tones and
    only borrows the source's texture - so the healed spot is the gradient
    as if the speck had never been there."""
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    sky = np.dstack([0.15 + 0.5 * xs / W, 0.2 + 0.4 * xs / W, 0.35 + 0.3 * xs / W]).astype(np.float32)
    sky[:, W // 2 :] = 0.6  # the right half: a flat patch of one shade, the source
    speck = _dot(sky, CX, CY, R)
    clean = _render(sky, {"spots": []})
    spot = {**SPOT, "radius": 0.1}
    healed = _render(speck, {"spots": [spot]})
    cloned = _render(speck, {"spots": [{**spot, "kind": "clone"}]})
    disc = np.zeros((H, W), dtype=bool)
    disc[(xs - CX) ** 2 + (ys - CY) ** 2 <= (R + 4) ** 2] = True
    assert np.abs(healed - clean)[disc].max() <= 4
    assert np.abs(cloned - clean)[disc].max() > 25


def test_feather_softens_the_disc_edge():
    """Along the row through the centre, a hard spot steps from one tone to
    the other; a feathered one takes many pixels to get there."""
    frame = _halves()  # clone the bright right tone onto the dark left
    clone = {**SPOT, "kind": "clone"}

    def ramp_width(feather: int) -> int:
        row = _render(frame, {"spots": [{**clone, "feather": feather}]})[CY, :W // 2, 0]
        lo, hi = row.min(), row.max()
        return int(((row > lo + 2) & (row < hi - 2)).sum())

    assert ramp_width(100) > ramp_width(0) + 6
    assert ramp_width(0) <= 4


def test_pixels_outside_the_spot_are_untouched():
    frame = _dot(_halves(), CX, CY, R)
    with_spot = _render(frame, {"spots": [SPOT]})
    without = _render(frame, {"spots": []})
    r_px = int(np.ceil(SPOT["radius"] * W * spots._RING)) + 2
    outside = np.ones((H, W), dtype=bool)
    outside[CY - r_px : CY + r_px + 1, CX - r_px : CX + r_px + 1] = False
    assert np.abs(with_spot - without)[outside].max() <= 1
    assert np.abs(with_spot - without)[CY, CX].max() > 20


def test_opacity_blends_the_spot_in():
    frame = _dot(_flat(), CX, CY, R)
    full = _render(frame, {"spots": [SPOT]})[CY, CX, 0]
    half = _render(frame, {"spots": [{**SPOT, "opacity": 50}]})[CY, CX, 0]
    none = _render(frame, {"spots": [{**SPOT, "opacity": 0}]})[CY, CX, 0]
    assert none < half < full


def test_the_render_never_writes_into_the_base():
    """The base is the cached array every render shares - the whole-frame
    path and the banded path (frames above _TONE_BAND_MIN_PX) both leave it
    exactly as it was, and both at float16, which is how the native base is
    kept."""
    for h, w in ((H, W), (1000, 1200)):
        base = _dot(_flat(h=h, w=w), int(w * 0.25), h // 2, R).astype(np.float16)
        before = base.copy()
        _render(base, {"spots": [SPOT]})
        assert np.array_equal(base, before)


def test_source_outside_the_frame_is_edge_padded():
    frame = _dot(_flat(), CX, CY, R)
    adj = {"spots": [{**SPOT, "src_x": 0.995, "src_y": 0.99, "radius": 0.15}]}
    got = _render(frame, adj)
    assert got.shape == (H, W, 3) and np.isfinite(got).all()
    # The source was all edge pixels of the same flat tone: the speck is gone.
    assert np.abs(got[CY, CX] - got[20, CX]).max() <= 2


def test_a_tile_reads_its_source_through_the_provider():
    """A zoomed tile holds only the spot; its source lies outside, and comes
    through the `spot_source` callback in whole-frame pixels. The tile must
    match the same box of the whole render."""
    frame = _dot(_halves(), CX, CY, R)
    adj = {"spots": [{**SPOT, "kind": "clone"}]}
    whole = _render(frame, adj)
    x0, y0, x1, y1 = 10, 30, 70, 90  # around the spot, far from the source

    def provider(sx0, sy0, sx1, sy1):
        return spots._take(frame, sx0, sy0, sx1, sy1)

    tile = _render(frame[y0:y1, x0:x1], adj, view=FieldView(x0, y0, W, H), spot_source=provider)
    assert np.abs(tile - whole[y0:y1, x0:x1]).max() <= 1


def test_local_tone_reads_the_healed_picture():
    """Process version 2's Highlights/Shadows read a smoothed map of the
    picture. That map must be of the healed picture: a dark speck that is
    gone must not still lift the pixels that replaced it."""
    frame = _dot(_flat(0.2), CX, CY, 10)
    adj = {"process": "7", "shadows": 80, "highlights": -40, "spots": [{**SPOT, "radius": 0.12}]}
    got = _render(frame, adj)
    inside = got[CY - 8 : CY + 9, CX - 8 : CX + 9]
    assert np.abs(inside - got[20, CX]).max() <= 2


# --- the editor's zoomed tiles ------------------------------------------------

def _photo_with_speck(tmp_path, monkeypatch):
    """A JPEG on disk with a dark speck at (0.25, 0.5), as the editor's tile
    renders need one (test_editor_tiers_smoke has the pattern)."""
    from datetime import datetime

    from PIL import Image as PILImage

    from app.db.models import FileType, Image

    path = tmp_path / "speck.jpg"
    rgb = _dot(_halves(0.35, 0.55, ) if False else _halves(0.35, 0.55), 60, 90, 5)
    PILImage.fromarray((np.clip(rgb[:180, :240] if rgb.shape[0] >= 180 else _fit(rgb), 0, 1) * 255).astype(np.uint8), "RGB").save(path, "JPEG", quality=97)
    image = Image(
        id="speck", owner_id=1, file_path=str(path), original_filename="speck.jpg",
        file_hash="hash", file_type=FileType.jpeg, file_size=path.stat().st_size,
        taken_at=datetime(2026, 10, 10, 12, 0, 0), width=240, height=180,
    )
    monkeypatch.setattr("app.services.filesystem.resolve_image_path", lambda img: path)
    thumbnails.clear_editor_base_caches()
    return image


def _fit(rgb: np.ndarray) -> np.ndarray:
    out = np.empty((180, 240, 3), dtype=np.float32)
    out[:] = rgb[0, 0]
    out[:, 120:] = rgb[0, -1]
    ys, xs = np.mgrid[0:180, 0:240]
    out[(xs - 60) ** 2 + (ys - 90) ** 2 <= 25] = 0.05
    return out


def _decode(data: bytes) -> np.ndarray:
    from io import BytesIO

    from PIL import Image as PILImage

    return np.asarray(PILImage.open(BytesIO(data)).convert("RGB"), dtype=np.int16)


def test_a_zoomed_tile_heals_from_a_source_outside_it(tmp_path, monkeypatch):
    """The editor renders only the visible box when zoomed in. A spot in that
    box whose source lies outside it must still heal - the tile reads the
    source through the whole base - and the tile must be the same picture as
    that box of the whole render, at 100% and under the on-screen budget."""
    photo = _photo_with_speck(tmp_path, monkeypatch)
    thumbnails._cached_native_base(photo.id, photo.file_path, thumbnails.editor_mtime_ns(photo))
    adj = develop.normalize({"spots": [{"id": "s", "kind": "heal", "x": 0.25, "y": 0.5,
                                        "src_x": 0.75, "src_y": 0.5, "radius": 0.06}]})
    whole = _decode(thumbnails.render_editor_preview_bytes(photo, 0, None, adj, native=True))
    assert whole.shape == (180, 240, 3)
    # The speck is gone from the whole render, in the left half's tone.
    assert np.abs(whole[90, 60] - whole[20, 60]).max() <= 6

    region = (0.1, 0.2, 0.3, 0.5)  # holds the spot, not its source
    meta: dict = {}
    tile = _decode(thumbnails.render_editor_preview_bytes(
        photo, 0, None, adj, native=True, region=region, meta=meta
    ))
    bx, by = meta["box"]
    bw, bh = meta["box_size"]
    assert tile.shape[:2] == (bh, bw)
    assert np.abs(tile - whole[by : by + bh, bx : bx + bw]).mean() < 2.0
    assert np.abs(tile - whole[by : by + bh, bx : bx + bw]).max() <= 8

    small_meta: dict = {}
    small = _decode(thumbnails.render_editor_preview_bytes(
        photo, 0, None, adj, native=True, region=region, region_px=30, meta=small_meta
    ))
    assert small_meta["box"] == meta["box"]
    from PIL import Image as PILImage

    expected = np.asarray(
        PILImage.fromarray(whole[by : by + bh, bx : bx + bw].astype(np.uint8)).resize(
            (small.shape[1], small.shape[0])
        ),
        dtype=np.int16,
    )
    assert np.abs(expected - small).mean() < 6.0

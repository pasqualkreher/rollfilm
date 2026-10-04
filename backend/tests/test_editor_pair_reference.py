"""The editor's compare reference for a raw with a camera JPEG beside it.

The compare views (hold, split, side by side) can show the pair's JPEG instead
of the original or a snapshot. It is the partner's file, untouched, but it has
to land in the frame the raw's edit is shown in - same aspect, same crop, same
tile boxes - or the two halves of a split view don't cover each other. And it
must leave the raw's decoded bases alone: the full-resolution base is kept for
one image, so a reference rendered through the editor pipeline would evict it
on every frame of a zoomed compare.
"""

from datetime import datetime
from io import BytesIO

import numpy as np
import pytest
from fastapi import HTTPException
from PIL import Image as PILImage
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes.images import _editor_pair_reference
from app.db.base import Base
from app.db.models import FileType, Image, User
from app.services import thumbnails

# The raw's frame in these tests: a few rows and columns more than its camera
# JPEG, the way a real sensor readout is.
RAW_FRAME = (1212, 808)


def _write_jpeg(path, width: int, height: int) -> None:
    ys, xs = np.mgrid[0:height, 0:width].astype(np.float32)
    g = 0.5 + 0.3 * np.sin(xs / 23.0) * np.cos(ys / 19.0)
    rgb = np.dstack([g, g * 0.9 + 0.05, xs / width])
    PILImage.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), "RGB").save(path, "JPEG", quality=92)


def _partner(tmp_path, monkeypatch, width: int = 1200, height: int = 800) -> Image:
    path = tmp_path / "shot.jpg"
    _write_jpeg(path, width, height)
    monkeypatch.setattr("app.services.filesystem.resolve_image_path", lambda img: path)
    thumbnails.clear_editor_base_caches()
    return Image(
        id="pair-jpg", owner_id=1, file_path=str(path), original_filename="shot.jpg",
        file_hash="hash-jpg", file_type=FileType.jpeg, file_size=path.stat().st_size,
        taken_at=datetime(2026, 10, 4, 12, 0, 0), width=width, height=height,
    )


def _render(partner, crop=None, frame=RAW_FRAME, **kw) -> PILImage.Image:
    data = thumbnails.render_pair_reference_bytes(partner, frame, 0, crop, **kw)
    assert data[:2] == b"\xff\xd8", "kein JPEG zurückgekommen"
    return PILImage.open(BytesIO(data)).convert("RGB")


def test_the_reference_fills_the_raws_frame(tmp_path, monkeypatch):
    """A full-size camera JPEG is the raw's own pixels minus the sensor border:
    it is laid in unscaled and the border repeated, so the frame is exactly the
    raw's and no dark hairline runs around the picture."""
    partner = _partner(tmp_path, monkeypatch)
    img = _render(partner, native=True)
    assert img.size == RAW_FRAME
    arr = np.asarray(img, dtype=np.int16)
    # The border is the picture's own edge, not the padding of an in-camera crop.
    assert arr[:, :6].mean() > thumbnails._PAIR_PAD_LEVEL + 20
    assert arr[:4].mean() > thumbnails._PAIR_PAD_LEVEL + 20


def test_a_crop_cuts_the_same_part_of_the_frame(tmp_path, monkeypatch):
    partner = _partner(tmp_path, monkeypatch)
    crop = (0.25, 0.25, 0.5, 0.5)
    whole = np.asarray(_render(partner, native=True), dtype=np.int16)
    cut = np.asarray(_render(partner, crop=crop, native=True), dtype=np.int16)
    assert cut.shape[:2] == (RAW_FRAME[1] // 2, RAW_FRAME[0] // 2)
    expected = whole[202 : 202 + cut.shape[0], 303 : 303 + cut.shape[1]]
    assert np.abs(expected - cut).mean() < 2.0


def test_an_in_camera_crop_keeps_the_raws_frame_and_stays_dark_outside(tmp_path, monkeypatch):
    """A 16:9 JPEG beside a 3:2 raw: the crop fractions of the edit are of the
    raw's frame, so the reference has to be that frame too - with nothing
    invented where the camera cut the picture off."""
    partner = _partner(tmp_path, monkeypatch, width=1200, height=676)
    img = _render(partner, native=True)
    assert img.size == RAW_FRAME
    arr = np.asarray(img, dtype=np.int16)
    assert abs(arr[:40].mean() - thumbnails._PAIR_PAD_LEVEL) < 3
    assert abs(arr[-40:].mean() - thumbnails._PAIR_PAD_LEVEL) < 3
    assert arr[300:500].mean() > thumbnails._PAIR_PAD_LEVEL + 20


def test_a_smaller_jpeg_size_is_scaled_to_the_frame(tmp_path, monkeypatch):
    """The camera's M or S size setting: the same picture with fewer pixels,
    not a crop - it is sized up to the raw's frame."""
    partner = _partner(tmp_path, monkeypatch, width=600, height=400)
    img = _render(partner, native=True)
    assert img.size == RAW_FRAME
    # Scaled, not laid in at its own size with a dark surround.
    assert np.asarray(img, dtype=np.int16)[:60].mean() > thumbnails._PAIR_PAD_LEVEL + 20


def test_the_tiers_size_the_frame_like_the_edit(tmp_path, monkeypatch):
    partner = _partner(tmp_path, monkeypatch, width=4000, height=2666)
    frame = (4024, 2682)
    assert max(_render(partner, frame=frame).size) == thumbnails.EDITOR_PREVIEW_PX
    assert max(_render(partner, frame=frame, ultra=True).size) == thumbnails.ULTRA_EDITOR_PREVIEW_PX
    assert max(_render(partner, frame=frame, ultra=True, settle_px=2100).size) == 2200
    assert max(_render(partner, frame=frame, native=True).size) == 4024
    assert max(_render(partner, frame=frame, native=True, settle_px=3000).size) == 3000


def test_a_region_names_its_box_and_is_that_part_of_the_frame(tmp_path, monkeypatch):
    partner = _partner(tmp_path, monkeypatch)
    region = (0.3, 0.25, 0.3, 0.3)
    whole = np.asarray(_render(partner, native=True), dtype=np.int16)
    meta: dict = {}
    tile = np.asarray(_render(partner, native=True, region=region, meta=meta), dtype=np.int16)
    assert tuple(meta["frame"]) == RAW_FRAME
    x0, y0 = meta["box"]
    assert tile.shape[:2] == (meta["box_size"][1], meta["box_size"][0])
    expected = whole[y0 : y0 + tile.shape[0], x0 : x0 + tile.shape[1]]
    assert np.abs(expected - tile).mean() < 2.0

    # A budgeted tile: the same box in the frame, fewer pixels in the bitmap.
    small_meta: dict = {}
    small = _render(partner, region=region, region_px=60, meta=small_meta)
    assert small_meta == meta
    assert max(small.size) <= 60


def test_a_tile_is_cut_from_the_kept_frame(tmp_path, monkeypatch):
    """Panning a zoomed compare asks for tile after tile of one frame: decoded
    once, cut many times - and a smaller whole frame is a downscale of it."""
    partner = _partner(tmp_path, monkeypatch)
    _render(partner, native=True)

    def fail(*a, **k):
        raise AssertionError("the JPEG was decoded again instead of cut from the kept frame")

    monkeypatch.setattr(thumbnails, "_pair_reference_base", fail)
    _render(partner, native=True, region=(0.1, 0.1, 0.3, 0.3))
    _render(partner, native=True, region=(0.5, 0.4, 0.3, 0.3))
    assert max(_render(partner).size) == RAW_FRAME[0]  # 1212 is below the accurate tier
    assert max(_render(partner, native=True, settle_px=600).size) == 600


def test_the_reference_leaves_the_raws_bases_alone(tmp_path, monkeypatch):
    """What the separate path is for: the raw's decoded bases - above all the
    one full-resolution base - are still there after any reference render."""
    partner = _partner(tmp_path, monkeypatch)
    sentinel = ("raw-id", 1, np.zeros((2, 2, 3), dtype=np.float16), 1.0)
    monkeypatch.setattr(thumbnails, "_native_editor_base", sentinel)
    bases_before = dict(thumbnails._BASE_CACHE)
    for kw in ({}, {"ultra": True}, {"native": True}, {"native": True, "region": (0.2, 0.2, 0.4, 0.4)}):
        _render(partner, **kw)
    assert thumbnails._native_editor_base is sentinel
    assert dict(thumbnails._BASE_CACHE) == bases_before


def test_geometry_is_the_edits(tmp_path, monkeypatch):
    partner = _partner(tmp_path, monkeypatch)
    turned = _render(partner, native=True, flip_h=True)
    plain = _render(partner, native=True)
    assert np.abs(
        np.asarray(turned, dtype=np.int16)[:, ::-1] - np.asarray(plain, dtype=np.int16)
    ).mean() < 2.0
    data = thumbnails.render_pair_reference_bytes(partner, RAW_FRAME, 90, None, native=True)
    assert PILImage.open(BytesIO(data)).size == (RAW_FRAME[1], RAW_FRAME[0])


# -- the route's side: who has a reference at all ---------------------------


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    yield session
    session.close()


def _row(id: str, **extra) -> Image:
    fields = dict(
        id=id, owner_id=1, file_path=f"2026/2026-10-04/{id}", original_filename=id,
        file_hash=f"hash-{id}", file_type=FileType.jpeg, file_size=3,
        width=1200, height=800, taken_at=datetime(2026, 10, 4, 12, 0, 0),
    )
    fields.update(extra)
    return Image(**fields)


def _ask(db: Session, image: Image):
    return _editor_pair_reference(
        db, 1, image, schemas.ImageEdits(),
        full=False, scrub=False, ultra=False, native=True,
        region=(0.2, 0.2, 0.4, 0.4), region_px=None, settle_px=None,
    )


def test_the_route_answers_a_paired_raw_with_the_jpeg(db, tmp_path, monkeypatch):
    path = tmp_path / "shot.jpg"
    _write_jpeg(path, 1200, 800)
    monkeypatch.setattr("app.services.filesystem.resolve_image_path", lambda img: path)
    thumbnails.clear_editor_base_caches()
    db.add(_row("jpg"))
    db.flush()
    raw = _row("raw", file_type=FileType.raw, paired_image_id="jpg", width=RAW_FRAME[0], height=RAW_FRAME[1])
    db.add(raw)
    db.flush()
    db.get(Image, "jpg").paired_image_id = "raw"
    db.commit()

    response = _ask(db, raw)
    assert response.body[:2] == b"\xff\xd8"
    assert response.headers["X-Rollfilm-Tier"] == "native"
    assert response.headers["X-Rollfilm-Frame"] == f"{RAW_FRAME[0]}x{RAW_FRAME[1]}"
    assert response.headers["X-Rollfilm-Box"].count(",") == 3


def test_the_route_refuses_a_photo_without_a_camera_jpeg(db):
    alone = _row("alone", file_type=FileType.raw)
    db.add(alone)
    # A JPEG's own partner is the raw - the reference is offered for the raw only.
    db.add(_row("jpg2"))
    db.flush()
    db.add(_row("raw2", file_type=FileType.raw, paired_image_id="jpg2"))
    db.flush()
    jpg2 = db.get(Image, "jpg2")
    jpg2.paired_image_id = "raw2"
    db.commit()

    for image in (alone, jpg2):
        with pytest.raises(HTTPException) as err:
            _ask(db, image)
        assert err.value.status_code == 404


def test_a_trashed_jpeg_is_no_reference(db):
    db.add(_row("jpg3", deleted_at=datetime(2026, 10, 4, 13, 0, 0)))
    db.flush()
    raw = _row("raw3", file_type=FileType.raw, paired_image_id="jpg3")
    db.add(raw)
    db.commit()
    with pytest.raises(HTTPException) as err:
        _ask(db, raw)
    assert err.value.status_code == 404

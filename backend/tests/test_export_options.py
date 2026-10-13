"""What an export can be asked for beyond a JPEG at a long edge: a quality
above the cache's own (rendered, not re-encoded from full.jpg), sizes by the
short edge, megapixels or a percentage (enlarging only when allowed), PNG
and 8-bit or differently compressed TIFF, output sharpening for print, and
an image watermark beside the text one."""

import io
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi import HTTPException
from PIL import Image as PILImage
from PIL import JpegImagePlugin
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes import images as images_route
from app.config import settings
from app.db.base import Base
from app.db.models import FileType, Image, User
from app.services import develop, export_finish, thumbnails
from app.services.export_finish import Finish, Size


@pytest.fixture()
def library(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "library"
    root.mkdir()
    monkeypatch.setattr(settings, "library_root", root)
    return root


def _photo(library: Path, id: str = "exp") -> Image:
    """An edited camera JPEG (so no "untouched" shortcut applies)."""
    path = library / f"{id}.jpg"
    PILImage.new("RGB", (400, 300), (120, 80, 40)).save(path, "JPEG")
    thumbnails.drop_derivatives(id)
    return Image(
        id=id, owner_id=1, file_path=path.name, original_filename=path.name, file_hash=id,
        file_type=FileType.jpeg, file_size=path.stat().st_size,
        edit_adjustments=develop.dumps({"exposure": 0.5}), edit_rotation=0,
    )


@pytest.fixture()
def render(monkeypatch):
    """The true render, as a solid blue 400x300 frame; counts its calls."""
    calls: list[dict] = []

    def fake(image, max_size=None, depth16=False, **kw):
        calls.append({"max_size": max_size, "depth16": depth16})
        if depth16:
            return np.full((300, 400, 3), (5000, 9000, 60000), np.uint16)
        im = PILImage.new("RGB", (400, 300), (20, 40, 220))
        if max_size and max(im.size) > max_size:
            im.thumbnail((max_size, max_size), PILImage.LANCZOS)
        return im

    monkeypatch.setattr(thumbnails, "render_full_from_stored_edits", fake)
    return calls


def _cache(image: Image, colour=(220, 30, 30)) -> Path:
    """A full.jpg at the cache's quality, a colour the render never makes."""
    path = thumbnails.derivative_dir(image.id) / "full.jpg"
    PILImage.new("RGB", (400, 300), colour).save(path, "JPEG", quality=90)
    return path


def _decode(data: bytes) -> PILImage.Image:
    return PILImage.open(io.BytesIO(data))


# --- quality ------------------------------------------------------------------


def test_high_quality_export_does_not_reencode_the_cache(library, render):
    image = _photo(library)
    cache = _cache(image)
    on_disk = cache.read_bytes()

    usual = _decode(thumbnails.export_jpeg_bytes(image, 90))
    assert render == []  # the cache serves a q90 export
    assert np.asarray(usual)[150, 200, 0] > 150  # red: the cache

    best = _decode(thumbnails.export_jpeg_bytes(image, 100))
    assert len(render) == 1 and render[0]["max_size"] is None
    assert np.asarray(best)[150, 200, 2] > 150  # blue: the render
    # Kept as a keeper: no chroma subsampling at the top of the range.
    assert JpegImagePlugin.get_sampling(best) == 0
    assert JpegImagePlugin.get_sampling(usual) != 0
    assert cache.read_bytes() == on_disk  # the cache is left as it was


def test_a_high_quality_export_without_a_cache_still_fills_it(library, render):
    image = _photo(library, "fill")
    thumbnails.export_jpeg_bytes(image, 98)
    cache = thumbnails.derivative_dir(image.id) / "full.jpg"
    assert cache.exists()
    # Written at the cache's quality, whatever the export asked for.
    assert JpegImagePlugin.get_sampling(PILImage.open(cache)) != 0


# --- sizes --------------------------------------------------------------------


@pytest.mark.parametrize(
    "size, expected",
    [
        (Size("long", 200), 200),
        (Size("short", 150), 200),
        (Size("percent", 50), 200),
        (Size("megapixels", 0.03), 200),
        (Size("long", 400), None),  # its own size
        (Size("long", 800), None),  # no enlarging by default
        (Size("long", 800, no_upscale=False), 800),
        (Size("percent", 150, no_upscale=False), 600),
        (Size("long", None), None),
    ],
)
def test_size_reads_its_value_by_its_fit(size, expected):
    assert size.target_long(400, 300) == expected
    assert size.target_long(300, 400) == expected  # orientation does not matter


@pytest.mark.parametrize(
    "size, dims",
    [
        (Size("short", 150), (200, 150)),
        (Size("megapixels", 0.03), (200, 150)),
        (Size("percent", 25), (100, 75)),
        (Size("long", 800), (400, 300)),
        (Size("long", 800, no_upscale=False), (800, 600)),
    ],
)
def test_sizes_on_the_cache_path_and_the_render_path(library, render, size, dims):
    image = _photo(library, "sized")
    _cache(image)
    assert _decode(thumbnails.export_jpeg_bytes(image, 90, size=size)).size == dims
    assert _decode(thumbnails.export_jpeg_bytes(image, 100, size=size)).size == dims
    png = _decode(thumbnails.export_png_bytes(image, size=size))
    assert png.size == dims
    tif = cv2.imdecode(np.frombuffer(thumbnails.export_tiff_bytes(image, size=size), np.uint8), cv2.IMREAD_UNCHANGED)
    assert tif.shape[1::-1] == dims


def test_a_long_edge_size_lets_the_render_decode_small(library, render):
    image = _photo(library, "cap")
    thumbnails.export_jpeg_bytes(image, 100, size=Size("long", 200))
    thumbnails.export_jpeg_bytes(image, 100, size=Size("short", 100))
    assert [c["max_size"] for c in render] == [200, None]


def test_the_request_keeps_its_old_fields_and_takes_the_new():
    old = schemas.ExportStartRequest(image_ids=["a"], quality=80, max_size=2048, format="tiff")
    assert (old.fit, old.size, old.no_upscale, old.tiff_bits, old.tiff_compression) == ("long", None, True, 16, "lzw")
    assert old.sharpen_medium == "screen" and old.watermark_image == ""
    new = schemas.ExportStartRequest(
        image_ids=["a"], format="png", fit="megapixels", size=12, no_upscale=False,
        sharpen="standard", sharpen_medium="matte",
    )
    assert new.format == "png" and new.size == 12.0
    assert schemas.ExportOptions(format="png", fit="percent", size=50).fit == "percent"


# --- formats ------------------------------------------------------------------


def test_png_is_8_bit_rgb_with_its_profile(library, render):
    image = _photo(library, "png")
    out = _decode(thumbnails.export_bytes(image, "png"))
    assert out.format == "PNG" and out.mode == "RGB" and out.size == (400, 300)
    assert out.info.get("icc_profile")
    assert render[0]["depth16"] is False


@pytest.mark.parametrize("compression, tag", [("none", "raw"), ("lzw", "tiff_lzw"), ("deflate", "tiff_adobe_deflate")])
@pytest.mark.parametrize("bits", [8, 16])
def test_tiff_depth_and_compression(library, render, bits, compression, tag):
    image = _photo(library, "tif")
    data = thumbnails.export_bytes(image, "tiff", tiff_bits=bits, tiff_compression=compression)
    back = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    assert back.dtype == (np.uint8 if bits == 8 else np.uint16) and back.shape == (300, 400, 3)
    assert PILImage.open(io.BytesIO(data)).info.get("compression") == tag


def test_the_default_tiff_is_the_file_it_always_was(library, render):
    image = _photo(library, "tifdefault")
    frame = np.full((300, 400, 3), (5000, 9000, 60000), np.uint16)
    ok, before = cv2.imencode(".tiff", np.ascontiguousarray(frame[..., ::-1]))
    assert ok and thumbnails.export_tiff_bytes(image) == before.tobytes()


def test_an_export_job_writes_png_files(library, render, tmp_path, monkeypatch):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    db: Session = factory()
    db.add(User(id=1, username="local"))
    db.commit()
    db.add(_photo(library, "job"))
    db.commit()
    monkeypatch.setattr(images_route, "SessionLocal", factory)
    out = tmp_path / "out"
    out.mkdir()
    payload = schemas.ExportStartRequest(image_ids=["job"], format="png", dest_dir=str(out), metadata="none",
                                         fit="percent", size=50)
    job = {"done": 0, "total": 1, "state": "running", "path": None, "filename": None, "media": None,
           "error": None, "dest_dir": None, "written": 0, "reveal_path": None, "created": 0.0}
    images_route._export_jobs["job"] = job
    try:
        images_route._run_export_job("job", 1, payload)
    finally:
        images_route._export_jobs.pop("job", None)
        db.close()
    assert job["state"] == "ready" and job["written"] == 1
    written = _decode((out / "job.png").read_bytes())
    assert written.format == "PNG" and written.size == (200, 150)


# --- output sharpening by medium -----------------------------------------------


def _edge(dtype=np.uint8, w=200) -> np.ndarray:
    top = np.iinfo(dtype).max
    arr = np.full((120, w, 3), int(top * 0.6), dtype)
    arr[:, : w // 2] = int(top * 0.4)
    return arr


def test_screen_sharpening_is_what_it_always_was():
    arr = _edge()
    blurred = cv2.GaussianBlur(arr, (0, 0), 0.8)
    expected = cv2.addWeighted(arr, 1.6, blurred, -0.6, 0)
    assert np.array_equal(export_finish.apply(arr, Finish(sharpen="standard")), expected)
    assert np.array_equal(export_finish.apply(arr, Finish(sharpen="standard", medium="screen")), expected)


def test_print_sharpens_harder_and_wider_with_the_size():
    arr = _edge()
    screen = export_finish.apply(arr, Finish(sharpen="standard")).astype(int)
    glossy = export_finish.apply(arr, Finish(sharpen="standard", medium="glossy")).astype(int)
    matte = export_finish.apply(arr, Finish(sharpen="standard", medium="matte")).astype(int)
    over = lambda out: out[60, 100, 0] - arr[60, 100, 0]  # noqa: E731
    assert over(screen) < over(glossy) < over(matte)
    small = export_finish._sharpen_params(Finish(sharpen="low", medium="matte"), (2400, 3600, 3))
    big = export_finish._sharpen_params(Finish(sharpen="low", medium="matte"), (4800, 7200, 3))
    assert big[0] > small[0] and big[1] == small[1]
    # A screen's radius does not care how big the picture is.
    assert export_finish._sharpen_params(Finish(sharpen="low"), (4800, 7200, 3))[0] == 0.8


# --- the image watermark ---------------------------------------------------------


@pytest.fixture()
def logo(tmp_path) -> str:
    """A 100x50 logo: opaque white on the left half, transparent on the right."""
    rgba = np.zeros((50, 100, 4), np.uint8)
    rgba[:, :50] = (255, 255, 255, 255)
    rgba[:, 50:] = (255, 0, 0, 0)
    path = tmp_path / "logo.png"
    PILImage.fromarray(rgba, "RGBA").save(path)
    return str(path)


@pytest.mark.parametrize("dtype", [np.uint8, np.uint16])
@pytest.mark.parametrize("corner", ["tl", "tr", "bl", "br"])
def test_the_logo_lands_in_its_corner_at_its_size(logo, dtype, corner):
    arr = np.full((300, 400, 3), int(np.iinfo(dtype).max * 0.3), dtype)
    before = arr.copy()
    out = export_finish.apply(arr, Finish(logo=logo, logo_corner=corner, logo_size=25, logo_opacity=100))
    assert np.array_equal(arr, before)
    changed = np.argwhere((out != arr).any(axis=-1))
    ys, xs = changed[:, 0], changed[:, 1]
    assert (ys.max() < 150) == (corner[0] == "t") and (xs.max() < 200) == (corner[1] == "l")
    # 25% of the 400px long edge is the logo's 100px long side; only its
    # opaque half shows (give or take the resampling's soft edge).
    assert 45 <= xs.max() - xs.min() + 1 <= 56
    assert out.max() == np.iinfo(dtype).max  # opaque white came through


def test_the_logos_opacity_and_a_missing_file(logo):
    arr = np.full((300, 400, 3), 60, np.uint8)
    faint = export_finish.apply(arr, Finish(logo=logo, logo_opacity=20))
    assert 60 < faint.max() < 120
    assert np.array_equal(export_finish.apply(arr, Finish(logo=logo, logo_opacity=0)), arr)
    assert export_finish.apply(arr, Finish(logo="/no/such/logo.png")) is arr


def test_text_and_logo_watermarks_go_on_together(logo):
    arr = np.full((300, 400, 3), 60, np.uint8)
    out = export_finish.apply(arr, Finish(watermark="© me", corner="br", logo=logo, logo_corner="tl"))
    assert (out[:150, :200] != arr[:150, :200]).any() and (out[150:, 200:] != arr[150:, 200:]).any()


def test_export_start_refuses_an_unreadable_logo(tmp_path):
    bogus = tmp_path / "logo.png"
    bogus.write_text("not a picture")
    payload = schemas.ExportStartRequest(image_ids=["x"], watermark_image=str(bogus))

    class _User:
        id = 1

    with pytest.raises(HTTPException) as err:
        images_route.export_start(payload, db=None, current_user=_User())
    assert err.value.status_code == 400

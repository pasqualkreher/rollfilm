"""Output sharpening and the watermark: on the exported pixels, in the
picture's own bit depth, and never on the frame they were made from."""

import io

import numpy as np
import pytest
from PIL import Image as PILImage

from app.services import export_finish, thumbnails
from app.services.export_finish import Finish


def _edge(dtype) -> np.ndarray:
    """A grey frame with a darker half: one edge to sharpen."""
    top = np.iinfo(dtype).max
    arr = np.full((120, 200, 3), int(top * 0.6), dtype)
    arr[:, :100] = int(top * 0.4)
    return arr


def test_nothing_asked_returns_the_frame_itself():
    arr = _edge(np.uint8)
    assert export_finish.apply(arr, None) is arr
    assert export_finish.apply(arr, Finish()) is arr
    assert export_finish.apply(arr, Finish(watermark="   ")) is arr


@pytest.mark.parametrize("dtype", [np.uint8, np.uint16])
def test_sharpening_steepens_an_edge_and_leaves_flat_areas(dtype):
    arr = _edge(dtype)
    before = arr.copy()
    out = export_finish.apply(arr, Finish(sharpen="standard"))
    assert out.dtype == dtype and out.shape == arr.shape
    assert np.array_equal(arr, before)  # the input is untouched
    # Overshoot on both sides of the edge, nothing far from it.
    assert out[60, 99, 0] < arr[60, 99, 0] and out[60, 100, 0] > arr[60, 100, 0]
    assert np.array_equal(out[:, :90], arr[:, :90]) and np.array_equal(out[:, 110:], arr[:, 110:])
    stronger = export_finish.apply(arr, Finish(sharpen="high"))
    assert stronger[60, 100, 0] > out[60, 100, 0]


@pytest.mark.parametrize("dtype", [np.uint8, np.uint16])
@pytest.mark.parametrize("corner", ["tl", "tr", "bl", "br"])
def test_the_watermark_lands_in_its_corner_only(dtype, corner):
    arr = np.full((300, 400, 3), int(np.iinfo(dtype).max * 0.3), dtype)
    before = arr.copy()
    out = export_finish.apply(arr, Finish(watermark="© Rollfilm", corner=corner))
    assert np.array_equal(arr, before)
    changed = np.argwhere((out != arr).any(axis=-1))
    assert len(changed) > 0
    ys, xs = changed[:, 0], changed[:, 1]
    assert (ys.max() < 150) == (corner[0] == "t") and (ys.min() >= 150) == (corner[0] == "b")
    assert (xs.max() < 200) == (corner[1] == "l") and (xs.min() >= 200) == (corner[1] == "r")
    # White letters on a dark frame: something got clearly brighter.
    assert out.max() > arr.max()


def test_opacity_and_size_scale_the_mark():
    arr = np.full((300, 400, 3), 60, np.uint8)
    faint = export_finish.apply(arr, Finish(watermark="mark", opacity=20))
    solid = export_finish.apply(arr, Finish(watermark="mark", opacity=100))
    # Thin strokes are anti-aliased, so "solid" is nearly, not exactly, white.
    assert solid.max() > 240 and faint.max() < 150
    small = export_finish.apply(arr, Finish(watermark="mark", size="small"))
    large = export_finish.apply(arr, Finish(watermark="mark", size="large"))
    assert (large != arr).sum() > (small != arr).sum()


def test_a_long_text_still_fits_the_picture():
    arr = np.full((200, 240, 3), 60, np.uint8)
    out = export_finish.apply(arr, Finish(watermark="a very long line of copyright text " * 4, size="large"))
    assert out.shape == arr.shape and (out != arr).any()


def test_the_jpeg_fast_path_finishes_the_export_not_the_file(tmp_path):
    source = tmp_path / "full.jpg"
    PILImage.fromarray(np.full((300, 400, 3), 60, np.uint8)).save(source, "JPEG", quality=95)
    on_disk = source.read_bytes()
    plain = PILImage.open(io.BytesIO(thumbnails._encode_jpeg_file(source, 90, None)))
    marked = PILImage.open(
        io.BytesIO(thumbnails._encode_jpeg_file(source, 90, None, Finish(watermark="© me", opacity=100)))
    )
    assert np.asarray(marked).max() > np.asarray(plain).max() + 100
    assert source.read_bytes() == on_disk


def test_the_tiff_is_watermarked_in_16_bit(monkeypatch):
    rendered = np.full((300, 400, 3), 12000, np.uint16)
    monkeypatch.setattr(thumbnails, "render_full_from_stored_edits", lambda *a, **k: rendered)
    import cv2

    data = thumbnails.export_tiff_bytes(object(), finish=Finish(watermark="© me", opacity=100))
    back = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    assert back.dtype == np.uint16 and back.max() > 60000
    assert rendered.max() == 12000  # the render itself was left alone

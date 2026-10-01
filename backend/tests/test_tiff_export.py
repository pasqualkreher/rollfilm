"""The 16-bit TIFF export keeps the float pipeline's tonal resolution."""

import io

import numpy as np
from PIL import Image as PILImage

from app.services import develop, thumbnails


def test_the_16_bit_render_matches_the_8_bit_one_and_resolves_finer():
    ramp = np.linspace(0.20, 0.21, 512, dtype=np.float32)
    lin = np.repeat(np.repeat(ramp[None, :, None], 3, axis=-1), 4, axis=0)
    adj = develop.normalize({"contrast": 20, "frame_width": 0})
    out8 = np.asarray(thumbnails.apply_adjustments_linear(lin.copy(), 1.0, adj))
    out16 = thumbnails.apply_adjustments_linear(lin.copy(), 1.0, adj, depth16=True)
    assert out16.dtype == np.uint16 and out16.shape == out8.shape
    assert np.abs(out16.astype(np.float32) / 257.0 - out8).max() <= 0.51
    # A gentle gradient: a handful of 8-bit steps, hundreds of 16-bit ones.
    assert len(np.unique(out16[0, :, 0])) > 20 * len(np.unique(out8[0, :, 0]))


def test_the_frame_is_white_in_16_bit():
    arr = np.full((40, 60, 3), 1000, np.uint16)
    framed = thumbnails._add_frame_array(arr, {"frame_width": 10})
    assert framed.shape == (48, 68, 3)
    assert framed[0, 0, 0] == 65535 and framed[20, 30, 0] == 1000


def test_the_tiff_encodes_16_bit_rgb(monkeypatch):
    rendered = (np.random.default_rng(0).random((16, 24, 3)) * 65535).astype(np.uint16)
    monkeypatch.setattr(thumbnails, "render_full_from_stored_edits", lambda *a, **k: rendered)
    data = thumbnails.export_tiff_bytes(object())
    import cv2

    back = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    assert back.dtype == np.uint16
    assert np.array_equal(back[..., ::-1], rendered)
    assert PILImage.open(io.BytesIO(data)).format == "TIFF"

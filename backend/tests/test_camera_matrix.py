"""A camera LibRaw has no colour matrix for borrows the one of a model with
the same sensor - applied the way LibRaw applies its own."""

import numpy as np

from app.services import camera_matrix


def _raf(tmp_path, model: bytes):
    path = tmp_path / "DSCF0001.RAF"
    path.write_bytes(b"FUJIFILMCCD-RAW 0201FF179504" + model.ljust(32, b"\0") + b"0111")
    return path


def test_the_model_is_read_from_the_raf_header(tmp_path):
    assert camera_matrix.raf_model(_raf(tmp_path, b"X-E5")) == "X-E5"
    other = tmp_path / "IMG.CR3"
    other.write_bytes(b"\0" * 64)
    assert camera_matrix.raf_model(other) is None


def test_only_a_known_model_without_a_libraw_matrix_borrows_one(tmp_path):
    xe5 = _raf(tmp_path, b"X-E5")
    assert camera_matrix.missing_matrix(xe5, libraw_has_one=True) is None
    assert camera_matrix.missing_matrix(None, libraw_has_one=False) is None
    assert camera_matrix.missing_matrix(_raf(tmp_path, b"X-Unknown"), libraw_has_one=False) is None
    assert camera_matrix.missing_matrix(_raf(tmp_path, b"X-E5"), libraw_has_one=False) is not None


def test_the_matrix_keeps_white_white_and_adds_colour(tmp_path):
    matrix = camera_matrix.missing_matrix(_raf(tmp_path, b"X-E5"), libraw_has_one=False)
    np.testing.assert_allclose(matrix.sum(axis=1), 1.0, atol=1e-9)
    lin = np.array([[[0.5, 0.5, 0.5], [0.4, 0.2, 0.2]]], dtype=np.float32)
    out = camera_matrix.apply(lin.copy(), matrix)
    np.testing.assert_allclose(out[0, 0], 0.5, atol=1e-5)
    # A reddish camera value is a more saturated red in sRGB.
    assert out[0, 1, 0] - out[0, 1, 1] > 0.2

"""The Kelvin white balance and the camera-style shift cross."""

import numpy as np

from app.services import develop, thumbnails, white_balance


STANDARD = "302 368 884 17 302 637 508 21"  # "G R B illuminant": Standard Light A, D65


def test_fuji_as_shot_levels_are_read_off_the_cameras_own_kelvin_curve():
    daylight = white_balance._from_fuji_levels("302 577 568", STANDARD)
    assert 5000 < daylight < 5500
    # Standard Light A is a black body: its calibration point is on the curve.
    assert abs(white_balance._from_fuji_levels("302 368 884", STANDARD) - 2856) < 1


def test_the_kelvin_table_starts_from_the_picture_as_shot():
    kelvin = white_balance._from_fuji_levels("302 577 568", STANDARD)
    table = white_balance._fuji_gains(kelvin, STANDARD, None)
    assert [row[0] for row in table] == list(white_balance._TABLE_KELVINS)
    nearest = min(table, key=lambda row: abs(row[0] - kelvin))
    assert abs(nearest[1] - 1) < 0.02 and abs(nearest[2] - 1) < 0.02
    # A higher Kelvin setting is a warmer picture: more red, less blue.
    reds = [row[1] for row in table]
    blues = [row[2] for row in table]
    assert reds == sorted(reds) and blues == sorted(blues, reverse=True)


def test_any_camera_with_a_colour_matrix_gets_a_kelvin_scale():
    import numpy as np

    # An sRGB-like camera: XYZ -> camera is the XYZ -> sRGB matrix, and a
    # neutral balance means it was shot under D65.
    xyz_cam = np.linalg.inv(np.array(white_balance._XYZ_FROM_SRGB))
    kelvin, table = white_balance._libraw_model(xyz_cam, None, np.array([1.0, 1.0, 1.0]))
    assert 6300 < kelvin < 6700
    warm = next(row for row in table if row[0] == 9000)
    cool = next(row for row in table if row[0] == 3000)
    assert warm[1] > 1 > warm[2] and cool[1] < 1 < cool[2]


def test_a_jpeg_has_no_as_shot_kelvin(tmp_path):
    path = tmp_path / "shot.jpg"
    path.write_bytes(b"not read")
    assert white_balance.as_shot_kelvin(path) is None


def _grey(adj: dict) -> np.ndarray:
    lin = np.full((4, 4, 3), 0.18, dtype=np.float32)
    return thumbnails._linear_tone_block(lin, develop.normalize(adj))[0, 0]


def test_the_shift_cross_moves_red_and_blue_on_their_own():
    neutral = _grey({})
    red = _grey({"wb_shift_r": 9})
    blue = _grey({"wb_shift_b": 9})
    assert red[0] > neutral[0] and red[2] <= neutral[2]
    assert blue[2] > neutral[2] and blue[0] <= neutral[0]
    # Independent of the colour temperature: it stacks on top of it.
    warm = _grey({"temperature": 100})
    warm_shifted = _grey({"temperature": 100, "wb_shift_b": 9})
    assert warm_shifted[2] > warm[2]


def test_a_centred_cross_changes_nothing():
    assert np.array_equal(_grey({}), _grey({"wb_shift_r": 0, "wb_shift_b": 0}))

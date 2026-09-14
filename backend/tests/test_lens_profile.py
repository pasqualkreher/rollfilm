"""Embedded lens profile correction (services/lens_profile.py): reading the
Fujifilm correction tables, and what the correction does to synthetic frames.
No RAW files needed.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

from pathlib import Path

import numpy as np

from app.services import develop, lens_profile, thumbnails

_KNOTS = [0.3535211268, 0.5, 0.6126760563, 0.7070422535, 0.7908450704,
          0.8661971831, 0.9352112676, 1.0, 1.06056338]


def _tags(dist, ca_r, ca_b, vig, knots=_KNOTS):
    """The three RAF tags as exiftool prints them (X-Trans IV/V layout)."""
    join = lambda vals: " ".join(str(v) for v in vals)  # noqa: E731
    return (
        join([515.8888889, *knots, *dist]),
        join([515.8888889, *knots, *ca_r, *ca_b, 515.8888889]),
        join([515.8888889, *knots, *vig]),
    )


def _profile(dist=0.0, ca=0.0, vig=100.0, **kw):
    return lens_profile.parse_fujifilm(*_tags([dist] * 9, [ca] * 9, [ca] * 9, [vig] * 9), **kw)


def test_parses_the_xtrans_v_layout():
    p = lens_profile.parse_fujifilm(*_tags(
        [-1, -2, -3, -4, -5, -6, -7, -8, -9], [1e-4] * 9, [2e-4] * 9, [90] * 9
    ))
    assert p is not None
    # Anchored at the optical centre, where nothing is corrected.
    assert p.knots[0] == 0 and p.knots[1:] == tuple(_KNOTS)
    assert p.distortion == (0.0, -1, -2, -3, -4, -5, -6, -7, -8, -9)
    assert p.ca_r[1] == 1e-4 and p.ca_b[1] == 2e-4
    assert p.vignetting[0] == 100 and p.vignetting[1] == 90


def test_parses_the_older_eleven_knot_layout():
    knots = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
    d = [0, *knots, *[-float(i) for i in range(11)]]
    # CA table: no entry for the first knot, so ten knots and ten values each.
    c = [0, *knots[1:], *[1e-4] * 10, *[2e-4] * 10]
    v = [0, *knots, *[100 - i for i in range(11)]]
    p = lens_profile.parse_fujifilm(" ".join(map(str, d)), " ".join(map(str, c)), " ".join(map(str, v)))
    assert p is not None
    assert len(p.knots) == 11 and p.knots[0] == 0
    assert p.distortion[3] == -3
    assert p.ca_r[0] == 0 and p.ca_r[1] == 1e-4 and p.ca_b[1] == 2e-4
    assert p.vignetting[10] == 90


def test_rejects_tables_on_different_knots_or_unknown_layouts():
    d, c, v = _tags([0] * 9, [0] * 9, [0] * 9, [100] * 9)
    bad_c = c.replace("0.5 ", "0.55 ", 1)
    assert lens_profile.parse_fujifilm(d, bad_c, v) is None
    assert lens_profile.parse_fujifilm(d, c, None) is None
    assert lens_profile.parse_fujifilm("1 2 3", c, v) is None
    assert lens_profile.parse_fujifilm(d, c, "undef") is None


def test_sports_finder_crop_scales_the_knots():
    p = _profile(crop_mode=2)
    assert abs(p.knots[1] - _KNOTS[0] * 1.25) < 1e-9
    assert _profile(crop_mode=0).knots[1] == _KNOTS[0]


def test_a_neutral_profile_is_an_identity():
    arr = np.random.default_rng(0).random((120, 180, 3)).astype(np.float32)
    out = lens_profile.apply_profile(arr, _profile())
    assert out.shape == arr.shape
    assert np.abs(out - arr).max() < 1e-3


def test_vignetting_brightens_the_corners_and_leaves_the_centre():
    arr = np.full((300, 450, 3), 0.1, dtype=np.float32)
    out = lens_profile.apply_profile(arr, _profile(vig=50.0))
    assert abs(float(out[150, 225, 0]) - 0.1) < 2e-3
    assert abs(float(out[0, 0, 0]) - 0.2) < 2e-3
    # Half strength: 1 - 0.5 * (1 - 0.5) of the light left -> gain 1/0.75.
    half = lens_profile.apply_profile(arr, _profile(vig=50.0), fd=1.0, fv=0.5)
    assert abs(float(half[0, 0, 0]) - 0.1 / 0.75) < 2e-3


def test_barrel_correction_fills_the_frame_without_empty_edges():
    h, w = 400, 600
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    # Each pixel records where in the source it came from.
    arr = np.stack([xs / (w - 1), ys / (h - 1), np.zeros_like(xs)], axis=-1)
    # Barrel distortion growing towards the edge (a constant one would only be a
    # scale, which filling the frame undoes again).
    barrel = lens_profile.parse_fujifilm(*_tags([-float(i) for i in range(1, 10)], [0] * 9, [0] * 9, [100] * 9))
    out = lens_profile.apply_profile(arr, barrel, fd=1.0, fv=0.0)
    assert np.abs(out - arr).max() > 0.01
    # The centre stays put.
    assert abs(float(out[h // 2, w // 2, 0]) - arr[h // 2, w // 2, 0]) < 2e-3
    # Scaled to fill: the worst edge point samples the source's own edge, not
    # short of it (lost view)...
    reach_x = max(float(out[:, -1, 0].max()), 1 - float(out[:, 0, 0].min()))
    reach_y = max(float(out[-1, :, 1].max()), 1 - float(out[0, :, 1].min()))
    assert max(reach_x, reach_y) > 1.0 - 2.0 / min(h, w)
    # ...and not beyond it: samples past the edge would all clamp to the edge
    # value, a smeared run along the border instead of a single touch point.
    clamped = np.count_nonzero(out[:, -1, 0] >= 1.0 - 1e-5) + np.count_nonzero(out[-1, :, 1] >= 1.0 - 1e-5)
    assert clamped < 0.05 * (h + w)


def test_switched_off_or_without_data_returns_the_input_untouched(tmp_path: Path):
    arr = np.zeros((8, 8, 3), dtype=np.float32)
    off = develop.normalize({"lens_profile": 0})
    assert lens_profile.correct(arr, tmp_path / "x.RAF", off) is arr
    assert lens_profile.correct(arr, tmp_path / "x.jpg", None) is arr
    assert lens_profile.strengths(develop.normalize({"lens_distortion": 40})) == (0.4, 1.0)


def test_lens_settings_are_stored_but_do_not_count_as_developing():
    adj = develop.normalize({"lens_profile": 0})
    assert not develop.is_neutral(adj)
    assert develop.dumps(adj) is not None
    assert develop.is_neutral(adj, ignore=develop.LENS_KEYS)
    # An unedited raw keeps its browsing auto-exposure with the profile off.
    assert thumbnails._browsing_gain(3.0, adj) == 3.0

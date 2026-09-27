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


# ---- The other camera-data sources -------------------------------------------
# Values from real files (raw.pixls.us samples); the formulas are darktable's.


def test_parses_sony_splines():
    d = "16 -2 0 3 5 9 13 17 22 26 30 33 35 37 37 37 36"
    c = "32 " + " ".join(["-128"] * 16) + " " + " ".join(["256"] * 16)
    v = "16 0 0 128 416 800 1248 1760 2304 2848 3424 4000 4544 5312 6496 8288 9856"
    p = lens_profile.parse_sony(d, c, v)
    assert isinstance(p, lens_profile.RadialProfile)
    assert len(p.knots) == 16 and abs(p.knots[0] - 0.5 / 15) < 1e-9
    assert abs(p.dist[-1] - (36 * 2**-14 + 1)) < 1e-12
    assert abs(p.ca_r[0] - (-128 * 2**-21)) < 1e-12 and abs(p.ca_b[0] - 256 * 2**-21) < 1e-12
    assert p.vig[0] == 1.0 and 0.6 < p.vig[-1] < 0.7  # ~0.65 EV in the corner
    # Counts that don't agree are not Sony's layout.
    assert lens_profile.parse_sony(d, "31 " + c[3:], v) is None
    assert lens_profile.parse_sony(None, c, v) is None


def test_parses_olympus_polynomials():
    p = lens_profile.parse_olympus(
        "0.0451074987649918 -0.0530162751674652 0.0142785906791687 0.98828125",
        "0.000173 0.00034 -0.000237 0.00044 -0.0001 0.00002",
    )
    assert isinstance(p, lens_profile.RadialProfile)
    # At the corner: drs * (1 + drs^2 (k2 + drs^2 (k4 + drs^2 k6))).
    drs = 0.98828125
    rs2 = drs * drs
    expect = drs * (1 + rs2 * (0.0451074987649918 + rs2 * (-0.0530162751674652 + rs2 * 0.0142785906791687)))
    assert abs(p.dist[-1] - expect) < 1e-12
    assert p.ca_r[0] == 0.000173 and not p.vig
    assert lens_profile.parse_olympus("0 0 0 1", "0 0 0 0 0 0") is None


def test_parses_panasonic_and_inverts_it():
    p = lens_profile.parse_panasonic(1, 1.01351643933067, -0.00469970703125, -0.010833740234375, 0.003173828125)
    assert isinstance(p, lens_profile.RadialProfile)
    # dist[i] * r is the source radius Rd whose forward map lands on r.
    sc, a, b, c = 1.01351643933067, -0.010833740234375, -0.00469970703125, 0.003173828125
    for r, m in zip(p.knots[1:], p.dist[1:]):
        rd = r * m
        ru = rd * (1 + sc * (a * rd**2 + b * rd**4 + c * rd**6))
        assert abs(ru - r) < 1e-9
    assert lens_profile.parse_panasonic(0, 1.0, 0.1, 0.1, 0.1) is None  # switched off in the file


def _opcode(opcode_id: int, params: bytes) -> bytes:
    import struct

    return struct.pack(">IIII", opcode_id, 0x01030000, 0, len(params)) + params


def _opcode_list(*ops: bytes) -> bytes:
    import struct

    return struct.pack(">I", len(ops)) + b"".join(ops)


def test_parses_dng_warp_vignette_and_gain_maps():
    import struct

    warp = _opcode(1, struct.pack(">I", 1) + struct.pack(">6d", 0.99, 0.01, -0.003, 0.003, 0, 0) + struct.pack(">2d", 0.5, 0.5))
    vig = _opcode(3, struct.pack(">5d", 0.5, 0, 0, 0, 0) + struct.pack(">2d", 0.5, 0.5))
    gains = [1.0, 1.5, 1.5, 2.0]
    gmap = _opcode(9, struct.pack(">10I", 0, 0, 100, 200, 0, 1, 2, 2, 2, 2) + struct.pack(">4d", 1.0, 1.0, 0.0, 0.0)
                   + struct.pack(">I", 1) + struct.pack(">4f", *gains))
    radial, maps = lens_profile.parse_dng(_opcode_list(gmap), _opcode_list(warp, vig))
    assert radial is not None and len(maps) == 1
    assert abs(radial.dist[-1] - (0.99 + 0.01 - 0.003 + 0.003)) < 1e-12
    assert abs(radial.vig[-1] - 1 / 1.5) < 1e-12 and radial.ca_r[-1] == 0
    assert maps[0].rows == 2 and maps[0].gains == tuple(gains)
    assert lens_profile.parse_dng(None, None) == (None, ())
    # A truncated list is dropped, not read past its end.
    assert lens_profile.parse_dng(None, _opcode_list(warp)[:-9]) == (None, ())


def test_gain_maps_land_on_the_right_channel_and_orientation():
    """A red-site map (CFA RGGB, site 0,0) brightens only red, grows along the
    raw's rows, and follows LibRaw's 180-degree flip onto the decoded frame."""
    gm = lens_profile.GainMap(0, 0, 40, 60, 0, 1, 2, 2, 2, 1, 1.0, 1.0, 0.0, 0.0, 1, (1.0, 3.0))
    corr = lens_profile.Correction("dng", "Camera data", gain_maps=(gm,), raw_size=(60, 40), cfa=((0, 1), (1, 2)))
    arr = np.ones((40, 60, 3), dtype=np.float32)
    out = lens_profile.apply_gain_maps(arr, corr)
    assert np.allclose(out[..., 1:], 1.0) and out[0, 0, 0] < 1.1 and out[-1, 0, 0] > 2.9
    flipped = lens_profile.apply_gain_maps(arr, lens_profile.Correction(**{**corr.__dict__, "flip": 3}))
    assert flipped[0, 0, 0] > 2.9 and flipped[-1, 0, 0] < 1.1
    # A half-size decode covers the same raw area.
    half = lens_profile.apply_gain_maps(np.ones((20, 30, 3), np.float32), corr)
    assert half[0, 0, 0] < 1.1 and half[-1, 0, 0] > 2.8
    assert arr.max() == 1.0  # never modified in place


def test_lensfun_fills_in_for_files_without_camera_data():
    ref = lens_profile.find_lensfun_lens(
        "NIKON CORPORATION", "NIKON Z 6", ["NIKKOR Z 24-70mm f/4 S"], 52, 6.7, 0.88
    )
    assert ref is not None and ref.lens_model == "NIKKOR Z 24-70mm f/4 S"
    p = lens_profile.lensfun_profile(ref, 1.5)
    assert isinstance(p, lens_profile.RadialProfile)
    assert p.knots[0] == 0 and p.knots[-1] > 0.99
    assert all(b > a for a, b in zip(p.knots, p.knots[1:]))
    assert 1.0 < p.dist[-1] < 1.1  # this zoom's pincushion at 52mm
    assert p.vig and min(p.vig) < 0.9
    # An unknown lens gives no match rather than a wrong one.
    assert lens_profile.find_lensfun_lens("SONY", "ILCE-7M4", ["Totally Unknown 33mm F1.1"], 33, 1.1, None) is None
    # A compact's built-in lens, without a usable lens name.
    gr = lens_profile.find_lensfun_lens("RICOH IMAGING COMPANY, LTD.", "RICOH GR III", ["18.3mm F2.8"], 18.3, 5, None)
    assert gr is not None and "GR III" in gr.lens_model and " with " not in gr.lens_model


def test_camera_data_wins_over_lensfun(tmp_path: Path, monkeypatch):
    raw = tmp_path / "shot.ARW"
    raw.write_bytes(b"x")
    sony = {
        "EXIF:DistortionCorrParams": "16 " + " ".join(["10"] * 16),
        "EXIF:ChromaticAberrationCorrParams": "32 " + " ".join(["0"] * 32),
        "EXIF:VignettingCorrParams": "16 " + " ".join(["0"] * 16),
        "EXIF:Make": "SONY", "EXIF:Model": "ILCE-7M4", "EXIF:LensModel": "FE 50mm F2.5 G", "EXIF:FocalLength": 50,
    }
    monkeypatch.setattr(lens_profile, "_read_tags", lambda p: sony)
    lens_profile._cached_profile.cache_clear()
    corr = lens_profile.profile_for(raw)
    assert corr.source == "sony" and corr.label == "Camera data"
    monkeypatch.setattr(lens_profile, "_read_tags", lambda p: {k: v for k, v in sony.items() if "Corr" not in k})
    lens_profile._cached_profile.cache_clear()
    raw.write_bytes(b"xy")  # a new file version
    import os

    os.utime(raw, ns=(raw.stat().st_mtime_ns + 10**9, raw.stat().st_mtime_ns + 10**9))
    corr = lens_profile.profile_for(raw)
    assert corr.source == "lensfun" and corr.label.startswith("Lensfun: ")
    # JPEGs are never corrected, whatever their tags say.
    jpg = tmp_path / "shot.jpg"
    jpg.write_bytes(b"x")
    assert lens_profile.profile_for(jpg) is None
    lens_profile._cached_profile.cache_clear()


def test_a_radial_profile_corrects_like_the_fuji_tables():
    """The same barrel described both ways gives the same picture."""
    fuji = _profile(dist=-3.0)
    # Fuji: a source point at rs belongs at ro = rs / m, m = 1 + d/100 - so
    # in darktable's form the knot sits at ro and its multiplier is m.
    m = [1 + d / 100 for d in fuji.distortion]
    ro = [k / mm for k, mm in zip(fuji.knots, m)]
    n = len(ro)
    radial = lens_profile.RadialProfile(tuple(ro), tuple(m), (0.0,) * n, (0.0,) * n)
    ys, xs = np.mgrid[0:120, 0:180].astype(np.float32)
    arr = np.dstack([xs / 180, ys / 120, (xs + ys) / 300]).astype(np.float32)
    a = lens_profile.apply_profile(arr, fuji, 1.0, 0.0)
    b = lens_profile.apply_profile(arr, radial, 1.0, 0.0)
    assert np.abs(a - b).max() < 2e-3


def _structured(h: int, w: int) -> np.ndarray:
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    g = 0.5 + 0.3 * np.sin(xs / 7.0) * np.cos(ys / 5.0)
    return np.clip(np.dstack([g, g * 0.9 + 0.05, (xs + ys) / (h + w)]), 0.0, 1.0).astype(np.float16)


def test_a_window_is_the_same_pixels_as_the_whole_frame():
    """The editor's zoomed tiles correct only their own box (from a float16
    base, converting only the source rectangle the box reads). The box must
    come out as exactly the whole-frame correction's pixels there - at the
    corners and edges, where the remap replicates the frame border, too."""
    prof = _profile(dist=-3.0, ca=2e-3, vig=80.0)
    base = _structured(900, 1300)
    whole = lens_profile.apply_profile(base.astype(np.float32), prof, 1.0, 1.0)
    h, w = base.shape[:2]
    for box in [(0, 0, 200, 150), (500, 300, 900, 620), (w - 173, h - 91, w, h), (0, 400, w, 460), (0, 0, w, h)]:
        x0, y0, x1, y1 = box
        tile = lens_profile.apply_profile_window(base, prof, box, 1.0, 1.0)
        assert tile.dtype == np.float32
        assert np.array_equal(tile, whole[y0:y1, x0:x1]), box


def test_gain_maps_are_not_windowed(tmp_path: Path, monkeypatch):
    """DNG lens-shading maps run over the whole frame: correct_window says so
    (None) and the zoomed render takes the whole-frame path for them."""
    corr = lens_profile.Correction(source="dng", label="Camera data", gain_maps=(object(),))
    monkeypatch.setattr(lens_profile, "profile_for", lambda path: corr)
    adj = develop.normalize({})
    base = _structured(64, 96)
    assert not lens_profile.windowable(tmp_path / "x.dng", adj)
    assert lens_profile.correct_window(base, tmp_path / "x.dng", adj, (0, 0, 10, 10)) is None

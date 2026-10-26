"""Process version 8: the finishing passes measured against the camera.

Three promises. An edit on "7" or before renders exactly as it did (the old
code paths are untouched, checked against hashes taken before the change). On
"8" the grain follows Fujifilm's measured Grain Effect (tools/grain_reference),
clarity gains a broad band for midtone depth, and mist blooms around light
sources while the blacks stay deep. And a zoomed tile is still that part of
the whole render."""

import hashlib
import platform

import numpy as np
import pytest

from app.services import develop, develop_v2, thumbnails
from app.services.masks import FieldView


def _scene(h=360, w=480, seed=11) -> np.ndarray:
    """A linear frame with texture at several scales, a light source past
    white and a deep black patch - what every finishing pass reacts to."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    g = 0.04 + 0.5 * (0.5 + 0.5 * np.sin(xx / 23.0) * np.cos(yy / 17.0))
    g += 0.08 * np.sin((xx + yy) / 3.0)
    g[40:90, 60:120] = 2.5
    g[200:260, 300:420] = 0.005
    g = g * (1.0 + 0.05 * rng.standard_normal((h, w)).astype(np.float32))
    return np.clip(np.dstack([g, g * 0.9 + 0.02, g * 0.8 + 0.05]), 0.0, 4.0).astype(np.float32)


def _render(lin: np.ndarray, adj: dict, process: str, **kw) -> np.ndarray:
    full = develop.normalize({**adj, "process": process})
    return thumbnails.apply_adjustments_linear(lin.copy(), 1.0, full, array=True, **kw)


# ---- the old processes are untouched -----------------------------------------

# sha256 of the 8-bit render of _scene() on process "7", taken before any of
# the process-8 code existed (2026-10-26, arm64, numpy 2.5 / cv2 5.0).
_PROCESS_7_HASHES = {
    "grain": ("5e1e7f43170949d658d1838adc9d37fac4652dace5bf27d10490c4be19f6ec4a",
              {"grain_amount": 60, "grain_size": 40, "grain_roughness": 60}),
    "clarity_pos": ("9e9ac410110f365bc05280cf0f9878a5a13aa5052628f12cd88f4b69f759e5a6",
                    {"clarity": 65}),
    "clarity_neg": ("063a14f584bddc4f0554f05f93a324ab873f02fc491b89cf77a3d89e37585bf3",
                    {"clarity": -50}),
    "mist": ("3689e67a6211fe5f66796b99d47aadad73ad19d1f38f32871c5c4b38ec7a0bcb",
             {"mist": 40}),
    "all": ("2ba94b9d13f90e6efd74ad7fcbdfce8da679acecc5c7db234b80a592a51e94d1",
            {"grain_amount": 50, "clarity": 50, "mist": 30, "sharpness": 30}),
}


@pytest.mark.skipif(
    platform.machine() not in ("arm64", "aarch64"),
    reason="the reference hashes were taken on arm64; cv2 rounds 1 ulp differently on x86",
)
@pytest.mark.parametrize("case", sorted(_PROCESS_7_HASHES))
def test_a_process_7_render_is_the_picture_it_was_before(case):
    digest, adj = _PROCESS_7_HASHES[case]
    out = _render(_scene(), adj, "7")
    assert hashlib.sha256(out.tobytes()).hexdigest() == digest


@pytest.mark.parametrize(
    "adj",
    [{"grain_amount": 60, "grain_size": 40}, {"clarity": 65}, {"clarity": -50}, {"mist": 40}],
)
def test_process_8_renders_the_finishing_differently_and_only_the_finishing(adj):
    lin = _scene()
    assert np.abs(_render(lin, adj, "7").astype(int) - _render(lin, adj, "8").astype(int)).max() > 1
    plain = {"exposure": 0.3, "contrast": 15, "sharpness": 30, "vignette_amount": -20}
    assert np.array_equal(_render(lin, plain, "7"), _render(lin, plain, "8"))


# ---- grain --------------------------------------------------------------------

def _ramp(h=1200, w=2400) -> np.ndarray:
    """A grey wedge of 24 flat steps, each wider than any particle."""
    steps = 24
    ramp = np.repeat(np.linspace(0.0, 1.0, steps, dtype=np.float32), w // steps)
    return np.repeat(np.repeat(ramp[None, :], h, axis=0)[..., None], 3, axis=-1)


def test_fuji_grain_follows_the_measured_tone_curve():
    """Per luminance bin, the grain's spread on a grey wedge is the measured
    curve (thumbnails._FUJI_GRAIN_LUT) times the amplitude, within 10%."""
    arr = _ramp()
    out = thumbnails._apply_grain(arr, 66, 25, 50, fuji=True)
    noise = (out - arr)[..., 0]
    luma = arr[..., 0]
    expected_peak = 0.66 * thumbnails._FUJI_GRAIN_STRENGTH
    for b in range(12):
        lo, hi = b / 12.0, (b + 1) / 12.0
        # Steps at the ends of the wedge clip half their noise; stay inside.
        sel = (luma >= max(lo, 0.06)) & (luma < min(hi, 0.94))
        if sel.sum() < 10_000:
            continue
        want = expected_peak * float(np.interp(
            float(luma[sel].mean()), thumbnails._FUJI_GRAIN_X, thumbnails._FUJI_GRAIN_LUT
        ))
        got = float(noise[sel].std())
        assert abs(got - want) <= 0.10 * want, (b, got, want)
    # Amount 33 is the camera's Weak, 66 its Strong: twice the spread.
    weak = (thumbnails._apply_grain(arr, 33, 25, 50, fuji=True) - arr)[..., 0]
    mid = (luma > 0.3) & (luma < 0.45)
    assert 0.0215 < float(weak[mid].std()) < 0.0265  # measured Weak/Small: 0.0240
    assert 0.045 < float(noise[mid].std()) < 0.055  # measured Strong/Small: 0.0500


def test_fuji_grain_is_monochrome_and_sized_for_the_whole_photo(monkeypatch):
    arr = _ramp(h=200, w=600)
    out = thumbnails._apply_grain(arr, 50, 25, 50, fuji=True)
    d = out - arr
    assert np.array_equal(d[..., 0], d[..., 1]) and np.array_equal(d[..., 1], d[..., 2])
    asked = []

    def field(h, w, particle_px, coarse, shape, origin=(0, 0)):
        asked.append(particle_px)
        return np.zeros((h, w), dtype=np.float32)

    monkeypatch.setattr(thumbnails, "_cached_grain_field", field)
    whole = np.full((300, 6240, 3), 0.5, dtype=np.float32)
    thumbnails._apply_grain(whole, 30, 25, 50, fuji=True)
    thumbnails._apply_grain(whole[100:200, 150:300], 30, 25, 50, ref_long_edge=6240, fuji=True)
    thumbnails._apply_grain(whole, 30, 75, 50, fuji=True)
    # Small is the camera's pixel-level grain, 1.5px on a 6240px frame, and
    # the tile asks for the same; Large is about twice that.
    assert 1.5 <= asked[0] < 1.7
    assert asked[1] == asked[0]
    assert 2.9 < asked[2] < 3.4


def test_fuji_grain_stays_put_across_tiles_and_zoom():
    whole = np.full((300, 6000, 3), 0.5, dtype=np.float32)
    a = thumbnails._apply_grain(whole, 60, 50, 50, fuji=True)
    assert np.array_equal(a, thumbnails._apply_grain(whole, 60, 50, 50, fuji=True))
    tile = whole[100:220, 2300:2500]
    t = thumbnails._apply_grain(tile, 60, 50, 50, ref_long_edge=6000, origin=(2300, 100), fuji=True)
    assert np.abs(t - a[100:220, 2300:2500]).max() < 1e-3
    assert np.abs(a - whole).max() > 0.02


@pytest.mark.parametrize("x,y,w,h", [(0, 0, 90, 70), (150, 90, 120, 100), (230, 160, 90, 80)])
@pytest.mark.parametrize(
    "adj",
    [
        pytest.param({"grain_amount": 60, "grain_size": 50}, id="grain"),
        pytest.param({"clarity": 65}, id="clarity"),
        pytest.param({"clarity": 45, "sharpness": 40, "grain_amount": 40}, id="detail-and-grain"),
    ],
)
def test_a_process_8_tile_matches_the_whole_render(adj, x, y, w, h):
    """The region render on process 8 (test_editor_region_render's contract:
    two levels out of 255, no seam at the border)."""
    # Wide enough for the grain to be pinned to the frame's lattice (a 320px
    # frame is not: its particles would be under the lattice's cell floor, and
    # region_is_supported would send it whole-frame).
    ys, xs = np.mgrid[0:240, 0:4200].astype(np.float32)
    g = 0.5 + 0.35 * np.sin(xs / 9.0) * np.cos(ys / 7.0) + 0.1 * np.sin((xs + ys) / 3.0)
    arr = np.clip(np.dstack([g, g * 0.9 + 0.05, g * 0.8 + 0.1]), 0.0, 1.0)
    full_h, full_w = arr.shape[:2]
    full = develop.normalize({**adj, "process": "8"})
    assert thumbnails.region_is_supported(full, long_edge=full_w) or "clarity" in adj
    assert not thumbnails.region_is_supported(full, long_edge=320) or "clarity" in adj
    whole = thumbnails.apply_adjustments_linear(arr.copy(), 1.0, full, array=True).astype(int)
    pad = thumbnails.REGION_PAD_PX
    px0, py0 = max(0, x - pad), max(0, y - pad)
    px1, py1 = min(full_w, x + w + pad), min(full_h, y + h + pad)
    padded = thumbnails.apply_adjustments_linear(
        arr[py0:py1, px0:px1].copy(), 1.0, full, view=FieldView(px0, py0, full_w, full_h), array=True
    ).astype(int)
    tile = padded[y - py0 : y - py0 + h, x - px0 : x - px0 + w]
    diff = np.abs(whole[y : y + h, x : x + w] - tile)
    if "clarity" in adj and not thumbnails.region_is_supported(full, long_edge=full_w):
        pytest.skip("clarity on process 8 renders whole-frame when zoomed")
    assert diff.max() <= 2
    border = np.concatenate(
        [diff[:2].ravel(), diff[-2:].ravel(), diff[:, :2].ravel(), diff[:, -2:].ravel()]
    )
    assert border.max() <= max(2, diff[4:-4, 4:-4].max())


# ---- clarity --------------------------------------------------------------------

def _grating(period: float, h=600, w=2400, amp=0.08) -> np.ndarray:
    xx = np.arange(w, dtype=np.float32)
    y = 0.5 + amp * np.sin(2.0 * np.pi * xx / period)
    return np.repeat(np.repeat(y[None, :], h, axis=0)[..., None], 3, axis=-1).astype(np.float32)


def _gain(arr: np.ndarray, **kw) -> float:
    out = thumbnails._clarity(arr, 2400 / 50.0, 0.845, ref_long_edge=2400.0, **kw)
    before = (arr @ thumbnails._LUMA) - 0.5
    after = (out @ thumbnails._LUMA) - 0.5
    return float(after.std() / before.std()) - 1.0


def test_depth_clarity_lifts_broad_structure_more_than_fine():
    """+65 on sine gratings: the depth band's gain at a period of a tenth of
    the frame is clearly above the gain at a two-hundredth (the fine band's
    home), where the single-band pass hardly touched the broad one."""
    broad, fine = _gain(_grating(240.0), depth=True), _gain(_grating(12.0), depth=True)
    assert broad > fine * 1.2, (broad, fine)
    assert broad > 0.4
    assert _gain(_grating(240.0)) < broad * 0.6  # the single-band pass


def test_depth_clarity_keeps_hard_edges_free_of_halos():
    """A 0.25/0.75 step at +65: the depth band may not add more than 3/255 of
    overshoot over the single-band pass (measured 0.6/255), and the frame's
    ends of the tone scale are left alone by the knee."""
    h, w = 400, 2400
    y = np.where(np.arange(w)[None, :] < w // 2, 0.25, 0.75).astype(np.float32)
    y = np.repeat(y, h, axis=0)
    y[300:, :] = np.where(np.arange(w)[None, :] < w // 2, 0.02, 0.99).astype(np.float32)
    arr = np.repeat(y[..., None], 3, axis=-1).astype(np.float32)
    one = thumbnails._clarity(arr, w / 50.0, 0.845, ref_long_edge=float(w))
    two = thumbnails._clarity(arr, w / 50.0, 0.845, ref_long_edge=float(w), depth=True)
    over_one = np.abs((one @ thumbnails._LUMA) - y)[:300, w // 2 - 150 : w // 2 + 150].max() * 255
    over_two = np.abs((two @ thumbnails._LUMA) - y)[:300, w // 2 - 150 : w // 2 + 150].max() * 255
    assert over_two - over_one < 3.0, (over_one, over_two)
    # Deep black and near-white: the knee holds them.
    assert np.abs(two[300:] - arr[300:]).max() * 255 < 1.0


# ---- mist ------------------------------------------------------------------------

def _square(bg: float, h=800, w=1200) -> np.ndarray:
    arr = np.full((h, w, 3), bg, np.float32)
    arr[h // 2 - 40 : h // 2 + 40, w // 2 - 40 : w // 2 + 40] = 1.0
    return arr


def test_v8_mist_blooms_next_to_a_light_and_holds_the_blacks():
    """One bright square on black: the pixels next to it glow, the frame
    farther than a quarter of the width away does not move a level."""
    arr = _square(0.0)
    out = thumbnails._mist(arr, 40, ref_long_edge=1200.0, v8=True)
    d = (out @ thumbnails._LUMA) - (arr @ thumbnails._LUMA)
    yy, xx = np.mgrid[0:800, 0:1200]
    far = np.hypot(xx - 600, yy - 400) > 0.25 * 1200
    assert np.abs(d[far]).max() * 255 <= 1.0
    assert d[400, 645] * 255 > 5.0 and d[400, 660] > d[400, 700] > 0.0
    # The old mist veiled the far blacks about three times as much.
    old = thumbnails._mist(arr, 40, ref_long_edge=1200.0)
    assert np.abs(((old @ thumbnails._LUMA) - (arr @ thumbnails._LUMA))[far]).max() > 2.5 * np.abs(d[far]).max()


def test_v8_mist_conserves_light():
    """On a grey ground the scatter only moves light: the mean linear
    luminance changes by less than half a percent."""
    arr = _square(0.25)
    out = thumbnails._mist(arr, 40, ref_long_edge=1200.0, v8=True)
    lin = lambda a: develop_v2._srgb_to_linear(a) @ thumbnails._LUMA
    change = float(lin(out).mean() / lin(arr).mean()) - 1.0
    assert abs(change) < 0.005, change
    # ... and the bloom is there.
    assert ((out - arr) @ thumbnails._LUMA)[400, 645] * 255 > 5.0


def test_v8_mist_softens_the_frame():
    """The softness step: fine texture loses contrast across the frame, not
    only around the lights."""
    rng = np.random.default_rng(2)
    h, w = 600, 900
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    g = np.clip(0.5 + 0.2 * np.sin(xx / 2.0) * np.sin(yy / 2.0) + 0.02 * rng.standard_normal((h, w)), 0, 1)
    arr = np.repeat(g[..., None], 3, axis=-1).astype(np.float32)
    arr[20:60, 20:60] = 1.0  # something to scatter, far from the texture measured
    out = thumbnails._mist(arr, 40, ref_long_edge=float(w), v8=True)
    old = thumbnails._mist(arr, 40, ref_long_edge=float(w))
    import cv2

    def texture(a):
        y = (a @ thumbnails._LUMA).astype(np.float32)[300:, 300:]
        return float((y - cv2.GaussianBlur(y, (0, 0), 3.0)).std())

    # Measured: -4.5% at _MIST_SOFT_MAX 0.35 (the look as tuned); the bar is
    # well under that and above the 2% the old mist is allowed to move.
    assert texture(out) < texture(arr) * 0.97
    assert texture(old) > texture(arr) * 0.98

"""A mask's local pass runs on the box around what the mask covers, not on the
whole frame - a small radial mask on a 40MP frame used to tone, sharpen and
colour-grade every pixel and blend 99% of them back by zero.

What a user judges this on: the picture must be the one the whole-frame pass
made. Per-pixel passes are exactly that; the spatial ones (clarity, structure,
sharpening, process 2's local tone) read a neighbourhood and get the padding
they need, so they are within a level; dehaze reads the whole frame for its
atmospheric light and keeps the whole-frame pass."""

import numpy as np
import pytest

from app.services import thumbnails

H, W = 180, 240


def _scene() -> np.ndarray:
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    g = 0.5 + 0.3 * np.sin(xs / 9.0) * np.cos(ys / 7.0) + 0.08 * np.sin((xs + ys) / 3.0)
    return np.clip(np.dstack([g, g * 0.9 + 0.05, g * 0.8 + 0.1]), 0.0, 1.0)


def _mask(adjustments: dict, invert=False) -> dict:
    return {
        "id": "m1", "visible": True, "opacity": 100, "invert": invert,
        "sub_masks": [{"type": "radial", "mode": "additive", "visible": True,
                       "parameters": {"center_x": 0.3, "center_y": 0.4, "radius_x": 0.15,
                                      "radius_y": 0.18, "feather": 50}}],
        "adjustments": adjustments,
    }


def _render(adj: dict, box: bool, monkeypatch) -> np.ndarray:
    # The box path for every mask, or the whole-frame path for every mask.
    monkeypatch.setattr(thumbnails, "_MASK_BBOX_MAX_FRAC", 2.0 if box else 0.0)
    out, _ = thumbnails.apply_masks(_scene(), adj, ref_long_edge=float(W))
    return out


def test_a_tonal_mask_is_bit_identical_cropped_or_whole(monkeypatch):
    adj = {"process": "7", "masks": [_mask({"exposure": 0.8, "contrast": 25, "saturation": 30,
                                             "temperature": 40, "vibrance": 20})]}
    assert np.array_equal(_render(adj, True, monkeypatch), _render(adj, False, monkeypatch))


@pytest.mark.parametrize(
    "local",
    [
        pytest.param({"clarity": 50, "structure": 40, "sharpness": 60}, id="detail-passes"),
        pytest.param({"highlights": -60, "shadows": 70}, id="v2-local-tone"),
    ],
)
def test_a_spatial_mask_pass_matches_within_a_level(local, monkeypatch):
    adj = {"process": "7", "masks": [_mask(local)]}
    a = _render(adj, True, monkeypatch)
    b = _render(adj, False, monkeypatch)
    assert np.abs(a - b).max() <= 1.0 / 255.0 + 1e-6


def test_the_box_only_covers_the_mask(monkeypatch):
    """Pixels the mask does not touch come out exactly as they went in."""
    adj = {"process": "7", "masks": [_mask({"exposure": 1.0, "clarity": 50})]}
    scene = _scene()
    monkeypatch.setattr(thumbnails, "_MASK_BBOX_MAX_FRAC", 2.0)
    out, _ = thumbnails.apply_masks(scene, adj, ref_long_edge=float(W))
    assert np.array_equal(out[:, 170:], scene[:, 170:])  # far right of the disc
    assert not np.array_equal(out[72, 72], scene[72, 72])  # the disc's centre moved


def test_dehaze_takes_the_whole_frame_path(monkeypatch):
    seen: list[tuple[int, int]] = []
    real = thumbnails._apply_local_adjustments

    def spy(arr, *a, **k):
        seen.append(arr.shape[:2])
        return real(arr, *a, **k)

    monkeypatch.setattr(thumbnails, "_apply_local_adjustments", spy)
    monkeypatch.setattr(thumbnails, "_MASK_BBOX_MAX_FRAC", 2.0)
    thumbnails.apply_masks(_scene(), {"process": "7", "masks": [_mask({"dehaze": 40})]}, ref_long_edge=float(W))
    thumbnails.apply_masks(_scene(), {"process": "7", "masks": [_mask({"exposure": 0.5})]}, ref_long_edge=float(W))
    assert seen[0] == (H, W)
    assert seen[1][0] < H and seen[1][1] < W


def test_an_inverted_mask_covers_the_frame_and_keeps_the_whole_path(monkeypatch):
    seen: list[tuple[int, int]] = []
    real = thumbnails._apply_local_adjustments

    def spy(arr, *a, **k):
        seen.append(arr.shape[:2])
        return real(arr, *a, **k)

    monkeypatch.setattr(thumbnails, "_apply_local_adjustments", spy)
    thumbnails.apply_masks(_scene(), {"process": "7", "masks": [_mask({"exposure": 0.5}, invert=True)]}, ref_long_edge=float(W))
    assert seen == [(H, W)]


def test_the_callers_frame_is_never_written(monkeypatch):
    scene = _scene()
    before = scene.copy()
    monkeypatch.setattr(thumbnails, "_MASK_BBOX_MAX_FRAC", 2.0)
    thumbnails.apply_masks(scene, {"process": "7", "masks": [_mask({"exposure": 0.5}), _mask({"contrast": 40})]}, ref_long_edge=float(W))
    assert np.array_equal(scene, before)

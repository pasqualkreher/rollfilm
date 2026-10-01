"""Auto-straighten: the angle that levels a photo's horizon.

Found from the straight lines in the picture. Nearly every scene has some that
were level or plumb in the world - a horizon, a waterline, the edges of
buildings, door frames, poles - and they agree on one small tilt. Line
segments are gathered with OpenCV's LSD detector (it finds the soft line where
water meets sky, which an edge-threshold + Hough pass misses), each votes for
the tilt that would level it (horizontal lines directly, vertical ones by
their lean), long lines counting for more, and the angle most of that weight
agrees on wins.

Only small corrections are considered (_MAX_TILT): past that a line is far more
likely to be a diagonal in the scene than a tilted horizon. When no angle
gathers enough agreement the answer is None, and the editor says so rather
than turning the picture by a guess.
"""

from __future__ import annotations

import numpy as np
from PIL import Image as PILImage

_WORK_PX = 1200
_MAX_TILT = 7.0
_BIN = 0.25
# Segments shorter than this fraction of the long edge are texture, not lines.
_MIN_SEGMENT = 0.04
# Verticals count for less: a camera pointed up or down makes them converge,
# so each one leans by its own amount and only their average is plumb.
_VERTICAL_WEIGHT = 0.6
# The winning angle has to hold this share of the weight that voted - more
# when nothing horizontal backs it - and the lines that voted have to add up
# to this many frame widths.
_MIN_SHARE = 0.4
_MIN_SHARE_VERTICAL_ONLY = 0.5
_MIN_LENGTH = 1.0


def level_angle(image: PILImage.Image) -> float | None:
    """The Straighten value (clockwise degrees, see thumbnails.apply_edits)
    that levels `image`, or None when the picture has no clear answer."""
    import cv2

    gray = np.asarray(image.convert("L"))
    h, w = gray.shape
    scale = _WORK_PX / max(h, w)
    if scale < 1.0:
        gray = cv2.resize(gray, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
    long_edge = max(gray.shape)
    lines = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD).detect(np.ascontiguousarray(gray))[0]
    if lines is None:
        return None
    seg = lines.reshape(-1, 4).astype(np.float64)
    dx = seg[:, 2] - seg[:, 0]
    dy = seg[:, 3] - seg[:, 1]
    length = np.hypot(dx, dy)
    keep = length >= _MIN_SEGMENT * long_edge
    dx, dy, length = dx[keep], dy[keep], length[keep]
    # Tilt of each line, clockwise on screen (y runs down), folded to [-90, 90).
    theta = (np.degrees(np.arctan2(dy, dx)) + 90.0) % 180.0 - 90.0
    lean = np.where(theta > 0, theta - 90.0, theta + 90.0)  # tilt of a vertical
    horizontal = np.abs(theta) <= _MAX_TILT
    vertical = np.abs(lean) <= _MAX_TILT
    if (length[horizontal].sum() + length[vertical].sum()) < _MIN_LENGTH * long_edge:
        return None
    tilt = np.concatenate([theta[horizontal], lean[vertical]])
    is_horizontal = np.concatenate([np.ones(int(horizontal.sum()), bool), np.zeros(int(vertical.sum()), bool)])
    # One long line says more than the same length in fragments.
    weight = np.concatenate([length[horizontal] ** 1.5, length[vertical] ** 1.5 * _VERTICAL_WEIGHT])

    bins = int(round(2 * _MAX_TILT / _BIN)) + 1
    hist = np.zeros(bins)
    np.add.at(hist, np.clip(np.round((tilt + _MAX_TILT) / _BIN).astype(int), 0, bins - 1), weight)
    smooth = np.convolve(hist, np.array([1.0, 2.0, 3.0, 2.0, 1.0]) / 9.0, mode="same")
    peak = (int(np.argmax(smooth)) * _BIN) - _MAX_TILT
    near = np.abs(tilt - peak) <= 0.75
    share = weight[near].sum() / weight.sum()
    backed = weight[near & is_horizontal].sum() >= 0.1 * weight[near].sum()
    if share < (_MIN_SHARE if backed else _MIN_SHARE_VERTICAL_ONLY):
        return None
    measured = float(np.average(tilt[near], weights=weight[near]))
    # A line tilted clockwise is levelled by turning the picture the other way.
    angle = -round(measured / 0.25) * 0.25
    return float(angle) if abs(angle) >= 0.25 else 0.0

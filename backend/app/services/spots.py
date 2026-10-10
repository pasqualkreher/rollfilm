"""Spot heal / clone: the retouch list of an edit, rendered as patches.

A spot is a disc on the finished frame - placed in fractions of it, like a
mask (see masks.FieldView) - whose pixels are replaced by those of a second
disc, the source. `clone` copies the source as it is: texture, brightness and
colour. `heal` takes only the texture from the source and lays it onto the
brightness and colour of the spot's own surroundings: the source's low
frequencies are swapped for a smooth fill of the ring around the spot (the
blemish itself says nothing and is never read). A dust speck on a sky that
runs from deep blue to pale therefore vanishes without a step, where a clone
of a patch from elsewhere on that sky would show its own shade.

The patches are worked out on the scene-linear base, before the tone block,
so every pass after it (tone, colour, masks, grain) sees the healed picture
and none can leave a seam. The base itself is never written - it is a cached
array every render shares: render_patches reads it and hands back the
finished boxes, and the tone block pastes them into its own row-band copies
(thumbnails._linear_tone_block_banded).

Everything here is patch-sized - a spot of 100 px radius is a ~270x270 box -
so fifty spots cost a few milliseconds whatever the size of the frame.
"""

from __future__ import annotations

from typing import Callable, NamedTuple

import numpy as np

from app.services.masks import FieldView, _smoothstep

# The ring around a disc that heal reads its tone from, as a multiple of the
# radius. The box of a spot is cut this much larger than its disc so the ring
# is inside it.
_RING = 1.35

# Reads a box of the frame the view belongs to, at the view's scale: (x0, y0,
# x1, y1) in that frame's pixels, which may reach outside it, and returns
# exactly (y1-y0, x1-x0, 3) float32 pixels. A tile render passes one so a
# source that lies outside the tile can still be read (see
# thumbnails._render_editor_bytes); a whole-frame render reads the base.
Source = Callable[[int, int, int, int], np.ndarray]


class Patch(NamedTuple):
    """The finished pixels of one spot's box, in the pixels of the array the
    patches were rendered for (a whole frame or a tile)."""

    y0: int
    x0: int
    rgb: np.ndarray  # float32 HxWx3


def _disc(h: int, w: int, cx: float, cy: float, r: float, feather: float) -> np.ndarray:
    """Coverage of a disc of radius `r` px around (cx, cy) in a box of h x w:
    solid inside, ramping to 0 at the edge over `feather` percent of the
    radius - the same ramp a radial mask has (masks._radial_field)."""
    f = float(np.clip(feather / 100.0, 1e-3, 1.0))
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt((xs - np.float32(cx)) ** 2 + (ys - np.float32(cy)) ** 2) / np.float32(r)
    return _smoothstep((1.0 - d) / f).astype(np.float32), d


def take_from(
    h: int, w: int, read: Callable[[int, int, int, int], np.ndarray],
    x0: int, y0: int, x1: int, y1: int,
) -> np.ndarray:
    """The box (x0, y0, x1, y1) of an h x w frame as float32, read through
    `read(x0, y0, x1, y1)` for the part that lies inside the frame and filled
    by the nearest edge pixels past it - a source dragged over the border
    still reads something, and never raises."""
    sx0, sy0 = min(max(0, x0), w - 1), min(max(0, y0), h - 1)
    sx1, sy1 = max(sx0 + 1, min(w, x1)), max(sy0 + 1, min(h, y1))
    part = np.asarray(read(sx0, sy0, sx1, sy1), dtype=np.float32)
    top, left = sy0 - y0, sx0 - x0
    bottom, right = (y1 - y0) - part.shape[0] - top, (x1 - x0) - part.shape[1] - left
    if top or left or bottom or right:
        part = np.pad(part, ((top, bottom), (left, right), (0, 0)), mode="edge")
    return part


def _take(arr: np.ndarray, x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    """The box (x0, y0, x1, y1) of `arr`, edge-padded past it (take_from)."""
    h, w = arr.shape[:2]
    return take_from(h, w, lambda a, b, c, d: arr[b:d, a:c], x0, y0, x1, y1)


def render_patches(
    lin: np.ndarray, spots: list[dict], view: FieldView, source: Source | None = None,
) -> list[Patch]:
    """The patches of every spot that touches `lin` - a whole frame or the
    tile `view` describes - read from `lin` (the spot's own box) and from
    `source` or, without one, from `lin` again (the source box). The base is
    only read."""
    h, w = lin.shape[:2]
    long_edge = float(max(view.full_w, view.full_h))
    out: list[Patch] = []
    for s in spots:
        r = float(s["radius"]) * long_edge
        if r < 0.5:
            continue
        pad = int(np.ceil(r * _RING)) + 1
        cx = float(s["x"]) * view.full_w - view.x0
        cy = float(s["y"]) * view.full_h - view.y0
        x0, y0 = max(0, int(np.floor(cx)) - pad), max(0, int(np.floor(cy)) - pad)
        x1, y1 = min(w, int(np.ceil(cx)) + pad + 1), min(h, int(np.ceil(cy)) + pad + 1)
        if x1 <= x0 or y1 <= y0:
            continue
        cover, d = _disc(y1 - y0, x1 - x0, cx - x0, cy - y0, r, float(s.get("feather", 50)))
        opacity = float(s.get("opacity", 100)) / 100.0
        if opacity <= 0.0 or not cover.any():
            continue
        dst = np.asarray(lin[y0:y1, x0:x1], dtype=np.float32)
        # The source box: the spot's box moved by the source offset, in the
        # pixels of the whole frame the view belongs to.
        ox = int(round((float(s.get("src_x", s["x"])) - float(s["x"])) * view.full_w))
        oy = int(round((float(s.get("src_y", s["y"])) - float(s["y"])) * view.full_h))
        fx0, fy0 = x0 + view.x0 + ox, y0 + view.y0 + oy
        fx1, fy1 = fx0 + (x1 - x0), fy0 + (y1 - y0)
        if source is not None:
            src = np.asarray(source(fx0, fy0, fx1, fy1), dtype=np.float32)
        else:
            src = _take(lin, fx0 - view.x0, fy0 - view.y0, fx1 - view.x0, fy1 - view.y0)
        if src.shape != dst.shape:
            continue
        if s.get("kind") == "clone":
            healed = src
        else:
            healed = _heal(src, dst, d, r)
        a = (cover * np.float32(opacity))[..., None]
        out.append(Patch(y0, x0, dst * (1.0 - a) + healed * a))
    return out


def paste_scaled(small: np.ndarray, patches: list[Patch], sx: float, sy: float) -> None:
    """Write the patches into `small`, a copy of the frame scaled by (sx, sy):
    the surroundings map Highlights/Shadows read (develop_v2.LocalToneGuide)
    is built from such a copy, and must see the healed picture too, or a
    removed object would still lift or darken the pixels that replaced it."""
    import cv2

    sh, sw = small.shape[:2]
    for p in patches:
        ph, pw = p.rgb.shape[:2]
        x0, y0 = int(round(p.x0 * sx)), int(round(p.y0 * sy))
        x1, y1 = min(sw, int(round((p.x0 + pw) * sx))), min(sh, int(round((p.y0 + ph) * sy)))
        if x1 - x0 < 1 or y1 - y0 < 1:
            continue
        small[y0:y1, x0:x1] = cv2.resize(p.rgb, (x1 - x0, y1 - y0), interpolation=cv2.INTER_AREA)


def _heal(src: np.ndarray, dst: np.ndarray, d: np.ndarray, r: float) -> np.ndarray:
    """The source's texture on the spot's own lighting: `src` minus its smooth
    part, plus the smooth part of the spot's surroundings continued into the
    disc. The surroundings are the ring just outside the disc (`d` is the
    distance from the centre in radii); the blemish inside is left out of
    the fill entirely, so it cannot tint what replaces it. Smooth = a
    Gaussian of the radius, which follows a gradient across the spot and
    ignores detail - a spot has to be bigger than the blemish anyway."""
    import cv2

    ring = ((d > 1.0) & (d <= _RING)).astype(np.float32)
    if not ring.any():
        return src
    sigma = max(1.0, r * 0.75)
    # The low pass only needs the resolution of the spot, not of the pixels:
    # a big spot at native size is worked out on a copy a few dozen pixels
    # across, which keeps the blur the same cost at every size.
    h, w = src.shape[:2]
    scale = min(1.0, 24.0 / max(r, 1e-6))
    sw, sh = max(2, int(round(w * scale))), max(2, int(round(h * scale)))

    def down(a: np.ndarray) -> np.ndarray:
        return a if scale >= 1.0 else cv2.resize(a, (sw, sh), interpolation=cv2.INTER_AREA)

    def up(a: np.ndarray) -> np.ndarray:
        return a if scale >= 1.0 else cv2.resize(a, (w, h), interpolation=cv2.INTER_LINEAR)

    k = sigma * scale
    weight = down(ring)
    # Normalised convolution: the ring's colours, spread into the disc with
    # Gaussian weights, divided by how much ring each pixel saw.
    num = cv2.GaussianBlur(down(dst * ring[..., None]), (0, 0), k)
    den = cv2.GaussianBlur(weight, (0, 0), k)
    low_dst = up(num / np.maximum(den, 1e-4)[..., None])
    low_src = up(cv2.GaussianBlur(down(src), (0, 0), k))
    return np.maximum(src - low_src + low_dst, 0.0).astype(np.float32)


def any_in_rows(patches: list[Patch], y0: int, y1: int) -> bool:
    """Whether any patch has pixels in rows y0..y1 of the frame."""
    return any(p.y0 < y1 and p.y0 + p.rgb.shape[0] > y0 for p in patches)


def paste(rows: np.ndarray, patches: list[Patch], y0: int) -> None:
    """Write the patches into `rows`, which are rows y0.. of the frame the
    patches were rendered for (a copy of its own, never the base)."""
    n = rows.shape[0]
    for p in patches:
        a, b = max(p.y0, y0), min(p.y0 + p.rgb.shape[0], y0 + n)
        if b <= a:
            continue
        rows[a - y0 : b - y0, p.x0 : p.x0 + p.rgb.shape[1]] = p.rgb[a - p.y0 : b - p.y0]

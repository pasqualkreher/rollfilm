"""What an export does to a picture after it has been rendered and sized:
sharpening for the size and the medium it leaves for, a text watermark and
an image (logo) watermark - and the size itself (Size).

Both belong to the *output*, not to the photo: they are applied to the pixels
on their way into the exported file and never reach the editor, a cached
render or anything else in the library.
"""

import math
import os
from dataclasses import dataclass
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image as PILImage
from PIL import ImageDraw, ImageFont

# Unsharp-mask strength per setting. The radius stays under a pixel: output
# sharpening restores the crispness resizing took, it is not a look.
_SHARPEN_AMOUNT = {"low": 0.35, "standard": 0.6, "high": 0.9}
_SHARPEN_SIGMA = 0.8

# Per medium: (sigma, amount per setting). "screen" is the table above - what
# every export did before the medium could be chosen. Print loses crispness
# to the ink spreading into the paper, matte paper more than glossy, so both
# sharpen wider and harder; and a print's pixels are smaller the more of
# them it has, so their radius grows with the output size past the size of
# a 12-inch print at 300 ppi (and shrinks below it, within limits). A screen
# shows its pixels as they are, so its radius stays put.
_SHARPEN_MEDIA: dict[str, tuple[float, dict[str, float]]] = {
    "screen": (_SHARPEN_SIGMA, _SHARPEN_AMOUNT),
    "glossy": (1.0, {"low": 0.5, "standard": 0.8, "high": 1.1}),
    "matte": (1.2, {"low": 0.7, "standard": 1.05, "high": 1.4}),
}
_PRINT_REF_LONG_PX = 3600.0
_PRINT_SCALE_RANGE = (0.75, 2.0)

# The image watermark: its long side as a share of the picture's long edge is
# what the export asks for (in percent, clamped to this range); it sits a
# margin of this share of the short edge in from its corner.
_LOGO_SIZE_RANGE = (1.0, 100.0)
_LOGO_MARGIN = 0.03

# Height of the watermark's letters as a share of the picture's short edge,
# so it reads the same on a 1024 px web copy and a 40 MP original.
_WATERMARK_SIZE = {"small": 0.018, "medium": 0.028, "large": 0.042}
# Never wider than this share of the picture, however long the text.
_WATERMARK_MAX_WIDTH = 0.9


@dataclass(frozen=True)
class Finish:
    sharpen: str = "off"  # off | low | standard | high
    watermark: str = ""
    corner: str = "br"  # tl | tr | bl | br
    size: str = "medium"  # small | medium | large
    opacity: int = 60  # percent
    medium: str = "screen"  # screen | glossy | matte
    # The image watermark: a PNG (alpha honoured) at this path, empty = none.
    logo: str = ""
    logo_corner: str = "br"
    logo_size: float = 15.0  # percent of the picture's long edge
    logo_opacity: int = 80  # percent

    @property
    def active(self) -> bool:
        return self.sharpen in _SHARPEN_AMOUNT or bool(self.watermark.strip()) or bool(self.logo)


@dataclass(frozen=True)
class Size:
    """How big an export comes out. `value` is read by `fit`: the long or the
    short edge in pixels, the megapixels of the whole picture, or a percentage
    of its own size. `no_upscale` keeps a picture that is already smaller at
    the size it has."""

    fit: str = "long"  # long | short | megapixels | percent
    value: float | None = None
    no_upscale: bool = True

    def target_long(self, w: int, h: int) -> int | None:
        """The long edge, in pixels, a w x h picture is exported at - None
        for its own size."""
        if not self.value or self.value <= 0 or w <= 0 or h <= 0:
            return None
        long_edge, short_edge = max(w, h), min(w, h)
        if self.fit == "short":
            target = self.value * long_edge / short_edge
        elif self.fit == "megapixels":
            target = long_edge * math.sqrt(self.value * 1e6 / (long_edge * short_edge))
        elif self.fit == "percent":
            target = long_edge * self.value / 100.0
        else:
            target = self.value
        target = max(1, int(round(target)))
        if target == long_edge or (self.no_upscale and target > long_edge):
            return None
        return target

    def cap(self) -> int | None:
        """The long edge a render may be asked for up front, before its size
        is known (the decode economy of a sized export): only a long-edge fit
        says it without the picture."""
        if self.fit == "long" and self.value and self.value > 0:
            return max(1, int(round(self.value)))
        return None


def resize_array(arr: np.ndarray, size: Size | None) -> np.ndarray:
    """`arr` (8- or 16-bit RGB) at the size `size` asks for; `arr` itself
    when that is the size it has. Area averaging down, Lanczos up."""
    if size is None:
        return arr
    h, w = arr.shape[:2]
    target = size.target_long(w, h)
    if target is None:
        return arr
    scale = target / max(w, h)
    dims = (max(1, round(w * scale)), max(1, round(h * scale)))
    return cv2.resize(arr, dims, interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LANCZOS4)


def resize_image(im: PILImage.Image, size: Size | None) -> PILImage.Image:
    """The PIL form of resize_array, Lanczos both ways (what the JPEG export
    has always sized with)."""
    if size is None:
        return im
    w, h = im.size
    target = size.target_long(w, h)
    if target is None:
        return im
    scale = target / max(w, h)
    return im.resize((max(1, round(w * scale)), max(1, round(h * scale))), PILImage.LANCZOS)


def _sharpen_params(finish: Finish, shape: tuple[int, ...]) -> tuple[float, float] | None:
    """(sigma, amount) of the output sharpening for this picture, or None."""
    sigma, amounts = _SHARPEN_MEDIA.get(finish.medium, _SHARPEN_MEDIA["screen"])
    amount = amounts.get(finish.sharpen)
    if not amount:
        return None
    if finish.medium in ("glossy", "matte"):
        lo, hi = _PRINT_SCALE_RANGE
        sigma *= min(hi, max(lo, max(shape[:2]) / _PRINT_REF_LONG_PX))
    return sigma, amount


def apply(arr: np.ndarray, finish: Finish | None) -> np.ndarray:
    """`arr` (RGB, 8- or 16-bit) with the finish applied. Returns `arr` itself
    when there is nothing to do, a new array otherwise - the input is never
    written to, it may be a frame someone else still shows."""
    if finish is None or not finish.active:
        return arr
    out = arr
    params = _sharpen_params(finish, arr.shape)
    if params:
        sigma, amount = params
        # In the picture's own integer type: saturating, and no float copy of
        # a 40 MP frame on a machine that has 8 GB.
        blurred = cv2.GaussianBlur(out, (0, 0), sigma)
        out = cv2.addWeighted(out, 1.0 + amount, blurred, -amount, 0)
    text = finish.watermark.strip()
    if text:
        if out is arr:
            out = arr.copy()
        _draw_watermark(out, text, finish)
    if finish.logo:
        logo = load_logo(finish.logo)
        if logo is not None:
            if out is arr:
                out = arr.copy()
            _draw_logo(out, logo, finish)
    return out


def load_logo(path: str) -> np.ndarray | None:
    """The watermark image as 8-bit RGBA, or None when it cannot be read.
    Kept per path and modification time: an export of 500 photos reads it
    once."""
    try:
        mtime = os.stat(path).st_mtime_ns
    except OSError:
        return None
    return _load_logo(path, mtime)


@lru_cache(maxsize=4)
def _load_logo(path: str, mtime_ns: int) -> np.ndarray | None:
    try:
        with PILImage.open(path) as im:
            return np.asarray(im.convert("RGBA")).copy()
    except Exception:
        return None


def _draw_logo(arr: np.ndarray, logo: np.ndarray, finish: Finish) -> None:
    """The logo, its long side `logo_size` percent of the picture's long edge,
    in its corner, its own alpha times `logo_opacity` - blended into `arr` in
    place, in the picture's bit depth."""
    h, w = arr.shape[:2]
    lo, hi = _LOGO_SIZE_RANGE
    share = min(hi, max(lo, float(finish.logo_size))) / 100.0
    lh, lw = logo.shape[:2]
    scale = share * max(w, h) / max(lh, lw)
    margin = round(min(w, h) * _LOGO_MARGIN)
    # Never bigger than the picture leaves room for inside its margins.
    scale = min(scale, max(1, w - 2 * margin) / lw, max(1, h - 2 * margin) / lh)
    mw, mh = max(1, round(lw * scale)), max(1, round(lh * scale))
    sized = np.asarray(
        PILImage.fromarray(logo, "RGBA").resize((mw, mh), PILImage.LANCZOS), dtype=np.float32
    ) / 255.0
    x = margin if finish.logo_corner in ("tl", "bl") else w - mw - margin
    y = margin if finish.logo_corner in ("tl", "tr") else h - mh - margin
    x, y = max(0, min(x, w - mw)), max(0, min(y, h - mh))
    mw, mh = min(mw, w - x), min(mh, h - y)
    sized = sized[:mh, :mw]
    top = float(np.iinfo(arr.dtype).max)
    alpha = sized[..., 3:4] * (max(0, min(100, finish.logo_opacity)) / 100.0)
    region = arr[y : y + mh, x : x + mw].astype(np.float32)
    region = region * (1.0 - alpha) + sized[..., :3] * top * alpha
    arr[y : y + mh, x : x + mw] = np.clip(region + 0.5, 0, top).astype(arr.dtype)


def _text_mask(text: str, letter_px: int, max_width: int) -> np.ndarray:
    """The text as an 8-bit coverage mask, shrunk until it fits `max_width`."""
    while True:
        font = ImageFont.load_default(size=letter_px)
        left, top, right, bottom = font.getbbox(text)
        if right - left <= max_width or letter_px <= 8:
            break
        letter_px = max(8, int(letter_px * max_width / (right - left)))
    mask = PILImage.new("L", (max(1, right - left), max(1, bottom - top)), 0)
    ImageDraw.Draw(mask).text((-left, -top), text, fill=255, font=font)
    return np.asarray(mask)


def _draw_watermark(arr: np.ndarray, text: str, finish: Finish) -> None:
    """White text with a soft dark edge - readable on a bright sky and on a
    dark street alike - blended into `arr` in place."""
    h, w = arr.shape[:2]
    letter_px = max(10, round(min(w, h) * _WATERMARK_SIZE.get(finish.size, _WATERMARK_SIZE["medium"])))
    mask = _text_mask(text, letter_px, int(w * _WATERMARK_MAX_WIDTH))
    # Room around the letters for the soft edge, which reaches past them.
    pad = max(2, letter_px // 5)
    mask = np.pad(mask, pad)
    mh, mw = mask.shape
    mh, mw = min(mh, h), min(mw, w)
    mask = mask[:mh, :mw]
    margin = letter_px
    x = margin if finish.corner in ("tl", "bl") else w - mw - margin
    y = margin if finish.corner in ("tl", "tr") else h - mh - margin
    x, y = max(0, min(x, w - mw)), max(0, min(y, h - mh))

    strength = max(0, min(100, finish.opacity)) / 100.0
    cover = mask.astype(np.float32) / 255.0
    edge = cv2.GaussianBlur(cover, (0, 0), max(1.0, letter_px * 0.08))
    white = float(np.iinfo(arr.dtype).max)
    region = arr[y : y + mh, x : x + mw].astype(np.float32)
    region *= 1.0 - (edge * strength * 0.5)[..., None]
    alpha = (cover * strength)[..., None]
    region = region * (1.0 - alpha) + white * alpha
    arr[y : y + mh, x : x + mw] = np.clip(region + 0.5, 0, white).astype(arr.dtype)

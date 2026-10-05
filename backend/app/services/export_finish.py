"""What an export does to a picture after it has been rendered and sized:
sharpening for the size it leaves at, and a text watermark.

Both belong to the *output*, not to the photo: they are applied to the pixels
on their way into the exported file and never reach the editor, a cached
render or anything else in the library.
"""

from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image as PILImage
from PIL import ImageDraw, ImageFont

# Unsharp-mask strength per setting. The radius stays under a pixel: output
# sharpening restores the crispness resizing took, it is not a look.
_SHARPEN_AMOUNT = {"low": 0.35, "standard": 0.6, "high": 0.9}
_SHARPEN_SIGMA = 0.8

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

    @property
    def active(self) -> bool:
        return self.sharpen in _SHARPEN_AMOUNT or bool(self.watermark.strip())


def apply(arr: np.ndarray, finish: Finish | None) -> np.ndarray:
    """`arr` (RGB, 8- or 16-bit) with the finish applied. Returns `arr` itself
    when there is nothing to do, a new array otherwise - the input is never
    written to, it may be a frame someone else still shows."""
    if finish is None or not finish.active:
        return arr
    out = arr
    amount = _SHARPEN_AMOUNT.get(finish.sharpen)
    if amount:
        # In the picture's own integer type: saturating, and no float copy of
        # a 40 MP frame on a machine that has 8 GB.
        blurred = cv2.GaussianBlur(out, (0, 0), _SHARPEN_SIGMA)
        out = cv2.addWeighted(out, 1.0 + amount, blurred, -amount, 0)
    text = finish.watermark.strip()
    if text:
        if out is arr:
            out = arr.copy()
        _draw_watermark(out, text, finish)
    return out


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

"""Semantic segmentation for "select the sky / the water / the greenery" masks.

SegFormer fine-tuned on ADE20K, whose 150 classes cover exactly the things a
photographer wants to select by name - sky, water in all its forms, vegetation,
people, buildings, ground. The weights are fetched on first use into the same
model cache as the CLIP model (see :mod:`app.services.embeddings`), so nothing
ships in the app bundle.

This runs once per mask, never per rendered frame: the result is stored in the
sub-mask as a small PNG (see masks._semantic_field), so a few seconds of model
time buys a mask that then costs nothing to render. That's why the default is
the accurate B4 variant rather than the fast one - at the roofline of a
building, B0 bleeds several pixels of sky over the roof and B4 does not, and
being right matters more than being quick for something you do once.

Two details do most of the quality work:

- The image goes in at its own aspect ratio. The stock image processor resizes
  to a square, which squashes a 3:2 photo before the model ever sees it; the
  boundary that comes back is visibly worse for it.
- Probabilities are taken at the logit resolution and only the *selected*
  classes are upsampled. Interpolating all 150 class channels to a full-size
  frame first is the obvious way to write this and costs gigabytes - 150
  channels of a 2048x1365 float32 frame is 1.7GB, twice over.

The field is soft, not a hard label map: the class probability straight from
the softmax already fades where the model is unsure (haze at the horizon,
branches against sky), which is what a mask wants. Argmax would give a hard,
aliased edge instead.
"""

from __future__ import annotations

import base64
import io
import logging
import threading
from collections import OrderedDict

import numpy as np
from PIL import Image as PILImage

from app.config import settings

logger = logging.getLogger(__name__)

# What the editor offers, in terms of ADE20K class *labels*. Matching by label
# rather than by index keeps this readable and survives a model swap - the ids
# are resolved against the checkpoint's own id2label map at load time, and a
# label that isn't in the checkpoint is simply skipped.
#
# Several ADE20K classes make up one photographic subject: "water" alone misses
# the sea and the river, "tree" alone misses the grass in front of it. The
# groups below are unions, summed in probability space.
CLASS_GROUPS: dict[str, tuple[str, ...]] = {
    "sky": ("sky",),
    "water": ("water", "sea", "river", "lake", "waterfall", "swimming pool"),
    "greenery": ("tree", "grass", "plant", "flower", "palm"),
    "person": ("person",),
    "building": ("building", "house", "skyscraper", "wall", "hovel"),
    "ground": ("earth", "road", "sand", "field", "path", "dirt track", "land"),
}

# Long edges the model sees. Two passes, combined per pixel by taking whichever
# saw the subject more strongly.
#
# One scale is not enough, and not because of detail: a semantic model finds
# what it was trained to find at the size it was trained on, so the working
# resolution decides which subjects it can see at all. Measured on real frames,
# a group of people at the far end of a room scores 0.07 at 512px and 0.92 at
# 2048px - while people filling half the frame go the other way, 0.39 down to
# 0.11. Neither scale alone finds both. Taking the stronger of two scales finds
# each subject at the size that suits it, and (measured) doesn't invent
# subjects that aren't there: a photo with no people stays at 0.04.
#
# Two scales is also where the cost sits: the pass at the larger scale is a
# couple of seconds and a couple of GB of transient activations on the B4
# checkpoint, which is why this runs once per frame behind a lock and every
# subject after the first comes out of the cache.
_INFER_SCALES = (768, 1152)
# Below this peak probability, nothing in the frame really looks like the
# subject and the editor says so rather than adding a mask made of noise.
FOUND_PEAK = 0.25
# Long edge of the stored mask - the resolution a mask is kept and re-rendered
# at. Beyond this the PNG grows faster than the mask improves; the render path
# snaps the upsampled edge back onto the image anyway (masks._refine_to_edges).
STORED_MASK_PX = 768
# SegFormer's patch/stride grid. An input that isn't a multiple of this gets
# padded internally, which shifts the output grid off the image.
_ALIGN = 32

_model = None
_norm: tuple[np.ndarray, np.ndarray] | None = None
_label_ids: dict[str, tuple[int, ...]] = {}
_model_lock = threading.Lock()


class SegmentationUnavailable(RuntimeError):
    """The model could not be loaded (no `transformers`, or no way to fetch the
    weights on first use)."""


def _load():
    global _model, _norm, _label_ids
    # Like the CLIP loader: several request threads can reach for the model at
    # once on first use, and without the lock each would start its own download.
    if _model is None:
        with _model_lock:
            if _model is None:
                try:
                    from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor
                except ImportError as exc:  # pragma: no cover - depends on the install
                    raise SegmentationUnavailable("transformers is not installed") from exc
                cache = str(settings.model_cache_root)
                name = settings.segmentation_model_name
                try:
                    model = SegformerForSemanticSegmentation.from_pretrained(name, cache_dir=cache)
                    # Only for its normalisation constants - the resizing it
                    # would do is exactly what we're avoiding.
                    proc = SegformerImageProcessor.from_pretrained(name, cache_dir=cache)
                except Exception as exc:
                    raise SegmentationUnavailable(str(exc)) from exc
                model.eval()
                # Resolve each group's labels to checkpoint class ids once.
                by_label = {str(v).strip().lower(): int(k) for k, v in model.config.id2label.items()}
                resolved: dict[str, tuple[int, ...]] = {}
                for group, labels in CLASS_GROUPS.items():
                    ids = tuple(by_label[l] for l in labels if l in by_label)
                    if ids:
                        resolved[group] = ids
                    else:
                        logger.warning("Segmentation group %r matched no class in %s", group, name)
                _norm = (
                    np.array(proc.image_mean, dtype=np.float32),
                    np.array(proc.image_std, dtype=np.float32),
                )
                _label_ids = resolved
                _model = model
    return _model, _norm, _label_ids


def _model_input(image: PILImage.Image, long_px: int, mean: np.ndarray, std: np.ndarray):
    """The image as a normalised (1, 3, h, w) tensor at `long_px` on its long
    edge, aspect ratio kept and both sides aligned to the model's grid."""
    import torch

    scale = long_px / max(image.size)
    w = max(_ALIGN, int(round(image.width * scale / _ALIGN)) * _ALIGN)
    h = max(_ALIGN, int(round(image.height * scale / _ALIGN)) * _ALIGN)
    arr = np.asarray(image.resize((w, h), PILImage.BICUBIC), dtype=np.float32) / 255.0
    arr = (arr - mean) / std
    return torch.from_numpy(np.ascontiguousarray(arr.transpose(2, 0, 1)[None]))


def _segment_all(image: PILImage.Image, max_px: int) -> dict[str, tuple[np.ndarray, float]]:
    """Every subject's field, plus how strongly the model saw it, from one pass
    per scale. Clicking Sky and then Greenery on the same photo is the normal
    way this gets used, and the passes are all of the cost - the per-group part
    is a channel sum."""
    import torch

    model, norm, label_ids = _load()
    assert norm is not None
    src = image.convert("RGB")
    scale = min(1.0, max_px / max(src.size))
    out_w = max(1, round(src.width * scale))
    out_h = max(1, round(src.height * scale))
    stacked: dict[str, torch.Tensor] = {}
    with torch.no_grad():
        for long_px in _INFER_SCALES:
            logits = model(pixel_values=_model_input(src, long_px, *norm)).logits
            # Softmax at the head's own resolution, then upsample only the
            # classes actually asked for - see the note at the top about not
            # carrying all 150 channels up to frame size.
            prob = torch.softmax(logits, dim=1)[0]
            for group, ids in label_ids.items():
                field = prob[list(ids)].sum(dim=0).clamp(0.0, 1.0)
                field = torch.nn.functional.interpolate(
                    field[None, None], size=(out_h, out_w), mode="bilinear", align_corners=False
                )[0, 0]
                prev = stacked.get(group)
                stacked[group] = field if prev is None else torch.maximum(prev, field)

    out: dict[str, tuple[np.ndarray, float]] = {}
    for group, field in stacked.items():
        arr = field.numpy().astype(np.float32)
        peak = float(arr.max())
        # Rescale so the model's own strongest evidence is a full-strength
        # selection. A distant person peaks around 0.4 even when it is
        # unmistakably a person, and leaving that as-is would silently apply
        # every local adjustment at 40% - the mask would read as "not working"
        # rather than as "found, weakly". Confident subjects (sky peaks at 1.0)
        # are untouched, and a peak too low to be a find isn't stretched at all.
        if peak >= FOUND_PEAK:
            arr = np.clip(arr / peak, 0.0, 1.0)
        out[group] = (arr, peak)
    return out


# The last couple of analysed frames, so picking a second subject is instant.
# One entry is six small fields (a few MB), not the model's activations.
_RESULT_CACHE: OrderedDict[str, dict[str, tuple[np.ndarray, float]]] = OrderedDict()
_RESULT_CACHE_MAX = 2
_result_lock = threading.Lock()


def segment(
    image: PILImage.Image, group: str, cache_key: str | None = None, max_px: int = STORED_MASK_PX
) -> tuple[np.ndarray, float]:
    """The `group` field (h, w) float32 0..1 at `max_px` on the long edge with
    the input's aspect ratio, plus the model's peak confidence *before* the
    field was rescaled - which is what says whether the subject is there at all
    (see FOUND_PEAK).

    `cache_key` must identify the exact frame handed in (image + geometry): give
    one and a second subject on the same frame skips the model entirely."""
    if group not in CLASS_GROUPS:
        raise SegmentationUnavailable(f"unknown segmentation group {group!r}")
    key = f"{cache_key}|{max_px}" if cache_key else None
    if key:
        with _result_lock:
            hit = _RESULT_CACHE.get(key)
            if hit is not None:
                _RESULT_CACHE.move_to_end(key)
                if group in hit:
                    return hit[group]
    fields = _segment_all(image, max_px)
    if key:
        with _result_lock:
            _RESULT_CACHE[key] = fields
            _RESULT_CACHE.move_to_end(key)
            while len(_RESULT_CACHE) > _RESULT_CACHE_MAX:
                _RESULT_CACHE.popitem(last=False)
    if group not in fields:
        raise SegmentationUnavailable(f"{group!r} matched no class in the model")
    return fields[group]


def encode_mask_png(field: np.ndarray) -> tuple[str, int, int]:
    """A 0..1 field as a base64 8-bit grayscale PNG, plus its size."""
    img = PILImage.fromarray(np.clip(field * 255.0 + 0.5, 0, 255).astype(np.uint8), mode="L")
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii"), img.width, img.height

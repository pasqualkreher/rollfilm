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
import os
import threading
from collections import OrderedDict

import numpy as np
from PIL import Image as PILImage

from app.config import settings

logger = logging.getLogger(__name__)

# Apple's GPU runs this model about four times faster than the CPU does, and -
# measured on real frames, all six subjects - returns bit-identical fields, so
# there is no quality trade to weigh. float16 is NOT worth having: on MPS it
# measured five times SLOWER than float32 (unsupported ops fall back to the CPU
# one kernel at a time), which is why this stays float32 throughout.
#
# The fallback flag has to be set before torch is imported. Nothing in this
# module imports it at module scope (see the note at the top of embeddings.py
# about why), so this is early enough - and it turns an op the MPS backend
# doesn't implement into a slow op rather than a failed mask.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

# Set PM_TORCH_DEVICE=cpu to pin segmentation to the CPU (a machine where the
# GPU is needed elsewhere, or to rule the GPU out when a mask looks wrong).
_DEVICE_OVERRIDE = os.environ.get("PM_TORCH_DEVICE", "").strip().lower()

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
_device = "cpu"
_model_lock = threading.Lock()


def _from_cache(name: str, cache: str, local_only: bool):
    """The model and its image processor (wanted only for its normalisation
    constants - the resizing it would do is exactly what we're avoiding)."""
    from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor

    model = SegformerForSemanticSegmentation.from_pretrained(
        name, cache_dir=cache, local_files_only=local_only
    )
    proc = SegformerImageProcessor.from_pretrained(
        name, cache_dir=cache, local_files_only=local_only
    )
    return model, proc


def _select_device(model):
    """Move the model to the fastest device that actually works here.

    The GPU is proven with a real forward pass rather than trusted: a driver
    that reports MPS as available but then throws on one of SegFormer's ops
    would otherwise turn every mask into a 500. The dummy pass doubles as a
    warm-up - the first MPS run of a shape pays for compiling its kernels
    (measured 4.2s against 1.4s once warm), and paying that here means the
    user's first mask doesn't."""
    import torch

    if _DEVICE_OVERRIDE == "cpu":
        return model, "cpu"
    if _DEVICE_OVERRIDE not in ("", "mps") or not torch.backends.mps.is_available():
        return model, "cpu"
    try:
        moved = model.to("mps")
        with torch.inference_mode():
            moved(pixel_values=torch.zeros(1, 3, _ALIGN * 4, _ALIGN * 4, device="mps"))
        return moved, "mps"
    except Exception:
        logger.warning("Segmentation on the GPU failed a test pass; using the CPU", exc_info=True)
        return model.to("cpu"), "cpu"


class SegmentationUnavailable(RuntimeError):
    """The model could not be loaded (no `transformers`, or no way to fetch the
    weights on first use)."""


def _load():
    global _model, _norm, _label_ids, _device
    # Like the CLIP loader: several request threads can reach for the model at
    # once on first use, and without the lock each would start its own download.
    if _model is None:
        with _model_lock:
            if _model is None:
                try:
                    import transformers  # noqa: F401
                except ImportError as exc:  # pragma: no cover - depends on the install
                    raise SegmentationUnavailable("transformers is not installed") from exc
                cache = str(settings.model_cache_root)
                name = settings.segmentation_model_name
                # Weights already on disk: load them without asking the hub
                # whether they're current. That revalidation is three HTTP
                # round-trips on the way to the user's first mask, and it makes
                # a load on a flaky connection wait for a timeout to answer a
                # question whose answer we don't act on anyway. Only the very
                # first load (nothing cached) goes to the network.
                try:
                    model, proc = _from_cache(name, cache, local_only=True)
                except Exception:
                    try:
                        model, proc = _from_cache(name, cache, local_only=False)
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
                model, device = _select_device(model)
                _device = device
                logger.info("Segmentation model %s ready on %s", name, device)
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
    # Softmax, the per-group sum and the upsample all stay on whichever device
    # the model is on - they're small next to the forward pass, and moving the
    # 150-channel logits back to the CPU to do them would cost more than they do.
    with torch.inference_mode():
        for long_px in _INFER_SCALES:
            pixel_values = _model_input(src, long_px, *norm).to(_device)
            logits = model(pixel_values=pixel_values).logits
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
        arr = field.cpu().numpy().astype(np.float32)
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


def weights_are_cached() -> bool:
    """Whether the checkpoint is already on disk.

    A *speculative* pass must never be what fetches it: opening the Masks panel
    out of curiosity on a fresh install would otherwise start a ~250MB download
    in the background. Asking for an actual subject still downloads it, exactly
    as before - that's a user who has said they want this."""
    folder = "models--" + settings.segmentation_model_name.replace("/", "--")
    try:
        return (settings.model_cache_root / folder).is_dir()
    except OSError:
        return False


def is_cached(cache_key: str, max_px: int = STORED_MASK_PX) -> bool:
    """Whether this exact frame has already been through the model - so a
    speculative pass can skip work the user's own click already paid for."""
    with _result_lock:
        return f"{cache_key}|{max_px}" in _RESULT_CACHE


def encode_mask_png(field: np.ndarray) -> tuple[str, int, int]:
    """A 0..1 field as a base64 8-bit grayscale PNG, plus its size."""
    img = PILImage.fromarray(np.clip(field * 255.0 + 0.5, 0, 255).astype(np.uint8), mode="L")
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii"), img.width, img.height

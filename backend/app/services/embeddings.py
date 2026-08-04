import logging
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np
import sqlite_vec
from PIL import Image as PILImage
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.config import settings

logger = logging.getLogger(__name__)

# torch and open_clip are imported lazily inside the functions that need them
# (see _get_model / encode_*). They pull in hundreds of MB across thousands of
# files, so importing them at module load would block backend startup for many
# seconds - and much longer if the virtualenv sits on throttled storage (a
# cloud-synced folder). Keeping them out of the import path lets the API serve
# /health immediately; the CLIP model loads only when semantic search or an
# import embedding actually runs, on a background worker thread.

EMBEDDING_DIM = 512

# Long-edge target when decoding a derivative JPEG for encoding. CLIP's input
# is 224px, so decoding the up-to-2600px preview.jpg at full resolution only
# to resize it away dominated embedding time; 2x the model input leaves the
# preprocess downsample enough headroom to stay sharp.
_ENCODE_DECODE_PX = 448


def open_for_encoding(path: Path) -> PILImage.Image:
    """Open a rendered derivative JPEG at a reduced DCT scale for encode_image.

    draft() makes libjpeg decode at 1/2, 1/4 or 1/8 scale directly - a fraction
    of a full decode. The draft box is scaled to the image's aspect ratio so
    the *long* edge lands near _ENCODE_DECODE_PX (a square box would gate on
    the short edge and barely reduce a wide photo). Derivatives are rendered
    with orientation baked in, so no exif_transpose is needed here."""
    im = PILImage.open(path)
    w, h = im.size
    long_edge = max(w, h)
    if long_edge > _ENCODE_DECODE_PX:
        scale = _ENCODE_DECODE_PX / long_edge
        im.draft("RGB", (max(1, round(w * scale)), max(1, round(h * scale))))
    return im.convert("RGB")

_model = None
_preprocess = None
_tokenizer = None
_model_lock = threading.Lock()


def _get_model():
    global _model, _preprocess, _tokenizer
    # The post-import worker pool has multiple threads that can all reach for
    # the model at once on first use - without the lock they'd race and each
    # kick off their own multi-hundred-MB download/load.
    if _model is None:
        with _model_lock:
            if _model is None:
                import open_clip

                model, _, preprocess = open_clip.create_model_and_transforms(
                    settings.clip_model_name,
                    pretrained=settings.clip_model_pretrained,
                    cache_dir=str(settings.model_cache_root),
                )
                model.eval()
                _model = model
                _preprocess = preprocess
                _tokenizer = open_clip.get_tokenizer(settings.clip_model_name)
    return _model, _preprocess, _tokenizer


def warm_up() -> bool:
    """Load the model now, off the request path. Returns whether it's ready.

    The forward passes themselves are not the wait: a text query measures 13ms
    once the model is up, against 4.3s to import open_clip and build it. That
    load is the whole of "the first search is slow", so it belongs in the
    background at startup - see start_background_warmup."""
    try:
        _get_model()
        return True
    except Exception:
        logger.exception("CLIP warm-up failed; the model will load on first use instead")
        return False


def weights_are_cached() -> bool:
    """Whether the CLIP weights are already on disk.

    Warming up must never *fetch* them: on a fresh install that would put a
    several-hundred-MB download in front of a user who has not searched for
    anything yet. A miss here just means the model loads on first use, as it
    always did."""
    try:
        return any(settings.model_cache_root.glob("models--*CLIP*"))
    except OSError:
        return False


def start_background_warmup() -> None:
    """Warm the model on a daemon thread once the import rush has passed."""

    def run() -> None:
        # An import is the one job that wants every core; the warm-up is not
        # urgent, so it waits for the derivative queue to drain (a few minutes
        # at most - a long import just means the model loads on first use).
        from app.workers.queue import derivatives_pending

        for _ in range(60):
            if derivatives_pending() == 0:
                break
            time.sleep(5)
        if weights_are_cached():
            warm_up()

    threading.Thread(target=run, name="clip-warmup", daemon=True).start()


def encode_image(image: PILImage.Image) -> np.ndarray:
    import torch

    model, preprocess, _ = _get_model()
    with torch.inference_mode():
        tensor = preprocess(image).unsqueeze(0)
        features = model.encode_image(tensor)
        features /= features.norm(dim=-1, keepdim=True)
    return features.squeeze(0).numpy().astype(np.float32)


def encode_images(images: list[PILImage.Image]) -> np.ndarray:
    """Batch variant of encode_image - one forward pass for several photos.
    Amortizes per-call torch overhead: on CPU a batch of 16 encodes at roughly
    half the per-image cost of single calls (backfill's main win)."""
    import torch

    model, preprocess, _ = _get_model()
    with torch.inference_mode():
        batch = torch.stack([preprocess(image) for image in images])
        features = model.encode_image(batch)
        features /= features.norm(dim=-1, keepdim=True)
    return features.numpy().astype(np.float32)


# The same query text comes back constantly: the grid re-runs its search on
# every filter change, and refining a rating or a date keeps `q` identical. The
# vector for a given string never changes, so encoding it a second time is pure
# waste - 2KB per entry buys back a forward pass each time.
_TEXT_CACHE: OrderedDict[str, np.ndarray] = OrderedDict()
_TEXT_CACHE_MAX = 256
_text_cache_lock = threading.Lock()


def encode_text(query: str) -> np.ndarray:
    import torch

    with _text_cache_lock:
        hit = _TEXT_CACHE.get(query)
        if hit is not None:
            _TEXT_CACHE.move_to_end(query)
            # A copy, so a caller that scales or writes into the vector it got
            # can't corrupt the cache for every later search.
            return hit.copy()

    model, _, tokenizer = _get_model()
    with torch.inference_mode():
        tokens = tokenizer([query])
        features = model.encode_text(tokens)
        features /= features.norm(dim=-1, keepdim=True)
    vector = features.squeeze(0).numpy().astype(np.float32)

    with _text_cache_lock:
        _TEXT_CACHE[query] = vector
        _TEXT_CACHE.move_to_end(query)
        while len(_TEXT_CACHE) > _TEXT_CACHE_MAX:
            _TEXT_CACHE.popitem(last=False)
    return vector.copy()


def encode_texts(queries: list[str]) -> np.ndarray:
    """Batch variant of encode_text - one forward pass for a whole label
    vocabulary (smart-album naming) instead of a model call per phrase."""
    import torch

    model, _, tokenizer = _get_model()
    with torch.inference_mode():
        tokens = tokenizer(queries)
        features = model.encode_text(tokens)
        features /= features.norm(dim=-1, keepdim=True)
    return features.numpy().astype(np.float32)


def ensure_embeddings_table(engine: Engine) -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                CREATE VIRTUAL TABLE IF NOT EXISTS image_embeddings USING vec0(
                    id TEXT PRIMARY KEY,
                    embedding FLOAT[{EMBEDDING_DIM}]
                )
                """
            )
        )


def upsert_embedding(engine: Engine, image_id: str, vector: np.ndarray) -> None:
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM image_embeddings WHERE id = :id"), {"id": image_id})
        conn.execute(
            text("INSERT INTO image_embeddings(id, embedding) VALUES (:id, :embedding)"),
            {"id": image_id, "embedding": sqlite_vec.serialize_float32(vector.tolist())},
        )


def get_embedding(engine: Engine, image_id: str) -> np.ndarray | None:
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT embedding FROM image_embeddings WHERE id = :id"), {"id": image_id}
        ).fetchone()
    if row is None:
        return None
    return np.frombuffer(row[0], dtype=np.float32)


def get_embeddings(engine: Engine, image_ids: list[str]) -> dict[str, np.ndarray]:
    """Embeddings for many images on one connection (missing ids are absent).
    Point lookups per id rather than a vec0 full scan: the caller's id list
    (e.g. auto-develop's edited photos) is typically a small slice of the
    library, and scanning every stored vector to find them would dwarf the
    lookups themselves."""
    out: dict[str, np.ndarray] = {}
    with engine.connect() as conn:
        for image_id in image_ids:
            row = conn.execute(
                text("SELECT embedding FROM image_embeddings WHERE id = :id"), {"id": image_id}
            ).fetchone()
            if row is not None:
                out[image_id] = np.frombuffer(row[0], dtype=np.float32)
    return out


# sqlite-vec caps a knn `k` at 4096; asking for more raises OperationalError.
_MAX_KNN_K = 4096


def query_similar(engine: Engine, vector: np.ndarray, k: int, exclude_id: str | None = None) -> list[tuple[str, float]]:
    # Over-fetch slightly so we can drop exclude_id (e.g. the query image
    # itself) without going back for another page.
    fetch_k = k + 1 if exclude_id else k
    fetch_k = min(fetch_k, _MAX_KNN_K)
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                """
                SELECT id, distance
                FROM image_embeddings
                WHERE embedding MATCH :embedding AND k = :k
                ORDER BY distance
                """
            ),
            {"embedding": sqlite_vec.serialize_float32(vector.tolist()), "k": fetch_k},
        ).fetchall()

    results = [(row[0], row[1]) for row in rows if row[0] != exclude_id]
    return results[:k]

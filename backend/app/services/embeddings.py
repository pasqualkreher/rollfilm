import threading
from pathlib import Path

import numpy as np
import sqlite_vec
from PIL import Image as PILImage
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.config import settings

# torch and open_clip are imported lazily inside the functions that need them
# (see _get_model / encode_*). They pull in hundreds of MB across thousands of
# files, so importing them at module load would block backend startup for many
# seconds - and much longer if the virtualenv sits on throttled storage (a
# cloud-synced folder). Keeping them out of the import path lets the API serve
# /health immediately; the CLIP model loads only when semantic search or an
# import embedding actually runs, on a background worker thread.

EMBEDDING_DIM = 512

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


def encode_image(image: PILImage.Image) -> np.ndarray:
    import torch

    model, preprocess, _ = _get_model()
    with torch.no_grad():
        tensor = preprocess(image).unsqueeze(0)
        features = model.encode_image(tensor)
        features /= features.norm(dim=-1, keepdim=True)
    return features.squeeze(0).numpy().astype(np.float32)


def encode_text(query: str) -> np.ndarray:
    import torch

    model, _, tokenizer = _get_model()
    with torch.no_grad():
        tokens = tokenizer([query])
        features = model.encode_text(tokens)
        features /= features.norm(dim=-1, keepdim=True)
    return features.squeeze(0).numpy().astype(np.float32)


def encode_texts(queries: list[str]) -> np.ndarray:
    """Batch variant of encode_text - one forward pass for a whole label
    vocabulary (smart-album naming) instead of a model call per phrase."""
    import torch

    model, _, tokenizer = _get_model()
    with torch.no_grad():
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

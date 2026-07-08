import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.db.session import engine
from app.services.embeddings import encode_image, ensure_embeddings_table, upsert_embedding
from app.services.raw import extract_preview
from app.services.thumbnails import generate_derivatives

logger = logging.getLogger(__name__)

# A personal photo library doesn't need a broker - a single background
# thread pool inside the same process is enough to keep import requests
# fast while thumbnails/embeddings generate asynchronously.
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="post-import")


def enqueue_post_import(image_id: str, source_path: Path) -> None:
    _executor.submit(_process, image_id, source_path)


def _process(image_id: str, source_path: Path) -> None:
    try:
        generate_derivatives(image_id, source_path)
    except Exception:
        logger.exception("Thumbnail/preview generation failed for image %s", image_id)

    try:
        preview = extract_preview(source_path)
        vector = encode_image(preview)
        ensure_embeddings_table(engine)
        upsert_embedding(engine, image_id, vector)
    except Exception:
        logger.exception("Embedding generation failed for image %s", image_id)

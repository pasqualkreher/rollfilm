import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from app.db.session import engine
from app.services.embeddings import encode_image, ensure_embeddings_table, upsert_embedding
from app.services.immich import upload_asset
from app.services.raw import extract_preview
from app.services.thumbnails import generate_derivatives

logger = logging.getLogger(__name__)

# A personal photo library doesn't need a broker - a single background
# thread pool inside the same process is enough to keep import requests
# fast while thumbnails/embeddings generate asynchronously.
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="post-import")


def enqueue_post_import(image_id: str, source_path: Path) -> None:
    _executor.submit(_process, image_id, source_path)


def enqueue_immich_upload(
    base_url: str,
    api_key: str,
    source_path: Path,
    file_created_at: datetime | None,
) -> None:
    """Fire-and-forget upload of a committed JPEG to Immich. Runs on the same
    background pool as thumbnailing so a slow or unreachable Immich never blocks
    (or fails) the import itself."""
    _executor.submit(_upload_to_immich, base_url, api_key, source_path, file_created_at)


def _upload_to_immich(
    base_url: str,
    api_key: str,
    source_path: Path,
    file_created_at: datetime | None,
) -> None:
    try:
        status = upload_asset(base_url, api_key, source_path, file_created_at)
        logger.info("Uploaded %s to Immich (%s)", source_path.name, status)
    except Exception:
        logger.exception("Immich upload failed for %s", source_path.name)


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

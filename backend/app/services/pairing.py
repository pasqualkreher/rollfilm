from collections import defaultdict
from pathlib import Path

from app.db.models import FileType, Image


def pair_siblings(images: list[Image]) -> None:
    """Links RAW+JPEG rows shot together (same basename) via paired_image_id,
    set symmetrically on both rows so either side can be queried directly.

    Only pairs unambiguous 1 RAW + 1 JPEG groups per basename; skips groups
    with duplicates on either side rather than guessing which is siblings.
    """
    by_stem: dict[str, list[Image]] = defaultdict(list)
    for image in images:
        stem = Path(image.original_filename).stem.lower()
        by_stem[stem].append(image)

    for group in by_stem.values():
        raws = [img for img in group if img.file_type == FileType.raw]
        jpegs = [img for img in group if img.file_type == FileType.jpeg]
        if len(raws) == 1 and len(jpegs) == 1:
            raws[0].paired_image_id = jpegs[0].id
            jpegs[0].paired_image_id = raws[0].id

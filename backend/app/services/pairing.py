from collections import defaultdict
from pathlib import Path
from typing import Iterable

from sqlalchemy.orm import Session

from app.db.models import FileType, Image

# Same-shot evidence window: the RAW+JPEG written by one shutter press carry the
# same EXIF capture time (occasionally a second or two apart on slow cards).
# Timestamps further apart than this are treated as different shots that merely
# share a (recycled) filename.
PAIR_TIME_TOLERANCE_S = 10.0


def _seconds_apart(a: Image, b: Image) -> float | None:
    if a.taken_at is None or b.taken_at is None:
        return None
    return abs((a.taken_at - b.taken_at).total_seconds())


def _camera(img: Image) -> str:
    return (img.camera_model or "").strip().lower()


def _conflict(a: Image, b: Image) -> bool:
    """Clear evidence that two same-named files are NOT the same shot: both
    carry a capture time but far apart, or both carry a camera model but
    different ones. Missing metadata never counts against a pair."""
    secs = _seconds_apart(a, b)
    if secs is not None and secs > PAIR_TIME_TOLERANCE_S:
        return True
    if _camera(a) and _camera(b) and _camera(a) != _camera(b):
        return True
    return False


def _confirms(a: Image, b: Image) -> bool:
    """Positive evidence of the same shot: capture times present and close
    (and no camera mismatch). Used to resolve ambiguous groups."""
    secs = _seconds_apart(a, b)
    return secs is not None and secs <= PAIR_TIME_TOLERANCE_S and not _conflict(a, b)


def _link(raw: Image, jpeg: Image) -> None:
    raw.paired_image_id = jpeg.id
    jpeg.paired_image_id = raw.id


def _pair_group(raws: list[Image], jpegs: list[Image]) -> int:
    """Pair as many RAW<->JPEG couples within one same-stem group as the
    evidence allows; returns the number of pairs made.

    - Unambiguous 1 RAW + 1 JPEG: pair on the name alone, unless the metadata
      clearly contradicts (recycled filename from a different day/camera).
    - Bigger groups (recycled basenames like DSCF0001 after 9999 wraps): the
      capture time + camera must positively identify each RAW's unique JPEG;
      anything still ambiguous is left unpaired rather than guessed.
    """
    if len(raws) == 1 and len(jpegs) == 1:
        if not _conflict(raws[0], jpegs[0]):
            _link(raws[0], jpegs[0])
            return 1
        return 0
    made = 0
    free_jpegs = list(jpegs)
    for raw in raws:
        matches = [j for j in free_jpegs if _confirms(raw, j)]
        if len(matches) == 1:
            _link(raw, matches[0])
            free_jpegs.remove(matches[0])
            made += 1
    return made


def _stem_groups(images: Iterable[Image]) -> dict[str, list[Image]]:
    by_stem: dict[str, list[Image]] = defaultdict(list)
    for image in images:
        by_stem[Path(image.original_filename).stem.lower()].append(image)
    return by_stem


def pair_siblings(images: list[Image]) -> int:
    """Link RAW+JPEG rows shot together (same basename) via paired_image_id,
    set symmetrically on both rows so either side can be queried directly.
    Capture time + camera model guard against recycled filenames and resolve
    groups with several same-named files. Returns the number of pairs made."""
    made = 0
    for group in _stem_groups(images).values():
        raws = [i for i in group if i.file_type == FileType.raw and i.paired_image_id is None]
        jpegs = [i for i in group if i.file_type == FileType.jpeg and i.paired_image_id is None]
        if raws and jpegs:
            made += _pair_group(raws, jpegs)
    return made


def pair_library(db: Session, owner_id: int, stems: set[str] | None = None) -> int:
    """Library-wide re-pair of the *managed* library: link still-unpaired
    RAW+JPEG siblings across import sessions - the two halves of a pair are
    often imported separately (JPEGs first, RAWs later), which per-batch
    pairing can never link. External-source rows pair per directory in
    sources._pair_scanned instead (big trees reuse basenames across folders).

    `stems` limits the pass to the given basename stems (cheap post-import
    top-up); None sweeps every unpaired photo. Returns the number of new
    pairs; the caller commits."""
    unpaired = (
        db.query(Image)
        .filter(
            Image.owner_id == owner_id,
            Image.paired_image_id.is_(None),
            # Trashed rows must not soak up a visible sibling's pairing slot.
            Image.deleted_at.is_(None),
            Image.source_root_id.is_(None),
            Image.file_type.in_([FileType.raw, FileType.jpeg]),
        )
        .all()
    )
    made = 0
    for stem, group in _stem_groups(unpaired).items():
        if stems is not None and stem not in stems:
            continue
        raws = [i for i in group if i.file_type == FileType.raw]
        jpegs = [i for i in group if i.file_type == FileType.jpeg]
        if raws and jpegs:
            made += _pair_group(raws, jpegs)
    return made

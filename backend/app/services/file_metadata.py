"""What another program said about a photo, taken over as it enters the
library.

exif.read_exif reads the stars, colour label, keywords and caption a program
like Lightroom, Bridge, darktable or digiKam left in a file's XMP/IPTC blocks
or in an .xmp sidecar beside it. The functions here put them onto the rows
the import (services/import_pipeline.py) and the external-folder scan
(services/sources.py) create - behind one switch, Settings > Import > "take
over stars, labels and keywords from the files" (on by default: a library
that comes from another program should arrive with what the photographer
gave it).

What the user did in the review stands: a star given there is not replaced
by the file's. Keywords only ever add. A RAW+JPEG pair is one shot and shares
all of this; where the two files disagree the RAW wins, because its sidecar
is where the other programs keep their word on the shot.
"""
from __future__ import annotations

import json

from sqlalchemy.orm import Session

from app.db.models import ColorLabel, FileType, Image, ImportStagedFile
from app.services.auto_tags import is_auto_tag
from app.services.exif import to_int
from app.services.tags import add_tag_to_image


def prefill_from_file(staged: ImportStagedFile, exif_json: str | None) -> None:
    """Stars and colour label from the file's XMP (see exif.read_exif) onto a
    staged row that has none yet. What the user already gave in the review
    stands - the file's word is a starting point, not a correction."""
    try:
        data = json.loads(exif_json) if exif_json else {}
    except ValueError:
        return
    rating = to_int(data.get("rating"))
    if not staged.rating and rating:
        staged.rating = max(0, min(5, rating))
    label = data.get("label")
    if staged.color_label in (None, ColorLabel.none) and label:
        try:
            staged.color_label = ColorLabel(label)
        except ValueError:
            pass


def apply_file_metadata(db: Session, owner_id: int, image: Image, exif_dict: dict) -> None:
    """The keywords and caption another program wrote into the file (see
    exif.read_exif) onto a photo entering the library: keywords become tags,
    paths and all ("Travel/Italy/Rome" files Rome under Italy under Travel),
    the caption becomes the note when there is none. Tags only ever add - a
    photo that comes back keeps the ones it had."""
    for path in exif_dict.get("keywords") or ():
        if isinstance(path, str) and path.strip() and not is_auto_tag(path):
            add_tag_to_image(db, owner_id, image, path)
    if not image.description:
        caption = exif_dict.get("caption") or exif_dict.get("title")
        if isinstance(caption, str) and caption.strip():
            image.description = caption.strip()


def share_pair_metadata(db: Session, owner_id: int, images: list[Image]) -> None:
    """A RAW+JPEG pair is one shot and shares stars, label, tags and note
    (see routes/images._apply_to_pair) - so what the file metadata gave
    either half goes onto both. The RAW's sidecar is where the other programs
    keep their word on the shot, so where the two disagree the RAW wins."""
    by_id = {image.id: image for image in images}
    done: set[str] = set()
    for image in images:
        partner = by_id.get(image.paired_image_id or "")
        if partner is None or image.id in done:
            continue
        done.update((image.id, partner.id))
        raw, other = (image, partner) if image.file_type == FileType.raw else (partner, image)
        rating = raw.rating or other.rating
        label = raw.color_label if raw.color_label != ColorLabel.none else other.color_label
        note = raw.description or other.description
        tags = set(raw.tags) | set(other.tags)
        for half in (raw, other):
            half.rating = rating
            half.color_label = label
            half.description = note
            for name in tags - set(half.tags):
                if not is_auto_tag(name):
                    add_tag_to_image(db, owner_id, half, name)



def apply_file_rating_and_label(image: Image, exif_dict: dict) -> None:
    """Stars and colour label from the file onto a photo that has none."""
    rating = to_int(exif_dict.get("rating"))
    if not image.rating and rating:
        image.rating = max(0, min(5, rating))
    label = exif_dict.get("label")
    if image.color_label in (None, ColorLabel.none) and label:
        try:
            image.color_label = ColorLabel(label)
        except ValueError:
            pass

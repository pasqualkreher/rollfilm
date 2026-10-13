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

An edit made in Rollfilm comes back too: a sidecar this app wrote carries
the photo's whole edit (sidecar.develop_payload), and a photo entering the
library with no edit of its own takes it (apply_sidecar_develop).
"""
from __future__ import annotations

import json
import logging
import xml.etree.ElementTree as ET
from pathlib import Path

from sqlalchemy.orm import Session

from app.db.models import ColorLabel, FileType, Image, ImportSessionSource, ImportStagedFile
from app.services import develop
from app.services.auto_tags import is_auto_tag
from app.services.exif import sidecar_path, to_int
from app.services.tags import add_tag_to_image

logger = logging.getLogger(__name__)


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
    try:
        apply_sidecar_develop(db, owner_id, image)
    except Exception:
        # A sidecar that can't be read costs the photo its old edit, never
        # its import.
        logger.exception("Could not read the edit from the sidecar of %s", image.original_filename)


# ---- The edit a Rollfilm sidecar carries ----------------------------------------

_DEVELOP_NAMESPACE = "https://rollfilm.app/ns/1.0/"
_DEVELOP_TAG = f"{{{_DEVELOP_NAMESPACE}}}Develop"
_RDF_DESCRIPTION = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}Description"


def read_sidecar_develop(path: Path) -> dict | None:
    """The edit a sidecar holds under XMP-rollfilm:Develop (sidecar.py), as
    the dict it was written from, or None. Read as XML rather than through
    exiftool: the namespace is ours and needs no config to be found, as an
    element (how exiftool writes it) or as an attribute (how other XMP
    writers may rewrite it)."""
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError):
        return None
    for desc in root.iter(_RDF_DESCRIPTION):
        text = desc.get(_DEVELOP_TAG)
        if text is None:
            el = desc.find(_DEVELOP_TAG)
            text = el.text if el is not None else None
        if text:
            try:
                data = json.loads(text)
            except ValueError:
                return None
            return data if isinstance(data, dict) else None
    return None


def _sidecar_candidates(db: Session, image: Image) -> list[Path]:
    """Where the sidecar of a photo entering the library may lie: beside its
    file (a folder indexed in place, an import that leaves photos where they
    are) and beside the file an import copied it from - the copy goes into
    the library without the sidecar."""
    from app.config import settings
    from app.services.filesystem import resolve_image_path

    files: list[Path] = []
    try:
        files.append(resolve_image_path(image))
    except Exception:
        pass
    if image.file_hash:
        for staged in db.query(ImportStagedFile).filter(ImportStagedFile.sha256 == image.file_hash):
            if staged.source_id and staged.source_relpath:
                source = db.get(ImportSessionSource, staged.source_id)
                if source is not None:
                    files.append(Path(source.root) / staged.source_relpath)
            staged_path = Path(staged.staged_path)
            files.append(staged_path if staged_path.is_absolute() else settings.import_staging_root / staged_path)
    out: list[Path] = []
    for f in files:
        found = sidecar_path(f)
        if found is not None and found not in out:
            out.append(found)
    return out


def _write_edits(image: Image, edits: dict) -> bool:
    """A sidecar's edit onto the row, held to what PATCH /edits accepts:
    a rotation off the quarter turns or a crop outside the frame is left
    out, the develop object is normalized. Says whether anything landed."""
    from app import schemas

    try:
        payload = schemas.ImageEdits.model_validate(edits)
    except ValueError:
        return False
    if payload.rotation % 90 == 0:
        image.edit_rotation = payload.rotation % 360
    c = payload.crop
    if c is not None and 0 <= c.x < 1 and 0 <= c.y < 1 and 0 < c.width <= 1 - c.x and 0 < c.height <= 1 - c.y:
        image.edit_crop_x, image.edit_crop_y = c.x, c.y
        image.edit_crop_width, image.edit_crop_height = c.width, c.height
    image.edit_flip_h = bool(payload.flip_h)
    image.edit_flip_v = bool(payload.flip_v)
    image.edit_straighten = max(-45.0, min(45.0, float(payload.straighten)))
    image.edit_persp_h = max(-100, min(100, int(payload.persp_h)))
    image.edit_persp_v = max(-100, min(100, int(payload.persp_v)))
    image.edit_distortion = max(-100, min(100, int(payload.distortion)))
    image.edit_adjustments = develop.dumps(develop.normalize(payload.adjustments))
    return develop.has_stored_edit(image)


def apply_sidecar_develop(db: Session, owner_id: int, image: Image) -> bool:
    """Give a photo entering the library the edit its Rollfilm sidecar
    carries - only when it has no edit of its own yet, and only when the
    edit was made on this kind of file (a pair's sidecar carries the RAW's,
    which on the JPEG would be a different picture). Its derivatives are
    rendered again once the import is in (thumbnails.defer_derivatives):
    the review's untouched ones are what the import hands over first.
    Returns whether an edit was applied."""
    if develop.has_stored_edit(image):
        return False
    for path in _sidecar_candidates(db, image):
        edits = read_sidecar_develop(path)
        if edits is None:
            continue
        made_on = edits.get("file")
        if isinstance(made_on, str) and made_on and (
            Path(made_on).suffix.lower() != Path(image.original_filename).suffix.lower()
        ):
            continue
        if not _write_edits(image, edits):
            return False
        add_tag_to_image(db, owner_id, image, "edit")
        from app.services import thumbnails

        thumbnails.defer_derivatives(image.id)
        return True
    return False


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

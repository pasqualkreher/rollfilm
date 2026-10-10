"""An .xmp sidecar beside each managed original, so what the photographer gave
a photo here reads in every other program.

Off by default (Settings > Library): it writes files into the library folder,
and that is the user's call. Switched on, every change to a photo's stars,
colour label, tags or note is written into "<stem>.xmp" next to the original
a moment later - the writers that read sidecars (Lightroom, Bridge, darktable,
digiKam) all look there first. Only the library's own fields are touched;
whatever else another program keeps in the same file (darktable's history,
Lightroom's develop settings) stays, because exiftool replaces tags, not
files. The original itself is never written to - that promise holds.

A RAW+JPEG pair shares one shot's stars, label, tags and note, and - having
one stem - shares one sidecar, so writing for either half writes the same
file with the same content. Photos indexed in place from an external folder
get no sidecar (those folders are read-only to the app), nor do virtual
copies (they own no file).

Writes are collected for a couple of seconds and done in one background pass:
a bulk rating of 300 photos must not spawn 300 exiftool runs mid-request.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path

from sqlalchemy.orm import Session, selectinload

from app.db.models import ColorLabel, Image
from app.db.session import SessionLocal
from app.services import exif as exif_service
from app.services import tags as tags_service
from app.services.filesystem import resolve_image_path, strip_virtual_marker
from app.services.settings_store import get_sidecar_write

logger = logging.getLogger(__name__)

# Lightroom's words for the colour labels (digiKam's numbers go in beside).
_LABEL_WORDS = {
    ColorLabel.red: "Red",
    ColorLabel.orange: "Orange",
    ColorLabel.yellow: "Yellow",
    ColorLabel.green: "Green",
    ColorLabel.blue: "Blue",
    ColorLabel.magenta: "Purple",
    ColorLabel.gray: "Gray",
}
_DIGIKAM_NUMBERS = {
    ColorLabel.red: 1,
    ColorLabel.orange: 2,
    ColorLabel.yellow: 3,
    ColorLabel.green: 4,
    ColorLabel.blue: 5,
    ColorLabel.magenta: 6,
    ColorLabel.gray: 7,
}

# An empty XMP packet exiftool can write into: it refuses to create a file
# from nothing, and creating one from the photo (-o) would copy the camera's
# own XMP block along - a sidecar should say only what the library knows.
_EMPTY_PACKET = (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    '<rdf:Description rdf:about=""/>'
    "</rdf:RDF></x:xmpmeta>\n"
    '<?xpacket end="w"?>\n'
)


def sidecar_for(image: Image) -> Path | None:
    """Where this photo's sidecar lives, or None when it gets none."""
    if image.source_root_id is not None or image.virtual_of_image_id:
        return None
    return sidecar_beside(resolve_image_path(image))


def sidecar_beside(original: Path) -> Path:
    return original.with_suffix(".xmp")


def _user_tags(db: Session, image: Image) -> list[str]:
    return tags_service.user_tags(db, image)


def _args(image: Image, tags: list[str]) -> list[str]:
    """The exiftool assignments for one photo. A list tag is replaced whole
    ("-Tag=" then one "-Tag=value" per value); "+=" would only add."""
    args = ["-overwrite_original", "-XMP-xmp:Rating=" + (str(image.rating) if image.rating else "")]
    label = image.color_label
    if label in (None, ColorLabel.none):
        args += ["-XMP-xmp:Label=", "-XMP-digiKam:ColorLabel="]
    else:
        args += [
            f"-XMP-xmp:Label={_LABEL_WORDS[label]}",
            f"-XMP-digiKam:ColorLabel={_DIGIKAM_NUMBERS[label]}",
        ]
    args += ["-XMP-dc:Subject=", "-XMP-lr:HierarchicalSubject=", "-XMP-digiKam:TagsList="]
    for path in tags:
        parts = [p for p in path.split("/") if p]
        if not parts:
            continue
        args += [
            f"-XMP-dc:Subject={parts[-1]}",
            f"-XMP-lr:HierarchicalSubject={'|'.join(parts)}",
            f"-XMP-digiKam:TagsList={'/'.join(parts)}",
        ]
    args.append("-XMP-dc:Description=" + (image.description or ""))
    return args


def write_sidecar(db: Session, image: Image, helper=None) -> Path | None:
    """Write (or rewrite) this photo's sidecar from what the library knows.
    Returns the path written, or None when the photo gets no sidecar or its
    original isn't reachable right now (an unplugged drive is not an error,
    the next change writes again)."""
    path = sidecar_for(image)
    if path is None or not path.parent.is_dir():
        return None
    try:
        if not path.exists():
            path.write_text(_EMPTY_PACKET, encoding="utf-8")
        (helper or exif_service._get_helper()).execute(*_args(image, _user_tags(db, image)), str(path))
    except Exception:
        logger.exception("Could not write sidecar %s", path)
        return None
    return path


def move_sidecar(source: Path, target: Path) -> tuple[Path, Path] | None:
    """A renamed original takes its sidecar along. Returns what was moved
    (so a failed rename can put it back), or None when there was nothing."""
    old, new = sidecar_beside(source), sidecar_beside(target)
    if old == new or not old.is_file() or new.exists():
        return None
    old.rename(new)
    return (new, old)


def remove_sidecar(db: Session, image: Image, *, going_too: set[str]) -> None:
    """A permanently deleted original takes its sidecar along - unless the
    other half of its pair stays and still owns it. `going_too` is the batch
    being deleted, so a pair deleted together leaves nothing behind."""
    path = sidecar_for(image)
    if path is None or not path.is_file():
        return
    stem_dir = str(Path(strip_virtual_marker(image.file_path)).parent)
    for other in db.query(Image).filter(
        Image.owner_id == image.owner_id,
        Image.source_root_id.is_(None),
        Image.id != image.id,
        Image.id.notin_(going_too),
    ):
        other_path = Path(strip_virtual_marker(other.file_path))
        if str(other_path.parent) == stem_dir and other_path.stem == Path(image.file_path).stem:
            return
    path.unlink(missing_ok=True)


# ---- Debounced writes -------------------------------------------------------

_DELAY_S = 2.0
_pending: set[str] = set()
_timer: threading.Timer | None = None
_lock = threading.Lock()


def touch(db: Session, images: list[Image]) -> None:
    """A photo's stars, label, tags or note changed: write its sidecar soon.
    Nothing happens while the setting is off."""
    if not images or not get_sidecar_write(db):
        return
    schedule([image.id for image in images])


def schedule(image_ids: list[str]) -> None:
    global _timer
    with _lock:
        _pending.update(image_ids)
        if _timer is not None:
            _timer.cancel()
        _timer = threading.Timer(_DELAY_S, _flush)
        _timer.daemon = True
        _timer.start()


def flush_now() -> int:
    """Write everything waiting, right now (tests, shutdown). Returns how
    many sidecars were written."""
    global _timer
    with _lock:
        if _timer is not None:
            _timer.cancel()
            _timer = None
    return _flush()


def _flush() -> int:
    global _timer
    with _lock:
        ids = list(_pending)
        _pending.clear()
        _timer = None
    if not ids:
        return 0
    written: set[Path] = set()
    db = SessionLocal()
    try:
        if not get_sidecar_write(db):
            return 0
        images = (
            db.query(Image)
            .options(selectinload(Image.paired_image))
            .filter(Image.id.in_(ids), Image.deleted_at.is_(None))
            .all()
        )
        for image in images:
            path = sidecar_for(image)
            if path is None or path in written:
                continue
            if write_sidecar(db, image) is not None:
                written.add(path)
    except Exception:
        logger.exception("Sidecar pass failed")
    finally:
        db.close()
    return len(written)


# ---- Write them all ---------------------------------------------------------
# Settings > Library > "Write sidecars for every photo now": for a library
# that switched the setting on, and after a restore (sidecars are not part
# of a backup - they are reproduced from the database).

_all_lock = threading.Lock()
_all_progress = {"active": False, "total": 0, "done": 0}


def write_all_progress() -> dict:
    with _all_lock:
        return dict(_all_progress)


def start_write_all(owner_id: int) -> bool:
    """Start the whole-library pass on a background thread. False when one
    is already running."""
    with _all_lock:
        if _all_progress["active"]:
            return False
        _all_progress.update(active=True, total=0, done=0)
    thread = threading.Thread(target=_write_all, args=(owner_id,), name="sidecar-write-all", daemon=True)
    thread.start()
    return True


def _write_all(owner_id: int) -> None:
    db = SessionLocal()
    try:
        images = (
            db.query(Image)
            .filter(
                Image.owner_id == owner_id,
                Image.deleted_at.is_(None),
                Image.source_root_id.is_(None),
                Image.virtual_of_image_id.is_(None),
            )
            .order_by(Image.file_path)
            .all()
        )
        with _all_lock:
            _all_progress.update(total=len(images), done=0)
        written: set[Path] = set()
        helper = exif_service._get_helper()
        for i, image in enumerate(images, 1):
            path = sidecar_for(image)
            if path is not None and path not in written:
                if write_sidecar(db, image, helper=helper) is not None:
                    written.add(path)
            with _all_lock:
                _all_progress["done"] = i
    except Exception:
        logger.exception("Writing all sidecars failed")
    finally:
        db.close()
        with _all_lock:
            _all_progress["active"] = False

"""Merging a second Rollfilm library into this one.

The case this exists for: the library lives on a big drive at home, but a trip
is shot onto a small portable one, culled and edited there in its own library.
Coming home, importing that drive as a plain folder would bring the photos in
and throw away exactly the part that took the time - the stars, the colour
labels, the edits, the albums. This carries all of it across.

Deliberately one-way (the travel library merges into this one, never the other
direction) and deliberately additive: nothing already in this library is
removed, and the source drive is never written to.

The source is read straight off the other drive rather than through an export
file: a travel library is easily a few hundred GB, and a zip of it would need
that much again in scratch space. Only its database is copied - to a temporary
throwaway file, because a read-only SQLite connection to a database with a live
write-ahead log can't always be opened, and opening the original read-write
would mean writing to a drive we promised not to touch.
"""

import logging
import shutil
import threading
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.db.models import Album, AlbumImage, Image, ImageTag, Tag
from app.services.filesystem import library_relative_path
from app.services.maintenance import image_row_from_dict, image_to_dict
from app.services.thumbnails import derivative_dir

logger = logging.getLogger(__name__)

# Where a library keeps its own data, mirroring what the desktop app lays down
# (electron/main.js: libraryDataDir/dbPathFor/thumbnailRootFor).
_DATA_DIR = ".photomanager"


def source_db_path(library_root: Path) -> Path:
    return library_root / _DATA_DIR / "db" / "library.db"


def source_thumbnail_root(library_root: Path) -> Path:
    return library_root / _DATA_DIR / "thumbnails"


class MergeError(Exception):
    """Something about the chosen folder makes a merge impossible. The message
    is written for the user, not the log."""


def _current_schema_revision() -> str | None:
    from app.db.session import engine

    with engine.connect() as conn:
        row = conn.execute(text("SELECT version_num FROM alembic_version")).first()
        return row[0] if row else None


@contextmanager
def _open_source(library_root: Path):
    """Yield a Session over a throwaway copy of the other library's database.

    The copy takes the -wal and -shm alongside it so an unclean shutdown on the
    travel machine still recovers; SQLite replays the log when the copy is
    opened. The original files are only ever read."""
    db_path = source_db_path(library_root)
    if not db_path.is_file():
        raise MergeError(
            "That folder isn't a Rollfilm library - it has no photo database. "
            "Pick the library folder itself, the one holding the year folders."
        )
    if db_path.resolve() == (settings.library_root / _DATA_DIR / "db" / "library.db").resolve():
        raise MergeError("That is this library - pick the other one.")

    with TemporaryDirectory(prefix="rollfilm-merge-") as tmp:
        local = Path(tmp) / "source.db"
        shutil.copyfile(db_path, local)
        for tail in ("-wal", "-shm"):
            side = Path(str(db_path) + tail)
            if side.exists():
                shutil.copyfile(side, Path(str(local) + tail))

        engine = create_engine(f"sqlite:///{local}")
        try:
            with engine.connect() as conn:
                row = conn.execute(text("SELECT version_num FROM alembic_version")).first()
            theirs = row[0] if row else None
            ours = _current_schema_revision()
            if theirs != ours:
                raise MergeError(
                    "That library was made by a different Rollfilm version. Open it once "
                    "with this version (Settings - switch library) so it can update itself, "
                    "then merge it."
                )
            session = sessionmaker(bind=engine)()
            try:
                yield session
            finally:
                session.close()
        finally:
            engine.dispose()


@dataclass
class MergeSummary:
    """What a merge would do, shown for confirmation before anything moves."""

    library_root: str
    photos: int = 0  # mergeable photos in the source library
    new_photos: int = 0  # not in this library yet - these get copied
    known_photos: int = 0  # already here; only their metadata is taken over
    bytes_to_copy: int = 0
    albums: int = 0
    tags: int = 0

    def as_dict(self) -> dict:
        return {
            "library_root": self.library_root,
            "photos": self.photos,
            "new_photos": self.new_photos,
            "known_photos": self.known_photos,
            "bytes_to_copy": self.bytes_to_copy,
            "albums": self.albums,
            "tags": self.tags,
        }


def _mergeable(session: Session):
    """The source photos a merge takes: managed ones the user hasn't thrown
    away. Photos only indexed in place from an external source root aren't
    the travel library's to give (their files live on someone else's storage),
    and anything in its Trash was deliberately discarded on the trip."""
    return (
        session.query(Image)
        .filter(Image.source_root_id.is_(None), Image.deleted_at.is_(None))
        .order_by(Image.taken_at)
    )


def inspect_library(db: Session, owner_id: int, library_root: Path) -> MergeSummary:
    """Read-only look at the other library, for the confirmation step."""
    if not library_root.is_absolute() or not library_root.is_dir():
        raise MergeError("That folder doesn't exist on this machine.")

    summary = MergeSummary(library_root=str(library_root))
    known_hashes = {
        row.file_hash
        for row in db.query(Image.file_hash).filter(Image.owner_id == owner_id)
    }
    with _open_source(library_root) as source:
        for image in _mergeable(source):
            summary.photos += 1
            if image.file_hash in known_hashes:
                summary.known_photos += 1
            else:
                summary.new_photos += 1
                summary.bytes_to_copy += image.file_size or 0
        summary.albums = source.query(Album).count()
        summary.tags = source.query(Tag).count()
    return summary


# Live progress of the running merge, polled by the import screen. Only one
# merge can run at a time (the route rejects a second one).
_progress_lock = threading.Lock()
_progress: dict = {
    "active": False,
    "total": 0,
    "done": 0,
    "copied_bytes": 0,
    "started": 0.0,
    "recent": deque(maxlen=20),
    "result": None,
    "error": None,
}

# How many recent photos the remaining-time estimate is measured over. The
# per-photo cost here varies wildly - one already in the library is a database
# write, a fresh 40MB RAW is a copy across two drives - so an average over the
# whole run would be badly wrong for most of it. Same window and reasoning as
# the import's ETA (services/import_pipeline.py).
_ETA_WINDOW = 20


def get_merge_progress() -> dict:
    """Live counters plus a remaining-time estimate, or eta_seconds=None until
    there is enough finished work to measure a rate."""
    with _progress_lock:
        active = _progress["active"]
        total = _progress["total"]
        done = _progress["done"]
        copied_bytes = _progress["copied_bytes"]
        started = _progress["started"]
        recent = list(_progress["recent"])
        result = _progress.get("result")
        error = _progress.get("error")

    eta = None
    if active and done > 0 and total > done:
        now = time.monotonic()
        # Measured up to *now* rather than to the last finished photo, so a
        # stall (a drive going to sleep) makes the estimate honestly grow
        # instead of freezing at a stale value.
        if len(recent) >= 2 and now > recent[0]:
            rate = len(recent) / (now - recent[0])
            eta = (total - done) / rate
        elif started:
            eta = (now - started) / done * (total - done)

    return {
        "active": active,
        "total": total,
        "done": done,
        "copied_bytes": copied_bytes,
        "eta_seconds": eta,
        # Of the last finished run - so leaving the screen and coming back
        # still shows how it went.
        "result": result,
        "error": error,
    }


def _set_progress(**fields) -> None:
    with _progress_lock:
        _progress.update(fields)


def _progress_step(done: int, copied_bytes: int) -> None:
    with _progress_lock:
        _progress["done"] = done
        _progress["copied_bytes"] = copied_bytes
        _progress["recent"].append(time.monotonic())


# Set by the cancel route; the copy loop notices between two photos.
_cancel = threading.Event()


def request_merge_cancel() -> None:
    """Ask a running merge to stop.

    It stops between photos, never inside one, and what already came across
    stays: those rows are committed and their files are in place, so the
    library is consistent either way. Running the merge again picks up where
    this left off - photos already here are recognised by content hash and
    skipped rather than duplicated."""
    _cancel.set()




@dataclass
class _Carried:
    """Metadata of one source photo, lifted out of the source session before
    that session closes."""

    data: dict
    albums: list[tuple[str, int]] = field(default_factory=list)  # (album name, position)
    source_id: str = ""
    source_pair_id: str | None = None
    file_path: str = ""
    file_size: int = 0


def _read_source(source: Session) -> list[_Carried]:
    """Pull everything the merge needs into plain values in one pass, so the
    long copy loop doesn't hold a second database open while it runs."""
    images = _mergeable(source).all()
    ids = {i.id for i in images}

    tags_by_image: dict[str, list[str]] = {}
    for image_id, tag_name in (
        source.query(ImageTag.image_id, Tag.name).join(Tag, Tag.id == ImageTag.tag_id).all()
    ):
        if image_id in ids:
            tags_by_image.setdefault(image_id, []).append(tag_name)

    albums_by_image: dict[str, list[tuple[str, int]]] = {}
    for image_id, name, position in (
        source.query(AlbumImage.image_id, Album.name, AlbumImage.position)
        .join(Album, Album.id == AlbumImage.album_id)
        .all()
    ):
        if image_id in ids:
            albums_by_image.setdefault(image_id, []).append((name, position))

    carried = []
    for image in images:
        carried.append(
            _Carried(
                data=image_to_dict(image, sorted(tags_by_image.get(image.id, []))),
                albums=albums_by_image.get(image.id, []),
                source_id=image.id,
                source_pair_id=image.paired_image_id,
                file_path=image.file_path,
                file_size=image.file_size or 0,
            )
        )
    return carried


def _get_or_create_tag(db: Session, owner_id: int, name: str, cache: dict[str, Tag]) -> Tag:
    """Tags merge by name: a "iceland" tag on the travel library attaches to
    the one already here rather than becoming a second, identical-looking tag."""
    key = name.strip().lower()
    if key in cache:
        return cache[key]
    tag = db.query(Tag).filter(Tag.owner_id == owner_id, Tag.name == name).first()
    if tag is None:
        tag = Tag(owner_id=owner_id, name=name)
        db.add(tag)
        db.flush()
    cache[key] = tag
    return tag


def _get_or_create_album(db: Session, owner_id: int, name: str, cache: dict[str, Album]) -> Album:
    """Albums merge by name too - same reasoning as tags."""
    key = name.strip().lower()
    if key in cache:
        return cache[key]
    album = db.query(Album).filter(Album.owner_id == owner_id, Album.name == name).first()
    if album is None:
        album = Album(owner_id=owner_id, name=name)
        db.add(album)
        db.flush()
    cache[key] = album
    return album


# Which fields of an existing photo a merge takes over from the travel library.
# The review work done on the trip is the newer decision, so it wins - but only
# these fields: nothing that describes the *file* (path, hash, size, EXIF) is
# touched, because that describes the copy already sitting here.
_CARRIED_OVER_FIELDS = (
    "rating",
    "color_label",
    "edit_rotation",
    "edit_crop_x",
    "edit_crop_y",
    "edit_crop_width",
    "edit_crop_height",
    "edit_flip_h",
    "edit_flip_v",
    "edit_straighten",
    "edit_persp_h",
    "edit_persp_v",
    "edit_distortion",
    "edit_adjustments",
    "edit_rev",
    "applied_adjustments",
)


def _copy_derivatives(source_root: Path, source_id: str, target_id: str) -> None:
    """Reuse the thumbnail and preview the travel library already rendered.
    Re-rendering them here would be hours of RAW decoding for photos that were
    decoded once already."""
    src = source_thumbnail_root(source_root) / source_id
    if not src.is_dir():
        return
    dest = derivative_dir(target_id)
    for name in ("thumbnail.jpg", "preview.jpg"):
        candidate = src / name
        if candidate.exists():
            try:
                shutil.copyfile(candidate, dest / name)
            except OSError:
                logger.exception("merge: could not copy %s for %s", name, target_id)


def merge_library(db: Session, owner_id: int, library_root: Path) -> dict:
    """Copy the other library's photos and metadata into this one.

    Photos this library doesn't have are copied in and get a full row; photos
    it already has (same content hash) keep their file and take over the review
    work done on the trip - see _CARRIED_OVER_FIELDS. Tags and albums merge by
    name. Nothing here is deleted and the source drive is only read."""
    if not library_root.is_absolute() or not library_root.is_dir():
        raise MergeError("That folder doesn't exist on this machine.")

    # Logged either side of the two preparation steps: they run before a single
    # byte is copied, so without these a slow one looks like a hang with no way
    # to tell which part is slow.
    logger.info("library merge from %s: reading the other library", library_root)
    with _open_source(library_root) as source:
        carried = _read_source(source)
    logger.info("library merge: %d photos to go through, indexing this library", len(carried))

    existing_by_hash: dict[str, Image] = {}
    for image in db.query(Image).filter(Image.owner_id == owner_id):
        existing_by_hash.setdefault(image.file_hash, image)

    # Destination paths are claimed as we go: several photos of the same day
    # can carry the same camera filename, and the ones earlier in this run
    # aren't on disk yet when the next one asks.
    claimed: set[str] = set()
    tag_cache: dict[str, Tag] = {}
    album_cache: dict[str, Album] = {}
    id_map: dict[str, str] = {}  # source image id -> id in this library

    added = updated = skipped = 0
    copied_bytes = 0
    canceled = False
    _cancel.clear()
    _set_progress(
        active=True,
        total=len(carried),
        done=0,
        copied_bytes=0,
        started=time.monotonic(),
        recent=deque(maxlen=_ETA_WINDOW),
        result=None,
        error=None,
    )

    logger.info("library merge: starting the copy")
    try:
        for item in carried:
            # Checked between photos, never inside one: whatever is already
            # committed stays, and re-running skips it by content hash.
            if _cancel.is_set():
                canceled = True
                break
            data = item.data
            existing = existing_by_hash.get(data["file_hash"])
            if existing is not None:
                # The file is already here - take over only the decisions made
                # on the trip.
                for field_name in _CARRIED_OVER_FIELDS:
                    if field_name in data:
                        setattr(existing, field_name, _coerce(field_name, data[field_name]))
                target = existing
                updated += 1
            else:
                src_file = library_root / item.file_path
                if not src_file.exists():
                    # Catalogued there but the file is gone - nothing to copy.
                    skipped += 1
                    _progress_step(added + updated + skipped, copied_bytes)
                    continue
                # A fresh id (keep_id=False), so merging the same travel library
                # twice can't collide with the rows the first run inserted.
                target = image_row_from_dict(data, owner_id, keep_id=False)
                # The destination has to be settled BEFORE the row is inserted:
                # file_path is unique, and the path the photo had over there
                # ("2026/2026-07-14/DSCF0266.JPG") is exactly the one this
                # library may already have given to a different photo.
                relative = library_relative_path(
                    target.taken_at or target.imported_at,
                    data["original_filename"],
                    settings.library_root,
                    is_taken=lambda candidate: candidate in claimed,
                )
                claimed.add(relative)
                target.file_path = relative
                db.add(target)
                db.flush()  # assigns the id the derivative folder is named for
                dest = settings.library_root / relative
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src_file, dest)
                _copy_derivatives(library_root, item.source_id, target.id)
                existing_by_hash.setdefault(data["file_hash"], target)
                copied_bytes += item.file_size
                added += 1

            id_map[item.source_id] = target.id

            for name in data.get("tags", []):
                tag = _get_or_create_tag(db, owner_id, name, tag_cache)
                already = (
                    db.query(ImageTag)
                    .filter(ImageTag.image_id == target.id, ImageTag.tag_id == tag.id)
                    .first()
                )
                if already is None:
                    db.add(ImageTag(image_id=target.id, tag_id=tag.id))

            for album_name, position in item.albums:
                album = _get_or_create_album(db, owner_id, album_name, album_cache)
                already = (
                    db.query(AlbumImage)
                    .filter(AlbumImage.album_id == album.id, AlbumImage.image_id == target.id)
                    .first()
                )
                if already is None:
                    db.add(AlbumImage(album_id=album.id, image_id=target.id, position=position))

            _progress_step(added + updated + skipped, copied_bytes)
            # Committed in chunks: a merge can run for a long time, and a drive
            # that goes away halfway through should leave what it already
            # brought over intact rather than rolling all of it back.
            if (added + updated + skipped) % 50 == 0:
                db.commit()

        # RAW+JPEG partners, once every id is known.
        for item in carried:
            if not item.source_pair_id:
                continue
            here = id_map.get(item.source_id)
            partner = id_map.get(item.source_pair_id)
            if here and partner:
                image = db.get(Image, here)
                if image is not None and image.paired_image_id is None:
                    image.paired_image_id = partner

        db.commit()
    finally:
        _set_progress(active=False)

    logger.info(
        "library merge from %s: %d added, %d updated, %d skipped, %.1f GB copied%s",
        library_root,
        added,
        updated,
        skipped,
        copied_bytes / 1e9,
        " (stopped early)" if canceled else "",
    )
    result = {
        "added": added,
        "updated": updated,
        "skipped": skipped,
        "copied_bytes": copied_bytes,
        "canceled": canceled,
    }
    # Kept on the progress state, not just returned: the merge runs in the
    # background and the user is free to walk away from the import screen, so
    # the outcome has to still be there when they come back.
    _set_progress(result=result)
    return result


def start_merge(owner_id: int, library_root: Path) -> None:
    """Begin a merge in the background and return at once.

    Copying a travel library is minutes to hours of work; holding the request
    open for it would time out long before it finished and would freeze the
    app while it ran. The screen follows along through get_merge_progress()
    instead, and the rest of Rollfilm stays usable - browsing, editing and even
    a card import can go on while this copies.

    Everything that can be judged quickly (is this a library? same version?) is
    checked here, so an obvious mistake still comes back as a plain error on
    the button rather than as a background failure."""
    if get_merge_progress()["active"]:
        raise MergeError("A library import is already running.")
    if not library_root.is_absolute() or not library_root.is_dir():
        raise MergeError("That folder doesn't exist on this machine.")
    with _open_source(library_root):
        pass  # validates: it is a library, and its schema matches ours

    def _run() -> None:
        from app.db.session import SessionLocal

        db = SessionLocal()
        try:
            merge_library(db, owner_id, library_root)
        except Exception as exc:
            logger.exception("library merge from %s failed", library_root)
            db.rollback()
            _set_progress(active=False, error=str(exc))
        finally:
            db.close()

    _set_progress(active=True, total=0, done=0, copied_bytes=0, result=None, error=None)
    threading.Thread(target=_run, name="library-merge", daemon=True).start()


def _coerce(field_name: str, value):
    """The manifest carries enums as their string value (see image_to_dict);
    assigning that straight onto the column would store a bare string."""
    if field_name == "color_label":
        from app.db.models import ColorLabel

        return ColorLabel(value)
    return value

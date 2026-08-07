"""Renaming a photo, and the app noticing a rename that happened in Finder.

These are the two halves of one promise: what the library calls a photo and
what the file is actually called never drift apart. Renaming in the app is the
one place that writes to the user's original file, so it has to be exact - the
photo keeps its id (and with it its stars, tags, albums and edits), the
RAW/JPEG partner follows along, and nothing is ever overwritten. In the other
direction, a file renamed outside the app used to look "missing" to the library
sync, which deleted the row and threw all of that away; now the row follows the
bytes.
"""

from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes.images import rename_image
from app.config import settings
from app.db.base import Base
from app.db.models import FileType, Image, User
from app.schemas import ImageRenameRequest
from app.services.maintenance import sync_db_with_library


class _User:
    id = 1


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    yield session
    session.close()


@pytest.fixture()
def library(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "library"
    root.mkdir()
    monkeypatch.setattr(settings, "library_root", root)
    # Nothing in these tests renders a thumbnail, but the sync sweeps this
    # folder for orphans - keep it inside the throwaway tree.
    cache = tmp_path / "thumbs"
    cache.mkdir()
    monkeypatch.setattr(settings, "thumbnail_cache_root", cache)
    return root


def _add(
    db: Session,
    library: Path,
    name: str,
    content: bytes,
    *,
    id: str | None = None,
    file_type: FileType = FileType.jpeg,
) -> Image:
    """A photo on disk under LIBRARY_ROOT/2026/2026-07-01/ plus its row."""
    day = library / "2026" / "2026-07-01"
    day.mkdir(parents=True, exist_ok=True)
    (day / name).write_bytes(content)
    from app.services.hashing import sha256_file

    image = Image(
        id=id or name,
        owner_id=1,
        file_path=str((day / name).relative_to(library)),
        original_filename=name,
        file_hash=sha256_file(day / name),
        file_type=file_type,
        file_size=len(content),
        taken_at=datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc),
    )
    db.add(image)
    db.commit()
    return image


def _rename(db: Session, image: Image, name: str, **kwargs):
    return rename_image(
        image_id=image.id,
        payload=ImageRenameRequest(name=name, **kwargs),
        db=db,
        current_user=_User(),
    )


# --- renaming in the app ---------------------------------------------------


def test_rename_moves_the_file_and_keeps_the_photo(db, library):
    image = _add(db, library, "DSCF0001.JPG", b"alpha", id="a")
    image.rating = 4

    result = _rename(db, image, "Sunrise over the lake")

    assert result.image.original_filename == "Sunrise over the lake.JPG"
    assert (library / "2026" / "2026-07-01" / "Sunrise over the lake.JPG").read_bytes() == b"alpha"
    assert not (library / "2026" / "2026-07-01" / "DSCF0001.JPG").exists()
    # Same row: the id is what every rating, tag, album and cached derivative
    # hangs off, so a rename must never create a new one.
    assert result.image.id == "a"
    assert result.image.rating == 4
    assert db.get(Image, "a").file_path == "2026/2026-07-01/Sunrise over the lake.JPG"


def test_the_extension_is_not_up_for_editing(db, library):
    image = _add(db, library, "DSCF0001.RAF", b"raw", file_type=FileType.raw)

    # Typed with the extension (what the UI shows), typed without it, and typed
    # with a name that merely contains dots - all keep the file a .RAF.
    assert _rename(db, image, "one.RAF").image.original_filename == "one.RAF"
    assert _rename(db, image, "two").image.original_filename == "two.RAF"
    assert _rename(db, image, "2026.07.01 lake").image.original_filename == "2026.07.01 lake.RAF"


def test_a_name_that_is_taken_is_refused_and_nothing_moves(db, library):
    keeper = _add(db, library, "keeper.JPG", b"keeper", id="k")
    image = _add(db, library, "DSCF0001.JPG", b"alpha", id="a")

    with pytest.raises(HTTPException) as exc:
        _rename(db, image, "keeper")

    assert exc.value.status_code == 409
    assert (library / "2026" / "2026-07-01" / "keeper.JPG").read_bytes() == b"keeper"
    assert db.get(Image, "a").original_filename == "DSCF0001.JPG"
    assert db.get(Image, "k").original_filename == "keeper.JPG"


@pytest.mark.parametrize("name", ["", "   ", "a/b", "a\\b", "what?", "..", "x" * 300])
def test_names_a_filesystem_cannot_take_are_rejected(db, library, name):
    image = _add(db, library, "DSCF0001.JPG", b"alpha")

    with pytest.raises(HTTPException) as exc:
        _rename(db, image, name)

    assert exc.value.status_code == 400
    assert (library / "2026" / "2026-07-01" / "DSCF0001.JPG").exists()


def test_the_raw_jpeg_partner_is_renamed_to_the_same_stem(db, library):
    jpeg = _add(db, library, "DSCF0001.JPG", b"alpha", id="j")
    raw = _add(db, library, "DSCF0001.RAF", b"beta", id="r", file_type=FileType.raw)
    jpeg.paired_image_id = raw.id
    raw.paired_image_id = jpeg.id
    db.commit()

    result = _rename(db, jpeg, "Lake")

    assert result.image.original_filename == "Lake.JPG"
    assert result.paired_filename == "Lake.RAF"
    assert result.pair_error is None
    # One shot, one name on disk - each half keeping its own extension.
    assert (library / "2026" / "2026-07-01" / "Lake.JPG").exists()
    assert (library / "2026" / "2026-07-01" / "Lake.RAF").exists()
    assert db.get(Image, "r").file_path == "2026/2026-07-01/Lake.RAF"


def test_the_partner_can_be_left_alone(db, library):
    jpeg = _add(db, library, "DSCF0001.JPG", b"alpha", id="j")
    raw = _add(db, library, "DSCF0001.RAF", b"beta", id="r", file_type=FileType.raw)
    jpeg.paired_image_id = raw.id
    raw.paired_image_id = jpeg.id
    db.commit()

    result = _rename(db, jpeg, "Lake", rename_pair=False)

    assert result.paired_filename is None
    assert db.get(Image, "r").original_filename == "DSCF0001.RAF"


def test_a_partner_that_cannot_be_renamed_does_not_block_the_photo(db, library):
    jpeg = _add(db, library, "DSCF0001.JPG", b"alpha", id="j")
    raw = _add(db, library, "DSCF0001.RAF", b"beta", id="r", file_type=FileType.raw)
    jpeg.paired_image_id = raw.id
    raw.paired_image_id = jpeg.id
    # Something else already owns the name the RAW would have to take.
    _add(db, library, "Lake.RAF", b"other", id="o", file_type=FileType.raw)
    db.commit()

    result = _rename(db, jpeg, "Lake")

    # The photo the user actually renamed still gets renamed; the half that
    # couldn't follow is reported rather than silently left behind.
    assert result.image.original_filename == "Lake.JPG"
    assert result.paired_filename is None
    assert "Lake.RAF" in result.pair_error
    assert db.get(Image, "r").original_filename == "DSCF0001.RAF"
    assert (library / "2026" / "2026-07-01" / "Lake.RAF").read_bytes() == b"other"


# --- renaming outside the app ----------------------------------------------


def test_a_file_renamed_in_finder_is_followed_not_deleted(db, library):
    image = _add(db, library, "DSCF0001.JPG", b"alpha", id="a")
    image.rating = 5
    db.commit()

    # What Finder does: same bytes, new name, the app none the wiser.
    day = library / "2026" / "2026-07-01"
    (day / "DSCF0001.JPG").rename(day / "Holiday.JPG")

    result = sync_db_with_library(db, owner_id=1)

    assert result["renamed_files_followed"] == 1
    assert result["removed_missing_files"] == 0
    # ...and it is not reported as a stray file needing an import either.
    assert result["untracked_files_found"] == 0
    kept = db.get(Image, "a")
    assert kept is not None
    assert kept.original_filename == "Holiday.JPG"
    assert kept.file_path == "2026/2026-07-01/Holiday.JPG"
    assert kept.rating == 5


def test_a_file_moved_to_another_folder_is_followed_too(db, library):
    _add(db, library, "DSCF0001.JPG", b"alpha", id="a")
    elsewhere = library / "2025" / "keepers"
    elsewhere.mkdir(parents=True)
    (library / "2026" / "2026-07-01" / "DSCF0001.JPG").rename(elsewhere / "DSCF0001.JPG")

    result = sync_db_with_library(db, owner_id=1)

    assert result["renamed_files_followed"] == 1
    assert db.get(Image, "a").file_path == str(Path("2025") / "keepers" / "DSCF0001.JPG")


def test_a_deleted_file_is_still_removed(db, library):
    _add(db, library, "DSCF0001.JPG", b"alpha", id="a")
    (library / "2026" / "2026-07-01" / "DSCF0001.JPG").unlink()

    result = sync_db_with_library(db, owner_id=1)

    # Nothing with those bytes is left in the library, so this really is gone.
    assert result["renamed_files_followed"] == 0
    assert result["removed_missing_files"] == 1
    assert db.get(Image, "a") is None


def test_a_genuinely_new_file_is_not_mistaken_for_a_rename(db, library):
    _add(db, library, "DSCF0001.JPG", b"alpha", id="a")
    # Different bytes, and the tracked photo is still exactly where it was.
    (library / "2026" / "2026-07-01" / "fresh.JPG").write_bytes(b"something else")

    result = sync_db_with_library(db, owner_id=1)

    assert result["renamed_files_followed"] == 0
    assert result["untracked_files_found"] == 1
    assert db.get(Image, "a").original_filename == "DSCF0001.JPG"

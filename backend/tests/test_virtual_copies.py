"""Virtual copies ("virtual copies"): a second library row for the same file.

The copy owns no bytes - its synthetic file_path resolves to the source's file -
and carries its own develop state. These tests pin the lifecycle the canvas
depends on: creation (tag, copied edits, synthetic identity), deletion fallback
(a dead copy re-points its frames to the source; a dead source leaves missing
placeholders and takes its copies along), and the library sync never mistaking
a virtual copy for a vanished file.
"""

import json
from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes.canvases import get_canvas_layout, save_canvas_layout
from app.api.routes.images import create_virtual_copy
from app.db.base import Base
from app.db.models import Canvas, FileType, Image, LayoutItem, User
from app.services.filesystem import VIRTUAL_PATH_MARKER, resolve_image_path, strip_virtual_marker
from app.services.maintenance import image_row_from_dict, image_to_dict
from app.services.pairing import pair_siblings
from app.services.trash import hard_delete_images


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    yield session
    session.close()


def _image(db: Session, id: str, **extra) -> Image:
    fields = dict(
        id=id,
        owner_id=1,
        file_path=f"2026/2026-07-01/{id}.jpg",
        original_filename=f"{id}.jpg",
        file_hash=f"hash-{id}",
        file_type=FileType.jpeg,
        file_size=3,
        taken_at=datetime(2026, 7, 1, 12, 0, 0),
    )
    fields.update(extra)
    image = Image(**fields)
    db.add(image)
    return image


def _copy(db: Session, source_id: str) -> Image:
    return create_virtual_copy(source_id, db=db, current_user=db.get(User, 1))


def test_a_virtual_copy_borrows_the_file_and_starts_from_the_current_edit(db: Session):
    src = _image(db, "a", edit_adjustments='{"exposure": 1.0}', edit_rotation=90, edit_rev=3, rating=4)
    db.commit()

    copy = _copy(db, "a")

    assert copy.virtual_of_image_id == "a"
    # Synthetic identity: its own unique path (never a real file) and a hash
    # nothing content-based can ever match.
    assert copy.file_path.startswith(f"{src.file_path}{VIRTUAL_PATH_MARKER}")
    assert copy.file_hash != src.file_hash
    assert strip_virtual_marker(copy.file_path) == src.file_path
    assert resolve_image_path(copy) == resolve_image_path(src)
    # The copy starts as the source looks now, free to diverge.
    assert copy.edit_adjustments == '{"exposure": 1.0}'
    assert copy.edit_rotation == 90
    assert copy.rating == 4
    # Auto-tagged for what it is, and "edit" because it carries edits.
    assert copy.tags == ["edit", "virtual copy"]


def test_a_virtual_copy_can_take_the_editors_unsaved_state(db: Session):
    """Save copy -> virtual copy from inside the editor: the copy gets the
    sliders as they are right now, the source keeps its saved edit."""
    src = _image(db, "a", edit_adjustments='{"exposure": 1.0}', edit_rotation=90, edit_rev=3)
    db.commit()

    copy = create_virtual_copy(
        "a",
        payload=schemas.ImageEdits(rotation=180, flip_h=True, adjustments={"contrast": 20}),
        db=db,
        current_user=db.get(User, 1),
    )

    assert copy.virtual_of_image_id == "a"
    assert copy.edit_rotation == 180
    assert copy.edit_flip_h is True
    adj = json.loads(copy.edit_adjustments or "{}")
    assert adj["contrast"] == 20
    assert adj["exposure"] == 0.0
    assert copy.edit_rev > src.edit_rev
    assert "virtual copy" in copy.tags
    # The source is exactly as it was.
    db.refresh(src)
    assert src.edit_rotation == 90
    assert src.edit_adjustments == '{"exposure": 1.0}'
    assert src.edit_rev == 3


def test_a_copy_of_an_unedited_photo_is_not_tagged_edit(db: Session):
    _image(db, "plain")
    db.commit()
    assert _copy(db, "plain").tags == ["virtual copy"]


def test_a_copy_of_a_copy_grounds_on_the_original(db: Session):
    _image(db, "a")
    db.commit()
    first = _copy(db, "a")
    second = _copy(db, first.id)
    assert second.virtual_of_image_id == "a"
    assert strip_virtual_marker(second.file_path) == "2026/2026-07-01/a.jpg"


def test_a_trashed_source_refuses_new_copies(db: Session):
    _image(db, "a", deleted_at=datetime(2026, 8, 1))
    db.commit()
    with pytest.raises(HTTPException) as excinfo:
        _copy(db, "a")
    assert excinfo.value.status_code == 400


def _canvas_with_frame(db: Session, image_id: str) -> Canvas:
    canvas = Canvas(id="cv", owner_id=1, name="Design")
    db.add(canvas)
    db.commit()
    save_canvas_layout(
        "cv",
        schemas.CanvasLayoutIn(
            items=[schemas.LayoutItemIn(id="i1", kind="photo", image_id=image_id)]
        ),
        db=db,
        current_user=db.get(User, 1),
    )
    return canvas


def test_deleting_a_copy_for_good_falls_back_to_the_source(db: Session):
    _image(db, "a")
    db.commit()
    copy = _copy(db, "a")
    _canvas_with_frame(db, copy.id)

    hard_delete_images(db, [copy], delete_files=False)
    db.commit()

    out = get_canvas_layout("cv", db=db, current_user=db.get(User, 1))
    assert [(i.id, i.image_id, i.missing) for i in out.items] == [("i1", "a", False)]


def test_deleting_the_source_takes_its_copies_and_leaves_placeholders(db: Session):
    src = _image(db, "a")
    db.commit()
    copy = _copy(db, "a")
    _canvas_with_frame(db, copy.id)

    hard_delete_images(db, [src], delete_files=False)
    db.commit()

    # The copy died with its source (its bytes are gone) and the frame stayed
    # behind as an honest gap.
    assert db.query(Image).count() == 0
    out = get_canvas_layout("cv", db=db, current_user=db.get(User, 1))
    assert [(i.id, i.image_id, i.missing, i.available) for i in out.items] == [
        ("i1", None, True, True)
    ]


def test_deleting_a_copy_never_touches_the_shared_file(db: Session, tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "library_root", tmp_path)
    (tmp_path / "2026" / "2026-07-01").mkdir(parents=True)
    real = tmp_path / "2026" / "2026-07-01" / "a.jpg"
    real.write_bytes(b"jpeg")
    _image(db, "a")
    db.commit()
    copy = _copy(db, "a")

    hard_delete_images(db, [copy], delete_files=True)
    db.commit()
    assert real.exists(), "the source's bytes are not the copy's to delete"


def test_the_library_sync_never_reaps_virtual_copies(db: Session, tmp_path, monkeypatch):
    """A virtual copy's synthetic path never exists on disk. The missing-file
    scan treating that as 'file gone' would silently destroy every virtual copy
    on every startup."""
    from app.config import settings
    from app.services import maintenance

    monkeypatch.setattr(settings, "library_root", tmp_path)
    monkeypatch.setattr(settings, "thumbnail_cache_root", tmp_path / ".photomanager" / "thumbs")
    (tmp_path / "2026" / "2026-07-01").mkdir(parents=True)
    (tmp_path / "2026" / "2026-07-01" / "a.jpg").write_bytes(b"jpeg")
    _image(db, "a")
    db.commit()
    copy = _copy(db, "a")

    result = maintenance.sync_db_with_library(db, owner_id=1)
    assert result["removed_missing_files"] == 0
    assert db.get(Image, copy.id) is not None


def test_virtual_copies_never_pair_with_raws(db: Session):
    raw = _image(db, "shot-raw", file_path="2026/2026-07-01/shot.raf", original_filename="shot.RAF", file_type=FileType.raw)
    jpeg = _image(db, "shot-jpg", file_path="2026/2026-07-01/shot.jpg", original_filename="shot.JPG")
    db.commit()
    copy = _copy(db, "shot-jpg")

    pair_siblings([raw, jpeg, copy])
    assert raw.paired_image_id == "shot-jpg"
    assert copy.paired_image_id is None


def test_backup_manifest_round_trips_the_virtual_link(db: Session):
    _image(db, "a")
    db.commit()
    copy = _copy(db, "a")

    data = image_to_dict(copy, tags=["virtual copy"])
    restored = image_row_from_dict(data, owner_id=1)
    assert restored.virtual_of_image_id == "a"
    assert restored.file_path == copy.file_path

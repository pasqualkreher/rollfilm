"""Kept versions of an album's canvas, and the Canvases shelf they feed.

The working layout autosaves over itself; a version is the user saying "keep
this one". The shelf on the Albums page shows, per opted-in album, whichever
version was kept or loaded last.
"""

from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes.albums import (
    create_layout_version,
    delete_album,
    delete_layout_version,
    get_album_layout,
    list_canvases,
    rename_layout_version,
    restore_layout_version,
    save_album_layout,
    set_canvas_shelf,
)
from app.db.base import Base
from app.db.models import Album, FileType, Image, LayoutVersion, User


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    yield session
    session.close()


def _image(db: Session, id: str, owner_id: int = 1, edit_rev: int = 0) -> Image:
    image = Image(
        id=id,
        owner_id=owner_id,
        file_path=f"2026/2026-07-01/{id}.jpg",
        original_filename=f"{id}.jpg",
        file_hash=f"hash-{id}",
        file_type=FileType.jpeg,
        file_size=3,
        taken_at=datetime(2026, 7, 1, 12, 0, 0),
        edit_rev=edit_rev,
    )
    db.add(image)
    return image


def _album(db: Session, id: str = "alb", name: str = "Trip") -> Album:
    album = Album(id=id, owner_id=1, name=name)
    db.add(album)
    db.commit()
    return album


def _photo(id: str, image_id: str, **extra) -> schemas.LayoutItemIn:
    return schemas.LayoutItemIn(id=id, kind="photo", image_id=image_id, **extra)


def _save(db: Session, album_id: str, **extra) -> schemas.AlbumLayoutOut:
    user = db.get(User, 1)
    return save_album_layout(album_id, schemas.AlbumLayoutIn(**extra), db=db, current_user=user)


def test_keeping_a_version_freezes_the_canvas_and_makes_it_active(db: Session):
    album = _album(db)
    user = db.get(User, 1)
    _image(db, "a")
    db.commit()
    _save(db, album.id, items=[_photo("i1", "a", x_mm=10)])

    out = create_layout_version(
        album.id, schemas.LayoutVersionIn(name="First draft"), db=db, current_user=user
    )
    assert [v.name for v in out.versions] == ["First draft"]
    assert out.active_version_id == out.versions[0].id

    # Editing on only touches the working layout - the snapshot stays frozen.
    _save(db, album.id, items=[_photo("i1", "a", x_mm=99)])
    restored = restore_layout_version(
        album.id, out.versions[0].id, db=db, current_user=user
    )
    assert restored.items[0].x_mm == 10


def test_a_blank_name_becomes_a_numbered_one(db: Session):
    album = _album(db)
    user = db.get(User, 1)
    _save(db, album.id)
    out = create_layout_version(album.id, schemas.LayoutVersionIn(), db=db, current_user=user)
    assert out.versions[0].name == "Version 1"


def test_keeping_a_version_needs_a_saved_canvas(db: Session):
    album = _album(db)
    user = db.get(User, 1)
    with pytest.raises(HTTPException) as excinfo:
        create_layout_version(album.id, schemas.LayoutVersionIn(), db=db, current_user=user)
    assert excinfo.value.status_code == 404


def test_restoring_keeps_the_shelf_flag(db: Session):
    """Loading an old draft must not silently pull the album off the shelf -
    show_in_canvases belongs to the layout, not to any one design."""
    album = _album(db)
    user = db.get(User, 1)
    _save(db, album.id)
    out = create_layout_version(album.id, schemas.LayoutVersionIn(), db=db, current_user=user)
    _save(db, album.id, show_in_canvases=True)

    restored = restore_layout_version(album.id, out.versions[0].id, db=db, current_user=user)
    assert restored.show_in_canvases is True
    assert restored.active_version_id == out.versions[0].id


def test_renaming_and_deleting_versions(db: Session):
    album = _album(db)
    user = db.get(User, 1)
    _save(db, album.id)
    first = create_layout_version(
        album.id, schemas.LayoutVersionIn(name="one"), db=db, current_user=user
    ).versions[0]
    out = create_layout_version(
        album.id, schemas.LayoutVersionIn(name="two"), db=db, current_user=user
    )
    second = next(v for v in out.versions if v.name == "two")
    assert out.active_version_id == second.id

    out = rename_layout_version(
        album.id, first.id, schemas.LayoutVersionIn(name="one, renamed"), db=db, current_user=user
    )
    assert sorted(v.name for v in out.versions) == ["one, renamed", "two"]

    # Deleting the active version hands the shelf the newest one that remains;
    # deleting the last one leaves nothing active.
    out = delete_layout_version(album.id, second.id, db=db, current_user=user)
    assert out.active_version_id == first.id
    out = delete_layout_version(album.id, first.id, db=db, current_user=user)
    assert out.versions == [] and out.active_version_id is None


def test_the_shelf_shows_only_opted_in_albums_with_a_version(db: Session):
    user = db.get(User, 1)
    _image(db, "a", edit_rev=3)
    db.commit()

    shown = _album(db, "shown", "Shown")
    _save(db, shown.id, show_in_canvases=True, items=[_photo("i1", "a")])
    create_layout_version(shown.id, schemas.LayoutVersionIn(name="keep"), db=db, current_user=user)

    hidden = _album(db, "hidden", "Hidden")  # has a version but never opted in
    _save(db, hidden.id)
    create_layout_version(hidden.id, schemas.LayoutVersionIn(), db=db, current_user=user)

    bare = _album(db, "bare", "Bare")  # opted in but nothing was ever kept
    _save(db, bare.id, show_in_canvases=True)

    cards = list_canvases(db=db, current_user=user)
    assert [card.album_id for card in cards] == ["shown"]
    card = cards[0]
    assert (card.album_name, card.version_name, card.version_count) == ("Shown", "keep", 1)
    assert [item.id for item in card.items] == ["i1"]
    assert card.items[0].available is True
    assert card.thumb_versions == {"a": "3"}


def test_the_shelf_shows_the_active_version_not_the_working_draft(db: Session):
    album = _album(db)
    user = db.get(User, 1)
    _image(db, "a")
    db.commit()
    _save(db, album.id, show_in_canvases=True, items=[_photo("i1", "a", x_mm=10)])
    create_layout_version(album.id, schemas.LayoutVersionIn(), db=db, current_user=user)

    # The user fiddles on; the shelf keeps showing what was kept.
    _save(db, album.id, show_in_canvases=True, items=[_photo("i1", "a", x_mm=99)])
    card = list_canvases(db=db, current_user=user)[0]
    assert card.items[0].x_mm == 10


def test_a_dangling_active_id_falls_back_to_the_newest_version(db: Session):
    album = _album(db)
    user = db.get(User, 1)
    _save(db, album.id, show_in_canvases=True)
    create_layout_version(album.id, schemas.LayoutVersionIn(name="old"), db=db, current_user=user)
    out = create_layout_version(
        album.id, schemas.LayoutVersionIn(name="new"), db=db, current_user=user
    )
    # Simulate a stale pointer (e.g. written by an older build).
    from app.db.models import AlbumLayout

    layout = db.query(AlbumLayout).filter(AlbumLayout.album_id == album.id).first()
    layout.active_version_id = "gone"
    db.commit()

    card = list_canvases(db=db, current_user=user)[0]
    newest = next(v for v in out.versions if v.name == "new")
    assert card.version_id == newest.id


def test_a_trashed_photo_shows_as_unavailable_on_the_shelf(db: Session):
    album = _album(db)
    user = db.get(User, 1)
    image = _image(db, "a")
    db.commit()
    _save(db, album.id, show_in_canvases=True, items=[_photo("i1", "a")])
    create_layout_version(album.id, schemas.LayoutVersionIn(), db=db, current_user=user)

    image.deleted_at = datetime(2026, 8, 1, 9, 0, 0)
    db.commit()
    card = list_canvases(db=db, current_user=user)[0]
    assert card.items[0].available is False
    assert card.thumb_versions == {}


def test_the_shelf_card_x_only_hides_the_canvas(db: Session):
    """Taking a canvas off the shelf is not deleting it: the layout, its
    versions and the active pointer all survive, and the canvas's own checkbox
    can put it back."""
    album = _album(db)
    user = db.get(User, 1)
    _save(db, album.id, show_in_canvases=True)
    create_layout_version(album.id, schemas.LayoutVersionIn(name="keep"), db=db, current_user=user)
    assert len(list_canvases(db=db, current_user=user)) == 1

    set_canvas_shelf(album.id, schemas.CanvasShelfIn(enabled=False), db=db, current_user=user)
    assert list_canvases(db=db, current_user=user) == []
    out = get_album_layout(album.id, db=db, current_user=user)
    assert out.show_in_canvases is False
    assert [v.name for v in out.versions] == ["keep"]
    assert out.active_version_id is not None

    set_canvas_shelf(album.id, schemas.CanvasShelfIn(enabled=True), db=db, current_user=user)
    assert len(list_canvases(db=db, current_user=user)) == 1


def test_the_shelf_switch_needs_a_saved_canvas(db: Session):
    album = _album(db)
    user = db.get(User, 1)
    with pytest.raises(HTTPException) as excinfo:
        set_canvas_shelf(album.id, schemas.CanvasShelfIn(enabled=True), db=db, current_user=user)
    assert excinfo.value.status_code == 404


def test_deleting_the_album_deletes_its_versions_too(db: Session):
    album = _album(db)
    user = db.get(User, 1)
    _save(db, album.id)
    create_layout_version(album.id, schemas.LayoutVersionIn(), db=db, current_user=user)

    delete_album(album.id, db=db, current_user=user)
    assert db.query(LayoutVersion).count() == 0


def test_another_owners_versions_are_not_reachable(db: Session):
    db.add(User(id=2, username="someone-else"))
    db.commit()
    theirs = Album(id="theirs", owner_id=2, name="Private")
    db.add(theirs)
    db.commit()
    user = db.get(User, 1)

    with pytest.raises(HTTPException):
        create_layout_version("theirs", schemas.LayoutVersionIn(), db=db, current_user=user)
    with pytest.raises(HTTPException):
        restore_layout_version("theirs", "v1", db=db, current_user=user)

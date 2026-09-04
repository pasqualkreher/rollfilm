"""The membership tags: a photo in an album carries "album" and
"album: <name>", a photo a canvas holds carries "canvas" and
"canvas: <name>". They follow the albums and canvases themselves (adding,
removing, renaming, deleting, placing on a page, resetting) and can't be
touched by hand - which is why album and canvas names have to be unique.
"""

from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes.albums import (
    add_images_to_album,
    create_album,
    delete_album,
    remove_image_from_album,
    update_album,
)
from app.api.routes.canvases import (
    add_canvas_images,
    clear_canvas_layout,
    create_canvas,
    delete_canvas,
    remove_canvas_images,
    rename_canvas,
    save_canvas_layout,
)
from app.api.routes.images import add_tag, bulk_reset_metadata, remove_tag
from app.api.routes.tags import delete_tag, prune_unused_tags
from app.db.base import Base
from app.db.models import Album, AlbumImage, Canvas, FileType, Image, ImageTag, Tag, User
from app.services.auto_tags import is_auto_tag
from app.services.membership_tags import sync_membership_tags


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    for id in ("a", "b", "c"):
        session.add(
            Image(
                id=id,
                owner_id=1,
                file_path=f"2026/2026-07-01/{id}.jpg",
                original_filename=f"{id}.jpg",
                file_hash=f"hash-{id}",
                file_type=FileType.jpeg,
                file_size=3,
                taken_at=datetime(2026, 7, 1, 12, 0, 0),
            )
        )
    session.commit()
    yield session
    session.close()


def _user(db: Session) -> User:
    return db.get(User, 1)


def _tags(db: Session, image_id: str) -> list[str]:
    db.expire_all()
    return db.get(Image, image_id).tags


def _tag_names(db: Session) -> set[str]:
    return {t.name for t in db.query(Tag).all()}


def _album(db: Session, name: str, *image_ids: str) -> Album:
    album = create_album(schemas.AlbumCreate(name=name), db, _user(db))
    if image_ids:
        add_images_to_album(album.id, schemas.AlbumAddImages(image_ids=list(image_ids)), db, _user(db))
    return db.get(Album, album.id)


def _canvas(db: Session, name: str, *image_ids: str) -> Canvas:
    canvas = create_canvas(schemas.CanvasCreateIn(name=name), db, _user(db))
    if image_ids:
        add_canvas_images(canvas.id, schemas.CanvasImagesIn(image_ids=list(image_ids)), db, _user(db))
    return db.get(Canvas, canvas.id)


# --- Albums -------------------------------------------------------------------


def test_album_members_carry_the_album_and_umbrella_tags(db: Session):
    _album(db, "Trip", "a", "b")
    assert _tags(db, "a") == ["album", "album: Trip"]
    assert _tags(db, "b") == ["album", "album: Trip"]
    assert _tags(db, "c") == []


def test_leaving_the_last_album_drops_both_tags(db: Session):
    album = _album(db, "Trip", "a", "b")
    other = _album(db, "Best of", "a")
    assert _tags(db, "a") == ["album", "album: Best of", "album: Trip"]

    remove_image_from_album(album.id, "a", db, _user(db))
    assert _tags(db, "a") == ["album", "album: Best of"]
    remove_image_from_album(other.id, "a", db, _user(db))
    assert _tags(db, "a") == []
    # The other member is untouched, and the emptied album's tag is gone.
    assert _tags(db, "b") == ["album", "album: Trip"]
    assert "album: Best of" not in _tag_names(db)


def test_renaming_an_album_moves_its_photos_to_the_new_tag(db: Session):
    album = _album(db, "Trip", "a")
    update_album(album.id, schemas.AlbumUpdate(name="Iceland"), db, _user(db))
    assert _tags(db, "a") == ["album", "album: Iceland"]
    assert "album: Trip" not in _tag_names(db)


def test_deleting_an_album_takes_its_tag_with_it(db: Session):
    album = _album(db, "Trip", "a", "b")
    _album(db, "Best of", "b")
    delete_album(album.id, db, _user(db))
    assert _tags(db, "a") == []
    assert _tags(db, "b") == ["album", "album: Best of"]
    assert "album: Trip" not in _tag_names(db)


def test_resetting_album_membership_drops_the_tags(db: Session):
    _album(db, "Trip", "a", "b")
    bulk_reset_metadata(
        schemas.BulkResetRequest(image_ids=["a"], albums=True), db, _user(db)
    )
    assert _tags(db, "a") == []
    assert _tags(db, "b") == ["album", "album: Trip"]


def test_a_tag_reset_leaves_the_membership_tags_alone(db: Session):
    _album(db, "Trip", "a")
    add_tag("a", schemas.AddTagRequest(name="sunset"), db, _user(db))
    bulk_reset_metadata(schemas.BulkResetRequest(image_ids=["a"], tags=True), db, _user(db))
    assert _tags(db, "a") == ["album", "album: Trip"]


def test_tag_rule_members_are_not_tagged(db: Session):
    """Photos that join an album through its tag rule already carry the tag
    the rule names; deriving membership tags from them would feed tag-driven
    membership back into itself."""
    add_tag("c", schemas.AddTagRequest(name="sunset"), db, _user(db))
    create_album(schemas.AlbumCreate(name="Sunsets", tag_filter=["sunset"]), db, _user(db))
    assert _tags(db, "c") == ["sunset"]


# --- Canvases -----------------------------------------------------------------


def test_canvas_members_carry_the_canvas_and_umbrella_tags(db: Session):
    canvas = _canvas(db, "Poster", "a")
    assert _tags(db, "a") == ["canvas", "canvas: Poster"]
    remove_canvas_images(canvas.id, schemas.CanvasImagesIn(image_ids=["a"]), db, _user(db))
    assert _tags(db, "a") == []
    assert "canvas: Poster" not in _tag_names(db)


def test_a_placed_photo_counts_as_in_the_canvas(db: Session):
    """A frame keeps working after its photo left the filmstrip - and the
    photo is still on the page, so it stays tagged until the frame goes."""
    canvas = _canvas(db, "Poster")
    doc = schemas.CanvasLayoutIn(
        items=[schemas.LayoutItemIn(id="f1", kind="photo", image_id="b")]
    )
    save_canvas_layout(canvas.id, doc, db, _user(db))
    assert _tags(db, "b") == ["canvas", "canvas: Poster"]

    save_canvas_layout(canvas.id, schemas.CanvasLayoutIn(items=[]), db, _user(db))
    assert _tags(db, "b") == []

    save_canvas_layout(canvas.id, doc, db, _user(db))
    clear_canvas_layout(canvas.id, db, _user(db))
    assert _tags(db, "b") == []


def test_renaming_and_deleting_a_canvas_follow_through(db: Session):
    canvas = _canvas(db, "Poster", "a")
    rename_canvas(canvas.id, schemas.CanvasRenameIn(name="Wall"), db, _user(db))
    assert _tags(db, "a") == ["canvas", "canvas: Wall"]
    assert "canvas: Poster" not in _tag_names(db)
    delete_canvas(canvas.id, db, _user(db))
    assert _tags(db, "a") == []
    assert "canvas: Wall" not in _tag_names(db)


def test_album_and_canvas_tags_coexist(db: Session):
    _album(db, "Trip", "a")
    _canvas(db, "Trip", "a")
    assert _tags(db, "a") == ["album", "album: Trip", "canvas", "canvas: Trip"]


# --- Unique names -------------------------------------------------------------


def test_album_names_are_unique_per_user_ignoring_case(db: Session):
    album = _album(db, "Trip")
    with pytest.raises(HTTPException) as exc:
        create_album(schemas.AlbumCreate(name=" trip "), db, _user(db))
    assert exc.value.status_code == 409
    other = _album(db, "Best of")
    with pytest.raises(HTTPException) as exc:
        update_album(other.id, schemas.AlbumUpdate(name="TRIP"), db, _user(db))
    assert exc.value.status_code == 409
    # Renaming to the album's own name (in another case) is fine.
    update_album(album.id, schemas.AlbumUpdate(name="TRIP"), db, _user(db))
    assert db.get(Album, album.id).name == "TRIP"


def test_canvas_names_are_unique_per_user_ignoring_case(db: Session):
    _canvas(db, "Poster")
    with pytest.raises(HTTPException) as exc:
        create_canvas(schemas.CanvasCreateIn(name="poster"), db, _user(db))
    assert exc.value.status_code == 409
    other = _canvas(db, "Wall")
    with pytest.raises(HTTPException) as exc:
        rename_canvas(other.id, schemas.CanvasRenameIn(name="Poster"), db, _user(db))
    assert exc.value.status_code == 409


def test_blank_album_names_are_refused(db: Session):
    with pytest.raises(HTTPException) as exc:
        create_album(schemas.AlbumCreate(name="   "), db, _user(db))
    assert exc.value.status_code == 400


# --- Hands off ----------------------------------------------------------------


@pytest.mark.parametrize("name", [" ALBUM: y ", "Canvas", "album", "album: Trip", "canvas: x"])
def test_membership_tags_are_auto_tags(db: Session, name: str):
    assert is_auto_tag(name)
    with pytest.raises(HTTPException) as exc:
        add_tag("a", schemas.AddTagRequest(name=name), db, _user(db))
    assert exc.value.status_code == 400


def test_membership_tags_cannot_be_removed_or_deleted_by_hand(db: Session):
    _album(db, "Trip", "a")
    with pytest.raises(HTTPException):
        remove_tag("a", "album: Trip", db, _user(db))
    with pytest.raises(HTTPException):
        remove_tag("a", "album", db, _user(db))
    with pytest.raises(HTTPException):
        delete_tag("album: Trip", db, _user(db))
    assert _tags(db, "a") == ["album", "album: Trip"]


def test_prune_leaves_idle_membership_tags_alone(db: Session):
    """A stray empty membership tag isn't the user's to prune - the sync owns
    it (and removes it on the next run)."""
    db.add(Tag(owner_id=1, name="album: Old"))
    db.add(Tag(owner_id=1, name="unused"))
    db.commit()
    removed = prune_unused_tags(db, _user(db)).removed
    assert removed == ["unused"]
    assert "album: Old" in _tag_names(db)
    sync_membership_tags(db, 1)
    db.commit()
    assert "album: Old" not in _tag_names(db)


def test_startup_sync_backfills_an_old_library(db: Session):
    """Memberships that predate the tags (or were written by code that doesn't
    know them) get their tags on the next sync."""
    album = Album(id="al", owner_id=1, name="Trip")
    db.add(album)
    db.flush()
    db.add(AlbumImage(album_id="al", image_id="a", position=0))
    # A stale link from a renamed album, left behind by something that bypassed
    # the routes, is cleaned up in the same pass.
    stale = Tag(owner_id=1, name="album: Gone")
    db.add(stale)
    db.flush()
    db.add(ImageTag(image_id="b", tag_id=stale.id))
    db.commit()

    sync_membership_tags(db, 1)
    db.commit()
    assert _tags(db, "a") == ["album", "album: Trip"]
    assert _tags(db, "b") == []
    assert "album: Gone" not in _tag_names(db)


# --- Usage counts for the delete confirmations -------------------------------


def test_usage_counts_album_and_canvas_members_once(db: Session):
    from app.api.routes.images import image_usage

    _album(db, "Trip", "a", "b")
    canvas = _canvas(db, "Poster", "a")
    save_canvas_layout(
        canvas.id,
        schemas.CanvasLayoutIn(items=[schemas.LayoutItemIn(id="f1", kind="photo", image_id="c")]),
        db,
        _user(db),
    )
    out = image_usage(schemas.BulkDeleteRequest(image_ids=["a", "b", "c", "missing"]), db, _user(db))
    # a: album + canvas, b: album, c: placed on the canvas only.
    assert (out.in_album, out.in_canvas, out.in_any) == (2, 2, 3)
    empty = image_usage(schemas.BulkDeleteRequest(image_ids=[]), db, _user(db))
    assert empty.in_any == 0


def test_library_can_be_filtered_to_what_a_canvas_holds(db: Session):
    from app.api.routes.images import list_images

    canvas = _canvas(db, "Poster", "a")
    save_canvas_layout(
        canvas.id,
        schemas.CanvasLayoutIn(items=[schemas.LayoutItemIn(id="f1", kind="photo", image_id="b")]),
        db,
        _user(db),
    )
    ids = {im.id for im in list_images(canvas_id=canvas.id, tags=None, db=db, current_user=_user(db))}
    assert ids == {"a", "b"}

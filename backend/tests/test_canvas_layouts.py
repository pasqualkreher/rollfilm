"""A canvas's layout: the hand-placed design document of a standalone canvas.

Covers the whole-document save (what the canvas holds is what the layout is),
what happens to a frame whose photo goes to the Trash or is deleted for good,
and the guards that keep an unusable page out of the database.
"""

from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes.canvases import (
    clear_canvas_layout,
    delete_canvas,
    get_canvas_layout,
    save_canvas_layout,
)
from app.db.base import Base
from app.db.models import Canvas, CanvasLayout, FileType, Image, LayoutItem, User
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


def _image(db: Session, id: str, owner_id: int = 1) -> Image:
    image = Image(
        id=id,
        owner_id=owner_id,
        file_path=f"2026/2026-07-01/{id}.jpg",
        original_filename=f"{id}.jpg",
        file_hash=f"hash-{id}",
        file_type=FileType.jpeg,
        file_size=3,
        taken_at=datetime(2026, 7, 1, 12, 0, 0),
    )
    db.add(image)
    return image


def _canvas(db: Session) -> Canvas:
    canvas = Canvas(id="cv", owner_id=1, name="Trip")
    db.add(canvas)
    db.commit()
    return canvas


def _photo(id: str, image_id: str, **extra) -> schemas.LayoutItemIn:
    return schemas.LayoutItemIn(id=id, kind="photo", image_id=image_id, **extra)


def test_a_canvas_without_a_saved_layout_reads_as_a_blank_page(db: Session):
    """Opening a canvas must not write anything - otherwise merely browsing
    canvases would leave an empty layout row behind for each."""
    canvas = _canvas(db)
    user = db.get(User, 1)

    out = get_canvas_layout(canvas.id, db=db, current_user=user)
    assert out.items == []
    assert out.page_mode == "pages"
    assert (out.page_width_mm, out.page_height_mm) == (297.0, 210.0)
    assert db.query(CanvasLayout).count() == 0


def test_saving_replaces_the_whole_canvas(db: Session):
    canvas = _canvas(db)
    user = db.get(User, 1)
    _image(db, "a")
    _image(db, "b")
    db.commit()

    save_canvas_layout(
        canvas.id,
        schemas.CanvasLayoutIn(
            page_mode="infinite",
            background="#101010",
            items=[
                _photo("i1", "a", x_mm=10, y_mm=20, width_mm=80, height_mm=60, z=0),
                _photo("i2", "b", x_mm=100, y_mm=20, rotation=12.5, z=1),
                schemas.LayoutItemIn(id="t1", kind="text", text="Summer", z=2, style={"size_mm": 8}),
            ],
        ),
        db=db,
        current_user=user,
    )

    # A second save with fewer items removes what is gone - no orphans left.
    out = save_canvas_layout(
        canvas.id,
        schemas.CanvasLayoutIn(
            page_mode="infinite",
            background="#101010",
            items=[_photo("i1", "a", x_mm=15, y_mm=20, width_mm=80, height_mm=60)],
        ),
        db=db,
        current_user=user,
    )
    assert [item.id for item in out.items] == ["i1"]
    assert out.items[0].x_mm == 15
    assert out.page_mode == "infinite"
    assert out.background == "#101010"
    assert db.query(LayoutItem).count() == 1


def test_text_items_keep_their_style_and_photos_their_frame_crop(db: Session):
    canvas = _canvas(db)
    user = db.get(User, 1)
    _image(db, "a")
    db.commit()

    out = save_canvas_layout(
        canvas.id,
        schemas.CanvasLayoutIn(
            items=[
                _photo("i1", "a", content_scale=1.4, content_dx=-0.1, content_dy=0.05),
                schemas.LayoutItemIn(
                    id="t1", kind="text", text="Chapter one", style={"size_mm": 6, "align": "center"}
                ),
            ]
        ),
        db=db,
        current_user=user,
    )
    photo = next(i for i in out.items if i.id == "i1")
    text = next(i for i in out.items if i.id == "t1")
    assert (photo.content_scale, photo.content_dx, photo.content_dy) == (1.4, -0.1, 0.05)
    assert text.text == "Chapter one"
    assert text.style == {"size_mm": 6, "align": "center"}


def test_a_foreign_or_unknown_photo_is_refused(db: Session):
    """Ids come from the client, so a frame may not smuggle in a photo that
    isn't the owner's (or doesn't exist at all)."""
    canvas = _canvas(db)
    user = db.get(User, 1)
    db.add(User(id=2, username="someone-else"))
    db.commit()
    _image(db, "mine")
    _image(db, "theirs", owner_id=2)
    db.commit()

    out = save_canvas_layout(
        canvas.id,
        schemas.CanvasLayoutIn(
            items=[
                _photo("i1", "mine"),
                _photo("i2", "theirs"),
                _photo("i3", "does-not-exist"),
            ]
        ),
        db=db,
        current_user=user,
    )
    assert [item.id for item in out.items] == ["i1"]


def test_a_trashed_photo_leaves_its_frame_in_place_but_unavailable(db: Session):
    """Same deal as album membership: the Trash is reversible, so the page has
    to come back intact when the photo does."""
    canvas = _canvas(db)
    user = db.get(User, 1)
    image = _image(db, "a")
    db.commit()
    save_canvas_layout(
        canvas.id, schemas.CanvasLayoutIn(items=[_photo("i1", "a")]), db=db, current_user=user
    )

    image.deleted_at = datetime(2026, 8, 1, 9, 0, 0)
    db.commit()
    out = get_canvas_layout(canvas.id, db=db, current_user=user)
    assert [(i.id, i.available) for i in out.items] == [("i1", False)]

    image.deleted_at = None
    db.commit()
    assert get_canvas_layout(canvas.id, db=db, current_user=user).items[0].available is True


def test_deleting_a_photo_for_good_leaves_a_missing_placeholder(db: Session):
    canvas = _canvas(db)
    user = db.get(User, 1)
    image = _image(db, "a")
    _image(db, "b")
    db.commit()
    save_canvas_layout(
        canvas.id,
        schemas.CanvasLayoutIn(items=[_photo("i1", "a"), _photo("i2", "b")]),
        db=db,
        current_user=user,
    )

    image.deleted_at = datetime(2026, 8, 1, 9, 0, 0)
    db.commit()
    hard_delete_images(db, [image], delete_files=False)
    db.commit()

    out = get_canvas_layout(canvas.id, db=db, current_user=user)
    # The frame stays on the page as an honest gap - the design keeps its
    # shape - and the placeholder survives a round-trip through a save.
    assert [(i.id, i.missing, i.image_id) for i in out.items] == [
        ("i1", True, None),
        ("i2", False, "b"),
    ]
    saved = save_canvas_layout(
        canvas.id,
        schemas.CanvasLayoutIn(items=[schemas.LayoutItemIn(**i.model_dump(exclude={"available"})) for i in out.items]),
        db=db,
        current_user=user,
    )
    assert [(i.id, i.missing) for i in saved.items] == [("i1", True), ("i2", False)]


def test_deleting_the_canvas_deletes_its_layout(db: Session):
    canvas = _canvas(db)
    user = db.get(User, 1)
    _image(db, "a")
    db.commit()
    save_canvas_layout(
        canvas.id, schemas.CanvasLayoutIn(items=[_photo("i1", "a")]), db=db, current_user=user
    )

    delete_canvas(canvas.id, db=db, current_user=user)
    assert db.query(CanvasLayout).count() == 0
    assert db.query(LayoutItem).count() == 0


def test_clearing_starts_the_canvas_over(db: Session):
    canvas = _canvas(db)
    user = db.get(User, 1)
    _image(db, "a")
    db.commit()
    save_canvas_layout(
        canvas.id,
        schemas.CanvasLayoutIn(page_mode="infinite", items=[_photo("i1", "a")]),
        db=db,
        current_user=user,
    )

    clear_canvas_layout(canvas.id, db=db, current_user=user)
    out = get_canvas_layout(canvas.id, db=db, current_user=user)
    assert out.items == []
    assert out.page_mode == "pages"  # back to the default page


def test_a_page_or_frame_can_never_be_saved_with_no_area(db: Session):
    """Zero-sized anything is unrecoverable in the UI: there is nothing left to
    grab and drag back out."""
    canvas = _canvas(db)
    user = db.get(User, 1)
    _image(db, "a")
    db.commit()

    out = save_canvas_layout(
        canvas.id,
        schemas.CanvasLayoutIn(
            page_width_mm=0,
            page_height_mm=-5,
            page_count=0,
            grid_mm=0,
            items=[_photo("i1", "a", width_mm=0, height_mm=-3, content_scale=0)],
        ),
        db=db,
        current_user=user,
    )
    assert (out.page_width_mm, out.page_height_mm) == (10.0, 10.0)
    assert out.page_count == 1
    assert out.grid_mm == 1.0
    assert (out.items[0].width_mm, out.items[0].height_mm) == (1.0, 1.0)
    assert out.items[0].content_scale == 0.01


def test_another_owners_canvas_is_not_reachable(db: Session):
    db.add(User(id=2, username="someone-else"))
    db.commit()
    db.add(Canvas(id="theirs", owner_id=2, name="Private"))
    db.commit()
    user = db.get(User, 1)

    with pytest.raises(HTTPException) as excinfo:
        get_canvas_layout("theirs", db=db, current_user=user)
    assert excinfo.value.status_code == 404

    with pytest.raises(HTTPException):
        save_canvas_layout("theirs", schemas.CanvasLayoutIn(), db=db, current_user=user)

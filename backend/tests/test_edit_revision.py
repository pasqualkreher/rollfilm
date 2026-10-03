"""The edit revision is the `?v=` of a photo's thumbnail and preview URLs, and
those URLs are immutable: whatever file is on disk the first time `?v=N` is
asked for is what N shows from then on. The lightbox kept showing the picture
from before an edit because the revision moved while the old file was still
the one on disk. It now moves when the new pixels are there, and not before.
"""

from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes import images as images_routes
from app.api.routes.images import rotate_image, save_edits
from app.db.base import Base
from app.db.models import FileType, Image, User
from app.services import thumbnails


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False)()
    session.add(User(id=1, username="local"))
    session.commit()
    session.add(
        Image(
            id="photo",
            owner_id=1,
            file_path="2026/2026-07-01/photo.raf",
            original_filename="photo.raf",
            file_hash="hash-photo",
            file_type=FileType.raw,
            file_size=3,
            taken_at=datetime(2026, 7, 1, 12, 0, 0),
        )
    )
    session.commit()
    yield session
    session.close()


@pytest.fixture()
def renders(monkeypatch):
    """Stand in for the derivative render: records the revision the photo
    carries WHILE its new pixels are being written, and can be told to fail."""
    state = {"revs": [], "fail": False, "deferred": []}

    def regenerate(image, slot_timeout=None):
        state["revs"].append(image.edit_rev)
        if state["fail"]:
            raise RuntimeError("no pixels")

    monkeypatch.setattr(thumbnails, "regenerate_for_image", regenerate)
    monkeypatch.setattr(thumbnails, "warm_full_cache", lambda image_id: None)
    monkeypatch.setattr(thumbnails, "defer_derivatives", state["deferred"].append)
    monkeypatch.setattr(thumbnails, "take_deferred", lambda image_id: False)
    return state


def _edits(**adjustments) -> schemas.ImageEdits:
    return schemas.ImageEdits(adjustments=adjustments)


def _save(db: Session, payload: schemas.ImageEdits, defer: bool = False) -> Image:
    return save_edits("photo", payload, defer_derivatives=defer, db=db, current_user=db.get(User, 1))


def test_the_revision_moves_after_the_render_not_before(db, renders):
    image = _save(db, _edits(exposure=1.0))
    # While the render ran, the photo still carried its old revision: a view
    # refetching it then asks for the old URL, whose pixels it already has.
    assert renders["revs"] == [0]
    assert image.edit_rev > 0


def test_an_autosave_leaves_the_revision_alone(db, renders):
    first = _save(db, _edits(exposure=1.0)).edit_rev
    image = _save(db, _edits(exposure=2.0), defer=True)
    assert image.edit_rev == first
    assert renders["deferred"] == ["photo"]
    assert len(renders["revs"]) == 1  # nothing rendered for the autosave
    # The values are saved all the same.
    assert '"exposure": 2.0' in image.edit_adjustments or '"exposure":2.0' in image.edit_adjustments


def test_a_failed_render_publishes_nothing_and_is_queued_again(db, renders):
    first = _save(db, _edits(exposure=1.0)).edit_rev
    renders["fail"] = True
    image = _save(db, _edits(exposure=2.0))
    assert image.edit_rev == first
    assert renders["deferred"] == ["photo"]


def test_a_revision_is_never_handed_out_twice(db, renders, monkeypatch):
    """Reset drops the revision to 0. The next edit must not count 1, 2, 3
    again: those URLs still hold the earlier renders."""
    clock = iter(range(1000, 2000))
    monkeypatch.setattr(images_routes.time, "time", lambda: next(clock))
    seen = [_save(db, _edits(exposure=1.0)).edit_rev]
    assert _save(db, _edits()).edit_rev == 0  # reset to the original look
    seen.append(_save(db, _edits(exposure=0.5)).edit_rev)
    seen.append(_save(db, _edits(exposure=0.7)).edit_rev)
    assert len(set(seen)) == 3
    assert seen == sorted(seen)


def test_saves_within_the_same_second_still_get_different_revisions(db, renders, monkeypatch):
    monkeypatch.setattr(images_routes.time, "time", lambda: 5000.0)
    first = _save(db, _edits(exposure=1.0)).edit_rev
    second = _save(db, _edits(exposure=2.0)).edit_rev
    assert second == first + 1


def test_rotate_publishes_after_its_render_too(db, renders):
    image = rotate_image("photo", schemas.RotateRequest(degrees=90), db=db, current_user=db.get(User, 1))
    assert renders["revs"] == [0]
    assert image.edit_rev > 0


def test_the_deferred_worker_gives_its_render_a_revision(db, renders):
    """An editor that never sends its final save: the worker renders the
    autosaved edit, and that render needs a revision or no view would ever
    ask for it."""
    image = _save(db, _edits(exposure=1.0), defer=True)
    assert image.edit_rev == 0
    assert thumbnails._deferred_publish is not None
    thumbnails._deferred_publish(db, image)
    assert db.get(Image, "photo").edit_rev > 0

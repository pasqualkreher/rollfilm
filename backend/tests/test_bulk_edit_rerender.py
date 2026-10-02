"""Bulk edits (reset, preset) write rows and return; the pictures are re-rendered
in the background, and only for photos whose look actually changed. They used
to render inline, one photo after another, which held the wait popup for
minutes on a big selection - most of it spent on photos with nothing to reset.
"""

import json
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes import images as images_routes
from app.api.routes.images import bulk_develop, bulk_reset_metadata
from app.config import settings
from app.db.base import Base
from app.db.models import FileType, Image, Tag, User
from app.services import develop, thumbnails


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False)()
    session.add(User(id=1, username="local"))
    session.commit()
    for id in ("edited", "cropped", "plain"):
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
    user = session.get(User, 1)
    # "edited" carries develop work, "cropped" only geometry, "plain" nothing.
    edited = session.get(Image, "edited")
    edited.edit_adjustments = json.dumps({"exposure": 1.0})
    images_routes._sync_edit_state(session, 1, edited)
    cropped = session.get(Image, "cropped")
    cropped.edit_crop_x, cropped.edit_crop_y = 0.1, 0.1
    cropped.edit_crop_width = cropped.edit_crop_height = 0.5
    images_routes._sync_edit_state(session, 1, cropped)
    session.commit()
    assert user is not None
    yield session
    session.close()


@pytest.fixture()
def rerenders(monkeypatch) -> list[str]:
    queued: list[str] = []
    monkeypatch.setattr(images_routes, "enqueue_rerender", queued.append)
    monkeypatch.setattr(images_routes, "run_backup_soon", lambda: None)
    # The inline path must not run at all any more.
    monkeypatch.setattr(
        images_routes, "_try_regenerate_derivatives", lambda image: pytest.fail("rendered inline")
    )
    return queued


def _user(db: Session) -> User:
    return db.get(User, 1)


def test_develop_reset_rerenders_only_photos_it_changed(db, rerenders):
    bulk_reset_metadata(
        schemas.BulkResetRequest(image_ids=["edited", "cropped", "plain"], develop=True),
        db,
        _user(db),
    )
    assert rerenders == ["edited"]
    db.expire_all()
    assert db.get(Image, "edited").edit_adjustments is None
    # The crop is still there, so "cropped" keeps its "edit" tag and the tag
    # survives the single prune at the end.
    assert "edit" in db.get(Image, "cropped").tags
    assert "edit" not in db.get(Image, "edited").tags


def test_full_edit_reset_prunes_the_emptied_edit_tag(db, rerenders):
    bulk_reset_metadata(
        schemas.BulkResetRequest(
            image_ids=["edited", "cropped", "plain"], develop=True, geometry=True
        ),
        db,
        _user(db),
    )
    assert sorted(rerenders) == ["cropped", "edited"]
    assert db.query(Tag).filter(Tag.name == "edit").first() is None


def test_metadata_only_reset_renders_nothing(db, rerenders):
    bulk_reset_metadata(
        schemas.BulkResetRequest(image_ids=["edited", "cropped", "plain"], tags=True),
        db,
        _user(db),
    )
    assert rerenders == []


def test_preset_rerenders_only_photos_whose_look_moved(db, rerenders):
    look = {"exposure": 0.5}
    bulk_develop(schemas.BulkDevelopRequest(image_ids=["edited", "plain"], adjustments=look), db, _user(db))
    assert sorted(rerenders) == ["edited", "plain"]
    rerenders.clear()
    # The same preset again changes nothing, so nothing is rendered again.
    bulk_develop(schemas.BulkDevelopRequest(image_ids=["edited", "plain"], adjustments=look), db, _user(db))
    assert rerenders == []


def test_preset_without_a_raw_base_goes_on_the_standard_one(db, rerenders):
    # A preset saved before the Normalize switch existed carries no raw_base.
    bulk_develop(schemas.BulkDevelopRequest(image_ids=["plain"], adjustments={"exposure": 0.5}), db, _user(db))
    assert develop.loads(db.get(Image, "plain").edit_adjustments)["raw_base"] == "standard"
    # One that asks for the native exposure keeps it.
    look = {"exposure": 0.5, "raw_base": "native"}
    bulk_develop(schemas.BulkDevelopRequest(image_ids=["plain"], adjustments=look), db, _user(db))
    assert develop.loads(db.get(Image, "plain").edit_adjustments)["raw_base"] == "native"


def test_rerender_drops_the_stale_files_first(db, rerenders):
    out_dir = settings.thumbnail_cache_root / "edited"
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in ("thumbnail.jpg", "preview.jpg", "small.jpg", "full.jpg"):
        (out_dir / name).write_bytes(b"stale")
    bulk_reset_metadata(
        schemas.BulkResetRequest(image_ids=["edited"], develop=True), db, _user(db)
    )
    # Left in place they would be served (and cached for good) under the new
    # edit revision - the desktop shell reads them straight off disk.
    assert not thumbnails.has_derivatives("edited")
    assert not any(out_dir.iterdir())


def test_render_status_counts_photos_until_their_render_is_through(monkeypatch):
    from app.workers import queue

    jobs: list[tuple] = []

    class _Held:
        def submit(self, fn, *args):
            jobs.append((fn, args))

    monkeypatch.setattr(queue, "_executor", _Held())
    monkeypatch.setattr(queue, "ensure_derivatives", lambda image: None)
    monkeypatch.setattr(queue, "schedule_embedding_backfill", lambda: None)
    queue.enqueue_rerender("a")
    queue.enqueue_rerender("b")
    assert queue.rerenders_pending(["a", "b", "other"]) == 2
    fn, args = jobs.pop(0)
    fn(*args)
    assert queue.rerenders_pending(["a", "b", "other"]) == 1
    fn, args = jobs.pop(0)
    fn(*args)
    assert queue.rerenders_pending(["a", "b"]) == 0

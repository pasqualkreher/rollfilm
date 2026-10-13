"""The API as the renderer uses it, through HTTP: the real app.main app, its
routing, validation and response models, against a throwaway SQLite file.

The other route tests call the endpoint functions directly; these go through
TestClient so a broken dependency, a response model that no longer fits or a
filter parameter that stopped being read shows up as the status code and the
JSON the frontend would get. The app's lifespan does not run (TestClient is
not used as a context manager), so none of the startup scans, syncs or
warmups start. Everything a request could hand to a background thread - the
Immich wake-up, the sidecar writer - is replaced with a no-op.
"""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import security
from app.api.routes import images as images_routes
from app.config import settings
from app.db.base import Base
from app.db.models import ColorLabel, FileType, Image, User
from app.db.session import get_db
from app.main import app
from app.services import sidecar as sidecar_service


@pytest.fixture()
def env(tmp_path, monkeypatch):
    # A real file rather than ":memory:": TestClient serves each request on a
    # worker thread with its own connection, and the db-snapshots routes read
    # settings.db_path straight off the disk with VACUUM INTO.
    db_path = tmp_path / "db" / "library.db"
    db_path.parent.mkdir()
    library = tmp_path / "library"
    library.mkdir()
    monkeypatch.setattr(settings, "db_path", db_path)
    monkeypatch.setattr(settings, "library_root", library)
    monkeypatch.setattr(settings, "thumbnail_cache_root", tmp_path / "thumbnails")

    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False)
    with Session() as db:
        db.add(User(id=1, username="local"))
        db.commit()

    def _get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _get_db
    monkeypatch.setattr(images_routes, "run_immich_sync_soon", lambda: None)
    monkeypatch.setattr(sidecar_service, "touch", lambda db, images: None)
    # The gate is open in tests (no token), but another test may have left
    # one behind.
    security.set_api_token(None)
    try:
        yield TestClient(app), Session
    finally:
        app.dependency_overrides.pop(get_db, None)
        engine.dispose()


def _image(id: str, **extra) -> Image:
    fields = dict(
        id=id,
        owner_id=1,
        file_path=f"2026/2026-07-01/{id}.jpg",
        original_filename=f"{id}.jpg",
        file_hash=f"hash-{id}",
        file_type=FileType.jpeg,
        file_size=3,
        width=6000,
        height=4000,
        taken_at=datetime(2026, 7, 1, 12, 0, 0),
        imported_at=datetime(2026, 7, 1, 9, 0, 0),
    )
    fields.update(extra)
    return Image(**fields)


def _add(Session, *images: Image) -> None:
    with Session() as db:
        for image in images:
            db.add(image)
            db.flush()
        db.commit()


def _pair(Session) -> None:
    """A RAW+JPEG pair (r, j), linked both ways like an import links them."""
    _add(Session, _image("j"), _image("r", file_type=FileType.raw, file_path="2026/2026-07-01/r.raf"))
    with Session() as db:
        db.get(Image, "j").paired_image_id = "r"
        db.get(Image, "r").paired_image_id = "j"
        db.commit()


def _assert_error(res, status: int) -> None:
    # Every refusal the frontend shows reads one string out of "detail".
    assert res.status_code == status, res.text
    body = res.json()
    assert set(body) == {"detail"} and isinstance(body["detail"], str) and body["detail"]


# ---- listing, counting and the index with the newer filters -----------------


def _ids_everywhere(client, **params) -> set[str]:
    """The same filter through all three library endpoints, which must agree:
    the grid lays out from /index, the scrollbar is sized from /count and
    the lightbox pages through the list."""
    listed = client.get("/images", params=params)
    assert listed.status_code == 200, listed.text
    index = client.get("/images/index", params=params)
    assert index.status_code == 200, index.text
    count = client.get("/images/count", params=params)
    assert count.status_code == 200, count.text
    listed_ids = {row["id"] for row in listed.json()}
    index_ids = {row["id"] for row in index.json()["images"]}
    assert listed_ids == index_ids, params
    assert count.json() == {"count": len(listed_ids)}, params
    return listed_ids


def test_list_count_and_index_agree_on_the_filters(env):
    client, Session = env
    _add(
        Session,
        _image("pick", flag="pick"),
        _image("reject", flag="reject", imported_at=datetime(2026, 7, 2, 9, 0, 0)),
        _image("gone", missing_since=datetime(2026, 7, 3, 9, 0, 0)),
        _image("trashed", flag="pick", deleted_at=datetime(2026, 7, 4, tzinfo=timezone.utc)),
    )

    assert _ids_everywhere(client) == {"pick", "reject", "gone"}
    assert _ids_everywhere(client, flag="pick") == {"pick"}
    assert _ids_everywhere(client, flag="reject") == {"reject"}
    assert _ids_everywhere(client, flag="unflagged") == {"gone"}
    assert _ids_everywhere(client, missing="true") == {"gone"}
    assert _ids_everywhere(client, imported="2026-07-01") == {"pick", "gone"}
    assert _ids_everywhere(client, imported="2026-07-02") == {"reject"}

    tiles = {row["id"]: row for row in client.get("/images/index").json()["images"]}
    assert tiles["gone"]["missing"] is True
    assert tiles["pick"]["missing"] is False
    assert tiles["pick"]["flag"] == "pick"


def test_a_malformed_import_day_is_a_400(env):
    client, _ = env
    for path in ("/images", "/images/index", "/images/count"):
        _assert_error(client.get(path, params={"imported": "July"}), 400)


# ---- rating, colour and flag, single and bulk, mirrored to the pair ---------


def test_patch_persists_and_mirrors_to_the_pair(env):
    client, Session = env
    _pair(Session)

    res = client.patch("/images/r", json={"rating": 4, "color_label": "red", "flag": "pick"})
    assert res.status_code == 200, res.text
    assert (res.json()["rating"], res.json()["color_label"]) == (4, "red")

    with Session() as db:
        for image_id in ("r", "j"):
            image = db.get(Image, image_id)
            assert (image.rating, image.color_label, image.flag) == (4, ColorLabel.red, "pick"), image_id

    # "" takes the flag off, on both halves; what was not sent stays.
    assert client.patch("/images/j", json={"flag": ""}).status_code == 200
    with Session() as db:
        for image_id in ("r", "j"):
            image = db.get(Image, image_id)
            assert (image.rating, image.flag) == (4, None), image_id


def test_bulk_patch_persists_and_mirrors_to_the_pair(env):
    client, Session = env
    _pair(Session)
    _add(Session, _image("solo"))

    res = client.patch(
        "/images/bulk",
        json={"image_ids": ["j", "solo"], "rating": 2, "color_label": "blue", "flag": "reject"},
    )
    assert res.status_code == 200, res.text
    assert sorted(row["id"] for row in res.json()) == ["j", "solo"]

    with Session() as db:
        for image_id in ("j", "r", "solo"):
            image = db.get(Image, image_id)
            assert (image.rating, image.color_label, image.flag) == (2, ColorLabel.blue, "reject"), image_id


def test_unknown_photos_are_a_404(env):
    client, _ = env
    _assert_error(client.get("/images/nope"), 404)
    _assert_error(client.patch("/images/nope", json={"rating": 1}), 404)
    _assert_error(client.patch("/images/bulk", json={"image_ids": ["nope"], "rating": 1}), 404)


# ---- trash, restore, permanent delete ---------------------------------------


def test_trash_restore_then_delete_for_good(env):
    client, Session = env
    original = settings.library_root / "2026" / "2026-07-01" / "a.jpg"
    original.parent.mkdir(parents=True)
    original.write_bytes(b"jpg")
    _add(Session, _image("a"), _image("b"))

    assert client.post("/images/bulk-delete", json={"image_ids": ["a"]}).status_code == 204
    assert [row["id"] for row in client.get("/images/trash").json()] == ["a"]
    assert _ids_everywhere(client) == {"b"}

    # Only what is in the Trash can be deleted for good.
    _assert_error(client.post("/images/trash/delete", json={"image_ids": ["b"]}), 400)

    res = client.post("/images/trash/restore", json={"image_ids": ["a"]})
    assert res.status_code == 200, res.text
    assert [row["id"] for row in res.json()] == ["a"]
    assert client.get("/images/trash").json() == []
    assert _ids_everywhere(client) == {"a", "b"}

    assert client.post("/images/bulk-delete", json={"image_ids": ["a"]}).status_code == 204
    assert client.post("/images/trash/delete", json={"image_ids": ["a"]}).status_code == 204
    with Session() as db:
        assert db.get(Image, "a") is None
        assert db.get(Image, "b") is not None
    assert not original.exists()
    # The emptied date folders are tidied away, the library root stays.
    assert not original.parent.exists()
    assert settings.library_root.is_dir()


# ---- maintenance -------------------------------------------------------------


def test_missing_files_counts_only_live_photos(env):
    client, Session = env
    _add(
        Session,
        _image("here"),
        _image("gone", missing_since=datetime(2026, 7, 3)),
        _image("gone-trashed", missing_since=datetime(2026, 7, 3), deleted_at=datetime(2026, 7, 4)),
    )
    res = client.get("/maintenance/missing")
    assert res.status_code == 200, res.text
    assert res.json()["count"] == 1


def test_db_snapshots_list_take_and_refuse_unknown_restore(env):
    client, _ = env
    res = client.get("/maintenance/db-snapshots")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["snapshots"] == [] and body["pending_restore"] is None
    assert body["folder"] == str(settings.db_path.parent / "snapshots")

    res = client.post("/maintenance/db-snapshots")
    assert res.status_code == 200, res.text
    taken = res.json()
    assert taken["reason"] == "manual" and taken["size"] > 0
    assert (settings.db_path.parent / "snapshots" / taken["name"]).is_file()

    listed = client.get("/maintenance/db-snapshots").json()["snapshots"]
    assert [entry["name"] for entry in listed] == [taken["name"]]

    _assert_error(client.post("/maintenance/db-snapshots/restore", json={"name": "nope.db"}), 404)

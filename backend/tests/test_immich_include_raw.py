"""Immich "also upload RAW files" option (GitHub issue #2).

Off by default, Immich only ever receives JPEGs. Switched on, a RAW follows
its paired JPEG: whenever the JPEG is synced, the RAW goes along (JPEG first),
and an unpaired RAW is treated like a JPEG. Switching the option off again
only stops new RAW uploads - nothing is removed.
"""

from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes.images import set_images_immich_sync
from app.api.routes.settings import get_immich_settings, update_immich_settings
from app.db.base import Base
from app.db.models import FileType, Image, User
from app.services import immich_sync
from app.services.settings_store import (
    IMMICH_API_KEY,
    IMMICH_BASE_URL,
    IMMICH_INCLUDE_RAW,
    IMMICH_MODE_SELECTIVE,
    IMMICH_SYNC_MODE,
    ImmichConfig,
    get_immich_config,
    set_setting,
)


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
    )
    fields.update(extra)
    return Image(**fields)


def _add_pair(db: Session, jpg: str, raw: str, **jpg_extra) -> None:
    """RAW + JPEG linked symmetrically the way the importer does."""
    db.add(_image(jpg, **jpg_extra))
    db.flush()
    db.add(
        _image(raw, file_type=FileType.raw, original_filename=f"{raw}.raf", paired_image_id=jpg)
    )
    db.flush()
    db.get(Image, jpg).paired_image_id = raw
    db.commit()


def _configure(db: Session, *, include_raw: bool, mode: str = IMMICH_MODE_SELECTIVE) -> None:
    set_setting(db, IMMICH_BASE_URL, "http://immich.test")
    set_setting(db, IMMICH_API_KEY, "key")
    set_setting(db, IMMICH_SYNC_MODE, mode)
    set_setting(db, IMMICH_INCLUDE_RAW, "1" if include_raw else "0")
    db.commit()


@pytest.fixture()
def uploads(monkeypatch, tmp_path: Path) -> list[str]:
    """Stub the network: every upload is recorded (by file stem) and gets an
    asset id; files "exist" as empty temp files."""
    sent: list[str] = []

    def fake_upload(base_url, api_key, path, taken_at=None):
        sent.append(path.stem)
        return "created", f"asset-{path.stem}"

    def fake_path(image: Image) -> Path:
        path = tmp_path / image.original_filename
        path.touch()
        return path

    monkeypatch.setattr(immich_sync, "upload_asset", fake_upload)
    monkeypatch.setattr(immich_sync, "resolve_image_path", fake_path)
    monkeypatch.setattr(immich_sync, "_upload_backoff", {})
    return sent


def test_file_types_follow_the_option() -> None:
    assert ImmichConfig("u", "k").file_types == (FileType.jpeg,)
    assert ImmichConfig("u", "k", include_raw=True).file_types == (FileType.jpeg, FileType.raw)


def test_config_reads_the_option(db: Session) -> None:
    _configure(db, include_raw=False)
    assert get_immich_config(db).include_raw is False
    _configure(db, include_raw=True)
    assert get_immich_config(db).include_raw is True


def test_selective_loop_uploads_only_the_flagged_jpeg_by_default(db, uploads) -> None:
    _configure(db, include_raw=False)
    _add_pair(db, "jpg", "raw", immich_sync=True)

    immich_sync._upload_missing(db, get_immich_config(db))

    assert uploads == ["jpg"]
    assert db.get(Image, "raw").immich_asset_id is None


def test_selective_loop_takes_the_unflagged_raw_along_jpeg_first(db, uploads) -> None:
    _configure(db, include_raw=True)
    # Only the JPEG carries the flag (the grid sends the visible half).
    _add_pair(db, "jpg", "raw", immich_sync=True)
    # An unflagged pair stays off Immich.
    _add_pair(db, "jpg2", "raw2")
    # An unpaired RAW is treated like a JPEG: flagged -> uploaded.
    db.add(_image("lone", file_type=FileType.raw, original_filename="lone.raf", immich_sync=True))
    db.commit()

    immich_sync._upload_missing(db, get_immich_config(db))

    assert uploads == ["jpg", "raw", "lone"]
    assert db.get(Image, "raw").immich_asset_id == "asset-raw"
    assert db.get(Image, "jpg2").immich_asset_id is None
    assert db.get(Image, "raw2").immich_asset_id is None


def test_flag_never_flows_from_raw_to_jpeg_in_the_loop(db, uploads) -> None:
    _configure(db, include_raw=True)
    _add_pair(db, "jpg", "raw")
    db.get(Image, "raw").immich_sync = True
    db.commit()

    immich_sync._upload_missing(db, get_immich_config(db))

    assert uploads == ["raw"]


def test_full_mode_uploads_raws_when_enabled(db, uploads) -> None:
    _configure(db, include_raw=True, mode="full")
    _add_pair(db, "jpg", "raw")

    immich_sync._upload_missing(db, get_immich_config(db))

    assert uploads == ["jpg", "raw"]


def test_turning_the_option_off_keeps_uploaded_raws(db, uploads) -> None:
    _configure(db, include_raw=True, mode="full")
    _add_pair(db, "jpg", "raw")
    immich_sync._upload_missing(db, get_immich_config(db))
    assert db.get(Image, "raw").immich_asset_id == "asset-raw"

    _configure(db, include_raw=False, mode="full")
    immich_sync._upload_missing(db, get_immich_config(db))

    assert db.get(Image, "raw").immich_asset_id == "asset-raw"
    assert uploads == ["jpg", "raw"]


def test_sync_toggle_flags_the_partner_and_queues_the_raw(db, monkeypatch) -> None:
    _configure(db, include_raw=True)
    _add_pair(db, "jpg", "raw")
    queued: list[str] = []
    monkeypatch.setattr(
        "app.api.routes.images.enqueue_immich_upload",
        lambda base_url, api_key, path, taken_at, album_names=(), image_id=None: queued.append(
            image_id
        ),
    )
    monkeypatch.setattr(
        "app.api.routes.images.resolve_image_path", lambda image: Path(__file__)
    )

    set_images_immich_sync(
        schemas.ImmichSyncToggleRequest(image_ids=["jpg"], enabled=True),
        db=db,
        current_user=_User(),
    )

    assert db.get(Image, "raw").immich_sync is True
    assert queued == ["jpg", "raw"]


def test_sync_toggle_queues_only_the_jpeg_by_default(db, monkeypatch) -> None:
    _configure(db, include_raw=False)
    _add_pair(db, "jpg", "raw")
    queued: list[str] = []
    monkeypatch.setattr(
        "app.api.routes.images.enqueue_immich_upload",
        lambda base_url, api_key, path, taken_at, album_names=(), image_id=None: queued.append(
            image_id
        ),
    )
    monkeypatch.setattr(
        "app.api.routes.images.resolve_image_path", lambda image: Path(__file__)
    )

    set_images_immich_sync(
        schemas.ImmichSyncToggleRequest(image_ids=["jpg"], enabled=True),
        db=db,
        current_user=_User(),
    )

    # The flag is kept in step across the pair either way, so switching the
    # option on later lets the loop pick the RAW up.
    assert db.get(Image, "raw").immich_sync is True
    assert queued == ["jpg"]


def test_settings_route_round_trips_the_option(db, monkeypatch) -> None:
    monkeypatch.setattr("app.api.routes.settings.run_immich_sync_soon", lambda: None)
    _configure(db, include_raw=False)
    assert get_immich_settings(db=db, current_user=_User()).include_raw is False

    out = update_immich_settings(
        schemas.ImmichSettingsUpdate(base_url="http://immich.test", include_raw=True),
        db=db,
        current_user=_User(),
    )
    assert out.include_raw is True
    assert get_immich_settings(db=db, current_user=_User()).include_raw is True

    # Omitting the field leaves it untouched.
    update_immich_settings(
        schemas.ImmichSettingsUpdate(base_url="http://immich.test", sync_mode="full"),
        db=db,
        current_user=_User(),
    )
    assert get_immich_settings(db=db, current_user=_User()).include_raw is True

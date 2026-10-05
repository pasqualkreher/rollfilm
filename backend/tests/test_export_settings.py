"""The export dialog's presets and last-used options, as Settings stores them."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes.settings import get_export_settings_route, update_export_settings
from app.db.base import Base
from app.db.models import User
from app.services.settings_store import EXPORT_SETTINGS, set_setting


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


def _put(db: Session, **fields) -> schemas.ExportSettingsOut:
    return update_export_settings(
        payload=schemas.ExportSettingsUpdate(**fields), db=db, current_user=_User()
    )


def test_empty_until_something_is_saved(db):
    out = get_export_settings_route(db=db, current_user=_User())
    assert out.presets == [] and out.last is None


def test_presets_and_last_used_are_kept_apart(db):
    web = schemas.ExportPreset(
        name="Web", options=schemas.ExportOptions(max_size=2048, quality=85, metadata="no_location")
    )
    _put(db, presets=[web])
    # Remembering the last export leaves the presets alone, and the other way round.
    out = _put(db, last=schemas.ExportOptions(format="tiff", destination="folder", dest_dir="/tmp/out"))
    assert [p.name for p in out.presets] == ["Web"] and out.last.format == "tiff"
    out = _put(db, presets=[])
    assert out.presets == [] and out.last.dest_dir == "/tmp/out"


def test_a_name_appears_once_and_blank_names_are_dropped(db):
    first = schemas.ExportPreset(name="Print", options=schemas.ExportOptions(format="jpeg"))
    second = schemas.ExportPreset(name=" Print ", options=schemas.ExportOptions(format="tiff"))
    blank = schemas.ExportPreset(name="  ", options=schemas.ExportOptions())
    out = _put(db, presets=[first, second, blank])
    assert [(p.name, p.options.format) for p in out.presets] == [("Print", "tiff")]


def test_unreadable_stored_settings_count_as_nothing(db):
    set_setting(db, EXPORT_SETTINGS, "{not json")
    db.commit()
    out = get_export_settings_route(db=db, current_user=_User())
    assert out.presets == [] and out.last is None
    set_setting(db, EXPORT_SETTINGS, '{"presets": [{"name": "Old", "options": {"format": "webp"}}], "last": 3}')
    db.commit()
    out = get_export_settings_route(db=db, current_user=_User())
    assert out.presets == [] and out.last is None

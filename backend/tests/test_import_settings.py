"""The Import settings: which answers the Import page remembers instead of
asking - the copy-or-leave question when photos are picked, and the
keep-or-close question after photos were added."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes.settings import get_import_settings, update_import_settings
from app.db.base import Base
from app.db.models import User
from app.schemas import ImportSettingsUpdate


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


def test_both_questions_are_asked_until_an_answer_is_remembered(db):
    out = get_import_settings(db, _User())
    assert (out.mode_default, out.after_commit) == ("ask", "ask")


def test_each_answer_is_remembered_on_its_own(db):
    out = update_import_settings(ImportSettingsUpdate(after_commit="keep"), db, _User())
    assert (out.mode_default, out.after_commit) == ("ask", "keep")
    out = update_import_settings(ImportSettingsUpdate(mode_default="copy"), db, _User())
    assert (out.mode_default, out.after_commit) == ("copy", "keep")
    out = get_import_settings(db, _User())
    assert (out.mode_default, out.after_commit) == ("copy", "keep")
    # Back to asking, without touching the other answer.
    out = update_import_settings(ImportSettingsUpdate(after_commit="ask"), db, _User())
    assert (out.mode_default, out.after_commit) == ("copy", "ask")


def test_new_photos_start_selected_until_changed(db):
    assert get_import_settings(db, _User()).select_default == "select"
    out = update_import_settings(ImportSettingsUpdate(select_default="deselect"), db, _User())
    assert (out.mode_default, out.after_commit, out.select_default) == ("ask", "ask", "deselect")
    assert get_import_settings(db, _User()).select_default == "deselect"


def test_an_unknown_stored_select_default_reads_as_select(db):
    from app.services.settings_store import IMPORT_SELECT_DEFAULT, set_setting

    set_setting(db, IMPORT_SELECT_DEFAULT, "bogus")
    db.commit()
    assert get_import_settings(db, _User()).select_default == "select"

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


def test_new_photos_start_unselected_until_changed(db):
    assert get_import_settings(db, _User()).select_default == "deselect"
    out = update_import_settings(ImportSettingsUpdate(select_default="select"), db, _User())
    assert (out.mode_default, out.after_commit, out.select_default) == ("ask", "ask", "select")
    assert get_import_settings(db, _User()).select_default == "select"


def test_an_unknown_stored_select_default_reads_as_deselect(db):
    from app.services.settings_store import IMPORT_SELECT_DEFAULT, set_setting

    set_setting(db, IMPORT_SELECT_DEFAULT, "bogus")
    db.commit()
    assert get_import_settings(db, _User()).select_default == "deselect"


def test_the_backup_default_is_off_until_remembered(db):
    assert get_import_settings(db, _User()).backup_default == "delete"
    out = update_import_settings(ImportSettingsUpdate(backup_default="keep"), db, _User())
    assert (out.mode_default, out.backup_default) == ("ask", "keep")
    assert get_import_settings(db, _User()).backup_default == "keep"


def test_mode_and_backup_are_remembered_together(db):
    out = update_import_settings(
        ImportSettingsUpdate(mode_default="copy", backup_default="keep"), db, _User()
    )
    assert (out.mode_default, out.backup_default, out.after_commit) == ("copy", "keep", "ask")
    # Back to asking keeps the backup answer as the dialog's pre-selection.
    out = update_import_settings(ImportSettingsUpdate(mode_default="ask"), db, _User())
    assert (out.mode_default, out.backup_default) == ("ask", "keep")

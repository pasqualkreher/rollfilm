"""Shutter speeds as stored: parsed, merged across spellings, matched by value."""

from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.db.models import FileType, Image, User
from app.services import exposure


def test_shutter_strings_parse_as_exposure_time():
    assert exposure.shutter_seconds("1/250") == pytest.approx(1 / 250)
    assert exposure.shutter_seconds("0.004") == 0.004
    assert exposure.shutter_seconds("0.5") == 0.5
    assert exposure.shutter_seconds("2") == 2
    assert exposure.shutter_seconds("1/250 s") == pytest.approx(1 / 250)
    assert exposure.shutter_seconds("undef") is None
    assert exposure.shutter_seconds("1/0") is None
    assert exposure.shutter_seconds(None) is None


def test_two_spellings_of_a_stop_share_one_key():
    assert exposure.shutter_key(1 / 250) == exposure.shutter_key(0.004)
    assert exposure.shutter_key(1 / 250) != exposure.shutter_key(1 / 500)


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    for i, text in enumerate(("0.004", "1/250", "1/250 s", "2", "undef", "", None)):
        session.add(Image(
            id=f"p{i}", owner_id=1, file_path=f"x/p{i}.jpg", original_filename=f"p{i}.jpg",
            file_hash=f"h{i}", file_type=FileType.jpeg, file_size=3,
            taken_at=datetime(2026, 7, 1, 12, 0, i), shutter_speed=text,
        ))
    session.commit()
    yield session
    session.close()


def test_strings_between_matches_every_spelling_inside_the_window(db):
    assert sorted(exposure.shutter_strings_between(db, 1, 0.004, 0.004)) == ["0.004", "1/250", "1/250 s"]
    assert exposure.shutter_strings_between(db, 1, 1.0, None) == ["2"]
    assert sorted(exposure.shutter_strings_between(db, 1, None, 0.01)) == ["0.004", "1/250", "1/250 s"]
    assert exposure.shutter_strings_between(db, 1, 0.005, 0.5) == []
    # Another owner's photos are not consulted.
    assert exposure.shutter_strings_between(db, 2, None, None) == []

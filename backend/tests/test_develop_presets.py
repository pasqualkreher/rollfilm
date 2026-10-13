"""Editor presets in the library: one name once, the file they travel in
(version 1 from the browser days and version 2 with sections), and applying
only some sections of a look - the rest of the photo's edit stays."""

import json
from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes import develop_presets as routes
from app.api.routes import images as images_routes
from app.api.routes.images import bulk_develop
from app.db.base import Base
from app.db.models import FileType, Image, User
from app.services import develop
from app.services import develop_presets as service


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False)()
    session.add(User(id=1, username="local"))
    session.commit()
    for id in ("a", "b"):
        session.add(Image(id=id, owner_id=1, file_path=f"{id}.jpg", original_filename=f"{id}.jpg",
                          file_hash=id, file_type=FileType.jpeg, file_size=1,
                          taken_at=datetime(2026, 7, 1)))
    session.commit()
    yield session
    session.close()


def _user(db: Session) -> User:
    return db.get(User, 1)


def _create(db, name, **kw):
    return routes.create_preset(schemas.DevelopPresetIn(name=name, **kw), db, _user(db))


# --- CRUD ----------------------------------------------------------------------


def test_create_list_update_delete(db):
    made = _create(db, "Warm", group="Mine", adjustments={"temperature": 30})
    assert made["sections"] == list(develop.SECTIONS)  # none said: all of them
    assert made["adjustments"]["temperature"] == 30

    _create(db, "Cool", sections=["color", "nonsense"], adjustments={"temperature": -30})
    listed = routes.list_presets(db, _user(db))
    # Ungrouped first, then the folders.
    assert [p["name"] for p in listed] == ["Cool", "Warm"]
    assert listed[0]["sections"] == ["color"]

    changed = routes.update_preset(
        made["id"], schemas.DevelopPresetUpdate(name="Warmer", group=None, sections=["tone", "color"]),
        db, _user(db),
    )
    assert changed["name"] == "Warmer" and changed["group"] is None
    assert changed["sections"] == ["tone", "color"]
    assert changed["adjustments"]["temperature"] == 30  # not sent, kept

    routes.delete_preset(made["id"], db, _user(db))
    assert [p["name"] for p in routes.list_presets(db, _user(db))] == ["Cool"]
    with pytest.raises(HTTPException) as err:
        routes.delete_preset(made["id"], db, _user(db))
    assert err.value.status_code == 404


def test_a_name_is_taken_once(db):
    first = _create(db, "Look")
    with pytest.raises(HTTPException) as err:
        _create(db, "  Look ")
    assert err.value.status_code == 409
    other = _create(db, "Other")
    with pytest.raises(HTTPException) as err:
        routes.update_preset(other["id"], schemas.DevelopPresetUpdate(name="Look"), db, _user(db))
    assert err.value.status_code == 409
    # Renaming to its own name is no clash.
    routes.update_preset(first["id"], schemas.DevelopPresetUpdate(name="Look"), db, _user(db))
    with pytest.raises(HTTPException) as err:
        _create(db, "   ")
    assert err.value.status_code == 400


# --- the file ------------------------------------------------------------------


def test_a_version_1_file_imports_with_every_section(db):
    v1 = {  # what frontend/src/utils/presets.ts presetsToFile writes
        "format": "rollfilm-presets",
        "version": 1,
        "presets": {
            "Faded": {"adjustments": {"contrast": -20, "film_sim": "classic_chrome"}},
            " ": {"adjustments": {}},
            "Broken": {"nothing": 1},
        },
    }
    result = routes.import_presets(v1, db, _user(db))
    assert (result.created, result.replaced) == (1, 0)
    (preset,) = result.presets
    assert preset.name == "Faded" and preset.group is None
    assert preset.sections == list(develop.SECTIONS)
    assert preset.adjustments["film_sim"] == "classic_chrome"


def test_a_version_2_file_round_trips_and_replaces_by_name(db):
    _create(db, "Grain", group="Film", sections=["effects"], adjustments={"grain_amount": 40})
    _create(db, "Mono", sections=["film", "tone"], adjustments={"film_sim": "acros", "contrast": 15})
    doc = routes.export_presets(db, _user(db))
    assert doc["format"] == "rollfilm-presets" and doc["version"] == 2
    assert {p["name"]: p["sections"] for p in doc["presets"]} == {"Mono": ["film", "tone"], "Grain": ["effects"]}
    assert set(doc["presets"][0]) == {"name", "group", "sections", "adjustments"}

    doc["presets"][0]["adjustments"]["contrast"] = 99  # "Mono", ungrouped, comes first
    result = routes.import_presets(json.loads(json.dumps(doc)), db, _user(db))
    assert (result.created, result.replaced) == (0, 2)
    mono = next(p for p in result.presets if p.name == "Mono")
    assert mono.adjustments["contrast"] == 99 and mono.sections == ["film", "tone"]
    grain = next(p for p in result.presets if p.name == "Grain")
    assert grain.group == "Film"


def test_not_a_preset_file_is_refused(db):
    for doc in ({"format": "something"}, {"format": "rollfilm-presets", "presets": 3}, ["x"]):
        with pytest.raises(HTTPException) as err:
            routes.import_presets(doc, db, _user(db))
        assert err.value.status_code == 400


# --- applying some sections ------------------------------------------------------


def test_merge_sections_takes_only_the_chosen_groups():
    current = develop.normalize({
        "exposure": 1.0, "temperature": 20, "grain_amount": 30, "sharpness": 40,
        "point_curves": {"luma": [[0, 10], [255, 250]]}, "frame_width": 5, "process": "5",
        "spots": [{"x": 0.5, "y": 0.5}],
    })
    preset = develop.normalize({
        "exposure": -1.0, "temperature": -40, "grain_amount": 80, "sharpness": 10,
        "film_sim": "velvia", "process": "7", "frame_width": 10,
        "masks": [{"id": "m", "sub_masks": [{"type": "all"}], "adjustments": {"exposure": 1}}],
    })
    out = develop.merge_sections(current, preset, ["color", "effects"])
    assert out["temperature"] == -40 and out["grain_amount"] == 80
    # Everything else is the photo's own.
    assert out["exposure"] == 1.0 and out["sharpness"] == 40 and out["film_sim"] == "none"
    assert out["point_curves"]["luma"] == [[0, 10], [255, 250]]
    assert out["masks"] == [] and len(out["spots"]) == 1
    assert out["frame_width"] == 5 and out["process"] == "5"

    out = develop.merge_sections(current, preset, ["masks", "film"])
    assert len(out["masks"]) == 1 and out["film_sim"] == "velvia" and out["exposure"] == 1.0


def test_a_photo_without_an_edit_takes_the_presets_process():
    preset = develop.normalize({"contrast": 20, "process": "7"})
    assert develop.merge_sections({}, preset, ["tone"])["process"] == "7"
    assert develop.merge_sections({}, preset, [])["process"] == "1"


def test_bulk_apply_with_sections_keeps_the_rest(db, monkeypatch):
    monkeypatch.setattr(images_routes, "enqueue_rerender", lambda image_id, undo=None: None)
    a = db.get(Image, "a")
    a.edit_adjustments = develop.dumps({"exposure": 1.0, "grain_amount": 10, "process": "7",
                                        "spots": [{"x": 0.2, "y": 0.2}]})
    db.commit()
    look = {"exposure": -0.5, "grain_amount": 60, "contrast": 30, "raw_base": "standard",
            "spots": [{"x": 0.9, "y": 0.9}]}
    bulk_develop(
        schemas.BulkDevelopRequest(image_ids=["a", "b"], adjustments=look, sections=["effects"]),
        db, _user(db),
    )
    adj_a = develop.loads(db.get(Image, "a").edit_adjustments)
    assert adj_a["grain_amount"] == 60
    assert adj_a["exposure"] == 1.0 and adj_a["contrast"] == 0
    assert [(s["x"], s["y"]) for s in adj_a["spots"]] == [(0.2, 0.2)]  # its own spots stay
    adj_b = develop.loads(db.get(Image, "b").edit_adjustments)
    assert adj_b["grain_amount"] == 60 and adj_b["exposure"] == 0.0

    # Without sections the whole look replaces the photo's, as it always did.
    bulk_develop(schemas.BulkDevelopRequest(image_ids=["a"], adjustments=look), db, _user(db))
    adj_a = develop.loads(db.get(Image, "a").edit_adjustments)
    assert adj_a["exposure"] == -0.5 and adj_a["contrast"] == 30 and adj_a["spots"] == []


def test_clean_sections_keeps_order_and_drops_unknowns():
    assert service.clean_sections(["retouch", "tone", "tone", "x"]) == ["tone", "retouch"]
    assert service.clean_sections(None) == list(develop.SECTIONS)
    assert service.clean_sections([]) == []

"""The statistics dashboard is cross-filtered: every chart is computed under
all pinned filters except its own dimension, the headline numbers under all of
them. These tests pin that contract and the bucket definitions the client
only knows by key."""

from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes.stats import library_stats, shutter_seconds
from app.db.base import Base
from app.db.models import FileType, Image, User


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


def _stats(db: Session, **filters):
    return library_stats(db=db, current_user=_User(), **filters)


def _counts(rows) -> dict[str, int]:
    return {r.key: r.count for r in rows}


def _seed(db: Session) -> None:
    # Two bodies, three lenses, two years, a spread of exposure settings.
    db.add_all(
        [
            _image(
                "a", camera_model="X-T5", lens_model="XF23", focal_length=23.0,
                iso=400, aperture=2.0, shutter_speed="1/250",
                taken_at=datetime(2024, 3, 10, 9, 0), rating=4,
            ),
            _image(
                "b", camera_model="X-T5", lens_model="XF56", focal_length=56.0,
                iso=1600, aperture=1.2, shutter_speed="1/60",
                taken_at=datetime(2024, 7, 2, 21, 0), rating=0,
            ),
            _image(
                "c", camera_model="X-T5", lens_model="XF23", focal_length=23.0,
                iso=125, aperture=8.0, shutter_speed="2",
                taken_at=datetime(2025, 7, 3, 12, 0), rating=5, file_type=FileType.raw,
            ),
            _image(
                "d", camera_model="A7", lens_model="FE35", focal_length=35.0,
                iso=6400, aperture=2.8, shutter_speed="1/4000",
                taken_at=datetime(2025, 12, 24, 18, 0), rating=4,
                gps_lat=1.0, gps_lon=2.0, gps_country="Germany",
            ),
        ]
    )
    db.commit()


def test_shutter_strings_parse_as_exposure_time():
    assert shutter_seconds("1/250") == pytest.approx(1 / 250)
    assert shutter_seconds("0.5") == 0.5
    assert shutter_seconds("2") == 2
    assert shutter_seconds("1/250 s") == pytest.approx(1 / 250)
    assert shutter_seconds("undef") is None
    assert shutter_seconds("1/0") is None
    assert shutter_seconds(None) is None


def test_unfiltered_snapshot_buckets_every_dimension(db):
    _seed(db)
    s = _stats(db)

    assert s.library_total_photos == s.total_photos == 4
    assert _counts(s.cameras) == {"X-T5": 3, "A7": 1}
    assert [r.key for r in s.cameras] == ["X-T5", "A7"]  # most used first
    assert _counts(s.lenses) == {"XF23": 2, "XF56": 1, "FE35": 1}
    assert _counts(s.focal_buckets) == {"wide": 2, "semi_wide": 1, "short_tele": 1}
    # ISO 125 is nearer 100 than 200; the rest sit on their stops.
    assert _counts(s.isos) == {"iso_100": 1, "iso_400": 1, "iso_1600": 1, "iso_6400": 1}
    assert [r.key for r in s.isos] == ["iso_100", "iso_400", "iso_1600", "iso_6400"]
    assert s.isos[0].name == "ISO 100 and below"
    # f/1.2 lands in the widest bucket, f/2 and f/2.8 on their own stops.
    assert _counts(s.apertures) == {"f_1.4": 1, "f_2": 1, "f_2.8": 1, "f_8": 1}
    assert _counts(s.shutters) == {"very_fast": 1, "handheld": 2, "long": 1}
    assert [r.key for r in s.shutters] == ["very_fast", "handheld", "long"]
    assert _counts(s.years) == {"2024": 2, "2025": 2}
    assert _counts(s.months) == {"03": 1, "07": 2, "12": 1}
    assert {r.key: r.name for r in s.months} == {"03": "Mar", "07": "Jul", "12": "Dec"}
    assert _counts(s.ratings) == {"1": 0, "2": 0, "3": 0, "4": 2, "5": 1}
    assert _counts(s.file_types) == {"jpeg": 3, "raw": 1}
    assert _counts(s.countries) == {"Germany": 1}
    assert set(s.available) == {
        "camera", "lens", "focal", "year", "month", "rating",
        "file_type", "iso", "aperture", "shutter", "country",
    }


def test_a_pinned_camera_narrows_everything_but_the_camera_chart(db):
    _seed(db)
    s = _stats(db, camera="A7")

    # Headline numbers: only the A7's photo.
    assert s.total_photos == 1
    assert s.library_total_photos == 4
    assert s.lens_count == 1
    assert s.with_gps_count == 1
    assert s.rated_count == 1
    # Its own chart keeps every alternative ...
    assert _counts(s.cameras) == {"X-T5": 3, "A7": 1}
    # ... while the others show only what the A7 shot.
    assert _counts(s.lenses) == {"FE35": 1}
    assert _counts(s.isos) == {"iso_6400": 1}
    assert _counts(s.years) == {"2025": 1}
    assert _counts(s.shutters) == {"very_fast": 1}
    assert _counts(s.ratings) == {"1": 0, "2": 0, "3": 0, "4": 1, "5": 0}
    # Availability describes the library, not the filtered view.
    assert "shutter" in s.available


def test_two_filters_each_chart_lifts_only_its_own(db):
    _seed(db)
    s = _stats(db, camera="X-T5", year="2024")

    assert s.total_photos == 2
    # Camera chart: year still applies -> the A7 (2025) is gone.
    assert _counts(s.cameras) == {"X-T5": 2}
    # Year chart: camera still applies -> both X-T5 years, no A7.
    assert _counts(s.years) == {"2024": 2, "2025": 1}
    # Any other chart: both apply.
    assert _counts(s.lenses) == {"XF23": 1, "XF56": 1}
    assert _counts(s.months) == {"03": 1, "07": 1}


def test_bucket_filters_use_the_server_side_bounds(db):
    _seed(db)
    assert _stats(db, focal="wide").total_photos == 2
    assert _stats(db, iso="iso_100").total_photos == 1
    assert _stats(db, aperture="f_2.8").total_photos == 1
    assert _stats(db, shutter="handheld").total_photos == 2
    assert _stats(db, shutter="handheld", lens="XF56").total_photos == 1
    assert _stats(db, month="7").total_photos == 2  # "7" and "07" both work
    assert _stats(db, rating=4).total_photos == 2  # exactly four stars, not "at least"
    assert _stats(db, file_type="raw").total_photos == 1
    assert _stats(db, country="Germany").total_photos == 1
    # An unknown bucket key matches nothing rather than everything.
    assert _stats(db, focal="nope").total_photos == 0
    assert _stats(db, file_type="gif").total_photos == 0


def test_the_pinned_value_is_kept_when_it_falls_outside_the_top_ten(db):
    # Eleven busy cameras ahead of one with a single photo.
    for i in range(11):
        for n in range(3):
            db.add(_image(f"c{i}-{n}", camera_model=f"Cam {i:02d}"))
    db.add(_image("rare", camera_model="Rare"))
    db.commit()

    assert "Rare" not in _counts(_stats(db).cameras)
    pinned = _stats(db, camera="Rare")
    assert pinned.total_photos == 1
    assert _counts(pinned.cameras)["Rare"] == 1
    assert len(pinned.cameras) == 11


def test_dimensions_without_data_are_reported_unavailable(db):
    db.add(_image("plain"))
    db.commit()
    s = _stats(db)
    assert s.available == ["year", "month", "file_type"]
    assert s.countries == [] and s.shutters == [] and s.isos == []
    assert _counts(s.file_types) == {"jpeg": 1}

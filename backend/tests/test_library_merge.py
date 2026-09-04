"""Merging a travel library into the library at home.

The point of the feature is the metadata: importing the travel drive as a plain
folder already brings the photos across, but throws away the stars, colours,
edits and albums that the trip was actually spent on. These tests pin that the
merge carries them - and that it stays additive, never touching the source and
never removing anything here.
"""

from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.db.base import Base
from app.db.models import (
    Album,
    AlbumImage,
    ColorLabel,
    FileType,
    Image,
    ImageTag,
    SourceRoot,
    Tag,
    User,
)
from app.services.library_merge import MergeError, inspect_library, merge_library


def _session_for(db_path: Path) -> Session:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(f"sqlite:///{db_path}")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    return session


def _stamp_schema(session: Session, revision: str) -> None:
    """Both libraries have to agree on the schema revision - the merge refuses
    otherwise, and the in-memory test schema has no alembic table at all."""
    from sqlalchemy import text

    session.execute(text("CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32))"))
    session.execute(text("DELETE FROM alembic_version"))
    session.execute(text("INSERT INTO alembic_version VALUES (:v)"), {"v": revision})
    session.commit()


def _add_photo(
    session: Session,
    root: Path,
    name: str,
    content: bytes,
    *,
    taken: datetime,
    file_type: FileType = FileType.jpeg,
    **fields,
) -> Image:
    """Write a file into `root` the way a library holds it, plus its row."""
    relative = f"{taken.year:04d}/{taken.strftime('%Y-%m-%d')}/{name}"
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    image = Image(
        owner_id=1,
        file_path=relative,
        original_filename=name,
        file_hash=f"hash-of-{content.decode()}",
        file_type=file_type,
        file_size=len(content),
        taken_at=taken,
        **fields,
    )
    session.add(image)
    session.commit()
    return image


@pytest.fixture()
def home(tmp_path, monkeypatch) -> Session:
    """This machine's library: settings point at it, as they would in the app."""
    root = tmp_path / "home"
    root.mkdir()
    monkeypatch.setattr(settings, "library_root", root)
    monkeypatch.setattr(settings, "thumbnail_cache_root", tmp_path / "home-thumbs")
    (tmp_path / "home-thumbs").mkdir()

    session = _session_for(root / ".photomanager" / "db" / "library.db")
    _stamp_schema(session, "test-rev")
    # The merge reads the running app's revision through db.session.engine.
    monkeypatch.setattr(
        "app.services.library_merge._current_schema_revision", lambda: "test-rev"
    )
    return session


@pytest.fixture()
def travel(tmp_path) -> tuple[Path, Session]:
    """The small drive taken on the trip, with its own library on it."""
    root = tmp_path / "travel"
    root.mkdir()
    session = _session_for(root / ".photomanager" / "db" / "library.db")
    _stamp_schema(session, "test-rev")
    return root, session


def test_new_photo_arrives_with_its_review_work(home, travel):
    """A photo only on the travel drive is copied in - with the stars, colour
    and edit it was given on the trip."""
    root, source = travel
    _add_photo(
        source,
        root,
        "DSCF0001.JPG",
        b"alpha",
        taken=datetime(2026, 7, 14, tzinfo=timezone.utc),
        rating=4,
        color_label=ColorLabel.green,
        edit_adjustments='{"exposure": 30}',
    )

    result = merge_library(home, 1, root)

    assert result["added"] == 1
    merged = home.query(Image).one()
    assert merged.rating == 4
    assert merged.color_label == ColorLabel.green
    assert merged.edit_adjustments == '{"exposure": 30}'
    assert (settings.library_root / merged.file_path).read_bytes() == b"alpha"
    # The travel drive is only ever read.
    assert (root / "2026/2026-07-14/DSCF0001.JPG").exists()


def test_photo_already_here_keeps_its_file_but_takes_the_trip_rating(home, travel):
    """Same bytes on both sides: the file isn't copied again, but the review
    work done on the road is the newer decision and wins."""
    taken = datetime(2026, 7, 14, tzinfo=timezone.utc)
    _add_photo(home, settings.library_root, "DSCF0001.JPG", b"alpha", taken=taken, rating=1)
    root, source = travel
    _add_photo(
        source, root, "DSCF0001.JPG", b"alpha", taken=taken, rating=5, color_label=ColorLabel.red
    )

    result = merge_library(home, 1, root)

    assert (result["added"], result["updated"]) == (0, 1)
    kept = home.query(Image).one()
    assert kept.rating == 5
    assert kept.color_label == ColorLabel.red
    # Its own file stayed where it was - nothing was copied over it.
    assert kept.file_path == "2026/2026-07-14/DSCF0001.JPG"


def test_same_filename_same_day_does_not_collide(home, travel):
    """Two different photos can carry the same camera filename from the same
    day - the second one has to land beside the first, not on top of it."""
    taken = datetime(2026, 7, 14, tzinfo=timezone.utc)
    _add_photo(home, settings.library_root, "DSCF0001.JPG", b"home-shot", taken=taken)
    root, source = travel
    _add_photo(source, root, "DSCF0001.JPG", b"travel-shot", taken=taken)

    merge_library(home, 1, root)

    paths = sorted(i.file_path for i in home.query(Image))
    assert paths == ["2026/2026-07-14/DSCF0001.JPG", "2026/2026-07-14/DSCF0001_1.JPG"]
    for image in home.query(Image):
        assert (settings.library_root / image.file_path).exists()


def test_tags_and_albums_merge_by_name(home, travel):
    """An "iceland" tag and an "Iceland 2026" album that already exist here get
    the incoming photos attached - not a second one of each."""
    taken = datetime(2026, 7, 14, tzinfo=timezone.utc)
    existing_tag = Tag(owner_id=1, name="iceland")
    existing_album = Album(owner_id=1, name="Iceland 2026")
    home.add_all([existing_tag, existing_album])
    home.commit()

    root, source = travel
    photo = _add_photo(source, root, "DSCF0002.JPG", b"beta", taken=taken)
    tag = Tag(owner_id=1, name="iceland")
    album = Album(owner_id=1, name="Iceland 2026")
    source.add_all([tag, album])
    source.commit()
    source.add(ImageTag(image_id=photo.id, tag_id=tag.id))
    source.add(AlbumImage(album_id=album.id, image_id=photo.id, position=0))
    source.commit()

    merge_library(home, 1, root)

    assert home.query(Album).count() == 1
    merged = home.query(Image).one()
    assert home.query(AlbumImage).filter(AlbumImage.image_id == merged.id).count() == 1
    # One "iceland" tag - plus the membership tags the merged album earns it.
    assert merged.tags == ["album", "album: Iceland 2026", "iceland"]
    assert home.query(Tag).count() == 3


def test_raw_jpeg_pairs_stay_linked(home, travel):
    """The pair link points at ids that only exist in the travel library - it
    has to be re-pointed at the rows created here."""
    taken = datetime(2026, 7, 14, tzinfo=timezone.utc)
    root, source = travel
    jpg = _add_photo(source, root, "DSCF0003.JPG", b"gamma-jpg", taken=taken)
    raw = _add_photo(
        source, root, "DSCF0003.RAF", b"gamma-raw", taken=taken, file_type=FileType.raw
    )
    jpg.paired_image_id = raw.id
    raw.paired_image_id = jpg.id
    source.commit()

    merge_library(home, 1, root)

    images = {i.original_filename: i for i in home.query(Image)}
    assert images["DSCF0003.JPG"].paired_image_id == images["DSCF0003.RAF"].id
    assert images["DSCF0003.RAF"].paired_image_id == images["DSCF0003.JPG"].id


def test_trashed_and_external_photos_stay_behind(home, travel):
    """Photos thrown away on the trip were a decision; photos only indexed in
    place from an external drive aren't the travel library's to hand over."""
    taken = datetime(2026, 7, 14, tzinfo=timezone.utc)
    root, source = travel
    _add_photo(source, root, "keep.JPG", b"keep", taken=taken)
    _add_photo(source, root, "trashed.JPG", b"trashed", taken=taken, deleted_at=taken)
    external_root = SourceRoot(owner_id=1, name="NAS", path="/elsewhere")
    source.add(external_root)
    source.commit()
    _add_photo(
        source, root, "external.JPG", b"external", taken=taken, source_root_id=external_root.id
    )

    summary = inspect_library(home, 1, root)
    result = merge_library(home, 1, root)

    assert summary.photos == 1
    assert (result["added"], result["skipped"]) == (1, 0)
    assert [i.original_filename for i in home.query(Image)] == ["keep.JPG"]


def test_merging_twice_changes_nothing_the_second_time(home, travel):
    """Re-running after a drive dropped out mid-merge must not duplicate what
    already came across."""
    root, source = travel
    _add_photo(
        source, root, "DSCF0004.JPG", b"delta", taken=datetime(2026, 7, 14, tzinfo=timezone.utc)
    )

    first = merge_library(home, 1, root)
    second = merge_library(home, 1, root)

    assert first["added"] == 1
    assert (second["added"], second["updated"]) == (0, 1)
    assert home.query(Image).count() == 1


def test_inspect_reports_what_would_happen(home, travel):
    taken = datetime(2026, 7, 14, tzinfo=timezone.utc)
    _add_photo(home, settings.library_root, "known.JPG", b"known", taken=taken)
    root, source = travel
    _add_photo(source, root, "known.JPG", b"known", taken=taken)
    _add_photo(source, root, "fresh.JPG", b"fresh", taken=taken)

    summary = inspect_library(home, 1, root)

    assert (summary.photos, summary.new_photos, summary.known_photos) == (2, 1, 1)
    assert summary.bytes_to_copy == len(b"fresh")


def test_a_folder_that_is_not_a_library_is_refused(home, tmp_path):
    plain = tmp_path / "just-photos"
    plain.mkdir()
    with pytest.raises(MergeError):
        inspect_library(home, 1, plain)


def test_a_library_from_another_version_is_refused(home, travel, monkeypatch):
    """Reading rows through this version's models when the columns differ is
    exactly how a merge would corrupt a library - so it doesn't start."""
    root, source = travel
    _stamp_schema(source, "some-older-revision")
    with pytest.raises(MergeError, match="different Rollfilm version"):
        inspect_library(home, 1, root)


def test_cancel_stops_and_keeps_what_already_came_across(home, travel, monkeypatch):
    """Cancelling mid-run must leave a consistent library: the photos already
    copied stay, and running it again brings the rest rather than duplicates."""
    from app.services import library_merge

    taken = datetime(2026, 7, 14, tzinfo=timezone.utc)
    root, source = travel
    for i in range(4):
        _add_photo(source, root, f"DSCF{i}.JPG", f"photo-{i}".encode(), taken=taken)

    # Stop as soon as the first photo is through.
    real_step = library_merge._progress_step

    def stop_after_one(done: int, copied_bytes: int) -> None:
        real_step(done, copied_bytes)
        if done >= 1:
            library_merge.request_merge_cancel()

    monkeypatch.setattr(library_merge, "_progress_step", stop_after_one)
    first = merge_library(home, 1, root)

    assert first["canceled"] is True
    assert first["added"] == 1
    assert home.query(Image).count() == 1
    # The one that made it is complete: row and file both there.
    only = home.query(Image).one()
    assert (settings.library_root / only.file_path).exists()

    # Running again finishes the job without duplicating the first photo.
    monkeypatch.setattr(library_merge, "_progress_step", real_step)
    second = merge_library(home, 1, root)
    assert second["canceled"] is False
    assert (second["added"], second["updated"]) == (3, 1)
    assert home.query(Image).count() == 4


def test_progress_reports_a_remaining_time_estimate(home, travel):
    """The estimate only appears once there is finished work to measure."""
    from app.services import library_merge

    library_merge._set_progress(
        active=True, total=100, done=0, copied_bytes=0, started=1.0, result=None, error=None
    )
    assert library_merge.get_merge_progress()["eta_seconds"] is None

    library_merge._progress_step(1, 1000)
    library_merge._progress_step(2, 2000)
    eta = library_merge.get_merge_progress()["eta_seconds"]
    assert eta is not None and eta > 0
    library_merge._set_progress(active=False)

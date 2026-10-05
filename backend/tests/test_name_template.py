"""File names from a template: what each placeholder gives, and that the
result is always something a file can be called."""

from datetime import datetime, timezone
from types import SimpleNamespace

from app.services import name_template


def _photo(**extra):
    base = dict(
        original_filename="DSCF0263.RAF",
        taken_at=datetime(2026, 7, 17, 10, 36, 42, tzinfo=timezone.utc),
        camera_model="X-E5",
        rating=4,
    )
    base.update(extra)
    return SimpleNamespace(**base)


def test_no_template_keeps_the_photos_own_name():
    assert name_template.render_stem(None, _photo()) == "DSCF0263"
    assert name_template.render_stem("   ", _photo()) == "DSCF0263"


def test_every_placeholder():
    stem = name_template.render_stem("{date}_{time}_{camera}_{rating}_{seq}_{name}", _photo(), seq=7, total=12)
    assert stem == "2026-07-17_103642_X-E5_4_007_DSCF0263"


def test_seq_is_padded_to_the_size_of_the_run():
    assert name_template.render_stem("{seq}", _photo(), seq=7, total=12) == "007"
    assert name_template.render_stem("{seq}", _photo(), seq=7, total=2500) == "0007"


def test_a_missing_value_leaves_no_dangling_separator():
    photo = _photo(taken_at=None, camera_model=None)
    assert name_template.render_stem("{date}_{seq}", photo, seq=1, total=3) == "001"
    # Nothing left at all: the photo's own name, never an empty one.
    assert name_template.render_stem("{date}{camera}", photo) == "DSCF0263"


def test_a_value_cannot_smuggle_in_a_path():
    photo = _photo(camera_model="X/T5: II")
    assert name_template.render_stem("{camera}", photo) == "X-T5- II"


def test_template_errors_name_the_problem():
    assert name_template.template_error("{date}_{seq}") is None
    assert "{datum}" in name_template.template_error("{datum}_{seq}")
    assert name_template.template_error("trip/{seq}") is not None
    assert name_template.template_error("{seq") is not None

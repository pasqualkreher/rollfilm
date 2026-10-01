"""The raw base (develop.ENUM_SPEC["raw_base"]).

Two promises: an edit saved before the key existed renders exactly as it did
(lifted only while nothing is developed, native once it is), and an edit on
the "standard" base is developed from the auto-exposed picture the grid shows -
in the editor and in every output render alike."""

import io

import numpy as np
from PIL import Image as PILImage

from app.services import auto_develop, develop, filesystem, thumbnails
from app.services import raw as raw_service

GAIN = 4.0


# ---- compatibility ----------------------------------------------------------

def test_an_edit_without_the_key_is_on_the_legacy_base():
    assert develop.normalize({"exposure": 1.5})["raw_base"] == "legacy"
    assert develop.loads('{"contrast": 20}')["raw_base"] == "legacy"
    assert develop.loads(None)["raw_base"] == "legacy"


def test_the_standard_base_alone_never_makes_a_photo_edited():
    assert develop.is_neutral({"raw_base": "standard"})
    assert develop.dumps({"raw_base": "standard"}) is None
    assert not develop.is_neutral({"raw_base": "standard", "contrast": 10})


def test_the_native_base_is_an_edit_and_is_stored():
    assert not develop.is_neutral({"raw_base": "native"})
    blob = develop.dumps({"raw_base": "native"})
    assert blob is not None
    assert develop.loads(blob)["raw_base"] == "native"


# ---- which gain a render gets -----------------------------------------------

def test_a_legacy_edit_keeps_the_old_rule():
    assert thumbnails._browsing_gain(GAIN, None) == GAIN
    assert thumbnails._browsing_gain(GAIN, develop.defaults()) == GAIN
    # The lens switch is not developing the photo.
    assert thumbnails._browsing_gain(GAIN, develop.normalize({"lens_profile": 0})) == GAIN
    assert thumbnails._browsing_gain(GAIN, develop.normalize({"exposure": 1.0})) == 1.0


def test_a_standard_edit_stays_lifted_and_a_native_one_never_is():
    standard = develop.normalize({"raw_base": "standard", "contrast": 30})
    assert thumbnails._browsing_gain(GAIN, standard) == GAIN
    assert thumbnails._browsing_gain(GAIN, develop.normalize({"raw_base": "native"})) == 1.0
    assert thumbnails._browsing_gain(GAIN, develop.normalize({"raw_base": "native", "contrast": 30})) == 1.0


def test_the_standard_base_keeps_the_highlight_headroom():
    """The lift is a scalar beside the linear data: two highlights it pushes
    past display white (1.8 and 3.6 here) stay two tones under the shoulder
    instead of clipping to one."""
    lin = np.full((8, 8, 3), 0.9, dtype=np.float32)
    lin[:4] = 0.45
    out = thumbnails._linear_tone_block(lin, develop.normalize({"raw_base": "standard"}), base_gain=GAIN)
    assert float(out[:4].mean()) < float(out[4:].mean()) - 0.05
    assert float(out.max()) <= 1.0


# ---- the editor -------------------------------------------------------------

def _dark_raw(tmp_path, monkeypatch, image_id: str):
    """A source the editor decodes as a dark linear frame with a base gain,
    the way a DR-mode raw arrives."""
    src = tmp_path / f"{image_id}.png"
    PILImage.fromarray(np.full((120, 160, 3), 128, dtype=np.uint8)).save(src)
    yy, xx = np.mgrid[0:120, 0:160]
    lin = (0.004 + 0.05 * (xx / 160.0))[..., None].repeat(3, axis=-1).astype(np.float32)

    class _FakeImage:
        id = image_id
        width = 160
        height = 120

    monkeypatch.setattr(filesystem, "resolve_image_path", lambda image: src)
    monkeypatch.setattr(raw_service, "load_linear_base", lambda *a, **k: (lin.copy(), GAIN))
    thumbnails._cached_editor_base.cache_clear()
    thumbnails.invalidate_tone_stage()
    return _FakeImage()


def _frame(image, adj: dict, **kw) -> np.ndarray:
    data = thumbnails.render_editor_preview_bytes(image, 0, None, develop.normalize(adj), **kw)
    return np.asarray(PILImage.open(io.BytesIO(data)).convert("RGB"), dtype=np.float32)


def test_the_editor_opens_a_standard_raw_as_the_library_shows_it(tmp_path, monkeypatch):
    image = _dark_raw(tmp_path, monkeypatch, "raw-base-standard")
    standard = _frame(image, {"raw_base": "standard"})
    library = _frame(image, {}, browse=True)
    assert np.abs(standard - library).max() <= 1
    native = _frame(image, {"raw_base": "native"})
    assert standard.mean() > native.mean() * 1.5


def test_the_editor_renders_a_legacy_edit_native_as_before(tmp_path, monkeypatch):
    image = _dark_raw(tmp_path, monkeypatch, "raw-base-legacy")
    legacy = _frame(image, {"contrast": 20})
    native = _frame(image, {"raw_base": "native", "contrast": 20})
    assert np.array_equal(legacy, native)


def test_a_standard_edit_is_exposure_on_top_of_the_lift(tmp_path, monkeypatch):
    """Exposure works relative to the standard base: the same picture as the
    native base with the lift dialled in by hand."""
    image = _dark_raw(tmp_path, monkeypatch, "raw-base-relative")
    standard = _frame(image, {"raw_base": "standard", "exposure": 0.5})
    by_hand = _frame(image, {"raw_base": "native", "exposure": 0.5 + float(np.log2(GAIN))})
    assert np.abs(standard - by_hand).max() <= 1


# ---- suggestions ------------------------------------------------------------

def test_a_suggestion_names_the_base_its_exposure_was_set_on():
    legacy = develop.normalize({"exposure": 3.0})
    standard = develop.normalize({"raw_base": "standard", "exposure": 0.3})
    assert auto_develop.blend_adjustments([(legacy, 0.9), (legacy, 0.9), (standard, 0.5)])["raw_base"] == "native"
    assert auto_develop.blend_adjustments([(standard, 0.9), (standard, 0.9), (legacy, 0.5)])["raw_base"] == "standard"
    assert "raw_base" in auto_develop.filter_to_groups({"raw_base": "standard", "hue": 3}, ["tone"])

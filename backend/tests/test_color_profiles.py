"""A JPEG/PNG with an embedded colour profile is converted to sRGB on load.

The pipeline works in sRGB and writes untagged derivatives, so a Display P3
(every iPhone photo) or Adobe RGB file whose numbers are taken as they stand
renders desaturated. Files without a profile, or with sRGB, must come through
untouched - that is nearly every camera JPEG, and it must stay free."""

from pathlib import Path

import numpy as np
import pytest
from PIL import Image as PILImage

from app.services import raw as raw_service
from app.services import thumbnails

_P3 = Path("/System/Library/ColorSync/Profiles/Display P3.icc")


def test_an_untagged_image_is_returned_as_it_is():
    im = PILImage.new("RGB", (4, 4), (200, 100, 80))
    assert raw_service.to_srgb(im) is im


def test_an_srgb_tagged_image_is_returned_as_it_is():
    im = PILImage.new("RGB", (4, 4), (200, 100, 80))
    im.info["icc_profile"] = raw_service.srgb_icc_bytes()
    assert raw_service.to_srgb(im) is im


def test_an_unreadable_profile_leaves_the_picture_alone():
    im = PILImage.new("RGB", (4, 4), (200, 100, 80))
    im.info["icc_profile"] = b"not a profile"
    assert raw_service.to_srgb(im) is im


@pytest.mark.skipif(not _P3.exists(), reason="needs the system's Display P3 profile")
def test_a_display_p3_file_is_converted_on_load_and_on_export(tmp_path):
    p3 = _P3.read_bytes()
    path = tmp_path / "p3.png"
    PILImage.new("RGB", (16, 16), (200, 100, 80)).save(path, "PNG", icc_profile=p3)

    # The same numbers mean a more saturated colour in P3, so in sRGB red
    # rises and green/blue fall.
    lin, gain = raw_service.load_linear_base(path)
    srgb8 = np.round(raw_service._linear_to_srgb(lin[0, 0]) * 255.0)
    assert gain == 1.0
    assert srgb8[0] > 205 and srgb8[1] < 97 and srgb8[2] < 77

    exported = PILImage.open(__import__("io").BytesIO(thumbnails._encode_jpeg_file(path, 95, None)))
    assert exported.info.get("icc_profile") == raw_service.srgb_icc_bytes()
    r, g, b = exported.getpixel((8, 8))
    assert r > 205 and g < 97

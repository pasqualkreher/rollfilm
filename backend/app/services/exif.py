import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

import exiftool

_helper: exiftool.ExifToolHelper | None = None


def _get_helper() -> exiftool.ExifToolHelper:
    global _helper
    if _helper is None:
        # EXIFTOOL_PATH lets the packaged desktop app point at the exiftool binary
        # shipped inside the bundle; otherwise fall back to `exiftool` on PATH.
        executable = os.environ.get("EXIFTOOL_PATH") or "exiftool"
        _helper = exiftool.ExifToolHelper(executable=executable)
    return _helper


@dataclass
class ExifData:
    width: int | None = None
    height: int | None = None
    taken_at: datetime | None = None
    camera_make: str | None = None
    camera_model: str | None = None
    iso: int | None = None
    aperture: float | None = None
    shutter_speed: str | None = None
    focal_length: float | None = None
    gps_lat: float | None = None
    gps_lon: float | None = None

    def to_json(self) -> str:
        data = asdict(self)
        data["taken_at"] = self.taken_at.isoformat() if self.taken_at else None
        return json.dumps(data)


def to_int(value) -> int | None:
    """Coerce an exiftool value to int, or None. exiftool reports missing/
    unknown numeric tags as the literal string 'undef' (seen on Fujifilm RAWs
    with adapted lenses), which must never reach a numeric DB column."""
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def to_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y:%m:%d %H:%M:%S%z"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def _is_quarter_rotated(orientation) -> bool:
    """True when the EXIF orientation is a 90°/270° turn, meaning the stored
    pixel width/height are swapped relative to how the photo is displayed.
    Handles both numeric orientation (5-8) and exiftool's descriptive strings
    ("Rotate 90 CW", "Rotate 270 CW")."""
    if orientation is None:
        return False
    if isinstance(orientation, (int, float)):
        return int(orientation) in (5, 6, 7, 8)
    text = str(orientation)
    return "90" in text or "270" in text


def new_helper() -> exiftool.ExifToolHelper:
    """A fresh, independent exiftool process. A single ExifToolHelper (-stay_open)
    can't be shared across threads - its one stdin/stdout would interleave - so
    parallel staging gives each worker its own via a small pool of these."""
    executable = os.environ.get("EXIFTOOL_PATH") or "exiftool"
    return exiftool.ExifToolHelper(executable=executable)


# Only the tags read below. get_tags() lets exiftool skip formatting every
# other tag it finds - crucially the big MakerNote / embedded-preview blocks in
# RAW files - which is a large chunk of the per-file staging cost on a big
# import. Keys come back group-prefixed because the helper runs with -G (its
# default common_args), matching how the metadata is read out here.
_EXIF_TAGS = [
    "EXIF:ExifImageWidth",
    "File:ImageWidth",
    "EXIF:ExifImageHeight",
    "File:ImageHeight",
    "EXIF:Orientation",
    "EXIF:ExposureTime",
    "EXIF:DateTimeOriginal",
    "EXIF:Make",
    "EXIF:Model",
    "EXIF:ISO",
    "EXIF:FNumber",
    "EXIF:FocalLength",
    "Composite:GPSLatitude",
    "Composite:GPSLongitude",
]


def read_exif(path: Path, helper: exiftool.ExifToolHelper | None = None) -> ExifData:
    metadata = (helper or _get_helper()).get_tags([str(path)], _EXIF_TAGS)[0]

    width = to_int(metadata.get("EXIF:ExifImageWidth") or metadata.get("File:ImageWidth"))
    height = to_int(metadata.get("EXIF:ExifImageHeight") or metadata.get("File:ImageHeight"))
    # Report the *displayed* dimensions: cameras store portrait shots as
    # landscape pixels plus an orientation tag, so swap when that tag is a
    # quarter turn. Keeps width/height consistent with the auto-oriented
    # thumbnails (see services/raw.py) the grid renders.
    if width and height and _is_quarter_rotated(metadata.get("EXIF:Orientation")):
        width, height = height, width

    shutter = metadata.get("EXIF:ExposureTime")
    return ExifData(
        width=width,
        height=height,
        taken_at=_parse_datetime(metadata.get("EXIF:DateTimeOriginal")),
        camera_make=metadata.get("EXIF:Make"),
        camera_model=metadata.get("EXIF:Model"),
        iso=to_int(metadata.get("EXIF:ISO")),
        aperture=to_float(metadata.get("EXIF:FNumber")),
        shutter_speed=str(shutter) if shutter not in (None, "", "undef") else None,
        focal_length=to_float(metadata.get("EXIF:FocalLength")),
        gps_lat=to_float(metadata.get("Composite:GPSLatitude")),
        gps_lon=to_float(metadata.get("Composite:GPSLongitude")),
    )

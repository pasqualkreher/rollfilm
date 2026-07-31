import json
import os
import re
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
    lens_model: str | None = None
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
    value = str(value)
    for fmt in (
        "%Y:%m:%d %H:%M:%S",
        "%Y:%m:%d %H:%M:%S%z",
        # Sub-second variants (some phones write DateTimeOriginal with .%f).
        "%Y:%m:%d %H:%M:%S.%f",
        "%Y:%m:%d %H:%M:%S.%f%z",
    ):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    # XMP dates come ISO-formatted ("2024-05-01T12:00:00+02:00") rather than
    # in exiftool's colon-date format.
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


# Filename conventions that embed the capture date: Android/most cameras
# (IMG_20180816_180748, 20180816_180748), WhatsApp (IMG-20180816-WA0015),
# screenshots and exports (Screenshot_2018-08-16..., 2018-08-16 18.07.48).
_NAME_DATETIME_RE = re.compile(
    # Optional 3 trailing digits: Pixel phones append milliseconds
    # (PXL_20230101_123456789 = 12:34:56.789).
    r"(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})(?:\d{3})?(?!\d)"
)
_NAME_DASHED_DATE_RE = re.compile(r"(?<!\d)((?:19|20)\d{2})-(\d{2})-(\d{2})(?!\d)")
_NAME_COMPACT_DATE_RE = re.compile(r"(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)")


def capture_date_from_filename(name: str) -> datetime | None:
    """Best-effort capture date parsed from the filename. Used only for files
    whose metadata carries no capture date at all (WhatsApp strips EXIF
    entirely, for example) - a date embedded in the name still beats dating
    the photo to the moment it was imported. Date-only matches get 12:00 so
    they sort into the middle of their day; impossible dates (month 13 etc.)
    fall through and return None."""
    m = _NAME_DATETIME_RE.search(name)
    if m:
        try:
            return datetime(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]), int(m[6]))
        except ValueError:
            pass
    for pattern in (_NAME_DASHED_DATE_RE, _NAME_COMPACT_DATE_RE):
        m = pattern.search(name)
        if m:
            try:
                return datetime(int(m[1]), int(m[2]), int(m[3]), 12, 0, 0)
            except ValueError:
                continue
    return None


def _fmt_mm(value: float) -> str:
    return str(int(value)) if value.is_integer() else f"{value:g}"


def _clean_lens(value) -> str | None:
    """A displayable lens name, or None. exiftool reports missing lens tags as
    'undef', adapted/manual lenses without electronic contacts as placeholders
    like '0.0 mm f/0.0' or 'Unknown (0 0)' - none of which name a lens.

    The helper runs with -n (no print conversion), so spec-style tags like
    LensInfo/LensSpec arrive as bare numbers ('8.8 25.7 1.8 2.8', Sony pads
    with extra fields) - those are formatted into '8.8-25.7mm f/1.8-2.8' here.
    A value that is numeric but not such a spec (e.g. a raw LensType code) is
    no name at all and is dropped."""
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in ("undef", "none", "unknown", "n/a"):
        return None
    if text.startswith("Unknown (") or text.startswith("0.0 mm"):
        return None

    try:
        numbers = [float(t) for t in text.split()]
    except ValueError:
        # Contains non-numeric parts: an actual lens name.
        return text
    # Spec layout is min-focal, max-focal, max-aperture-wide, max-aperture-tele;
    # Sony's LensSpec pads that with a leading/trailing byte - strip zeros from
    # the ends until the 4-number core remains.
    while len(numbers) > 4 and numbers[0] == 0:
        numbers.pop(0)
    while len(numbers) > 4 and numbers[-1] == 0:
        numbers.pop()
    if len(numbers) != 4 or numbers[0] <= 0:
        return None
    wide, tele, f_wide, f_tele = numbers
    focal = _fmt_mm(wide) if wide == tele else f"{_fmt_mm(wide)}-{_fmt_mm(tele)}"
    if f_wide <= 0:
        return f"{focal}mm"
    aperture = _fmt_mm(f_wide) if f_wide == f_tele else f"{_fmt_mm(f_wide)}-{_fmt_mm(f_tele)}"
    return f"{focal}mm f/{aperture}"


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
    "EXIF:CreateDate",
    "XMP:DateCreated",
    "XMP:CreateDate",
    "EXIF:ModifyDate",
    "EXIF:Make",
    "EXIF:Model",
    "EXIF:LensModel",
    "XMP:Lens",
    "Composite:LensID",
    "MakerNotes:LensSpec",
    "EXIF:LensInfo",
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

    # RAW files: the EXIF width/height fields above often describe the
    # *embedded preview JPEG*, not the sensor output (Fuji RAF reports e.g.
    # 4416x2944 for a 7728x5152 camera) - read the true rendered dimensions
    # from the RAW header instead. Imported lazily: raw.py pulls in numpy/rawpy,
    # which this module otherwise doesn't need.
    from app.services.raw import is_raw, raw_dimensions

    if is_raw(path):
        dims = raw_dimensions(path)
        if dims:
            width, height = dims

    shutter = metadata.get("EXIF:ExposureTime")
    return ExifData(
        width=width,
        height=height,
        # Capture date with fallbacks: not every camera/app writes
        # DateTimeOriginal (screenshots, edited exports, some phones) - without
        # a fallback those photos sort by import time and scatter through the
        # timeline instead of landing on their capture date. EXIF:ModifyDate
        # comes last: straight from a camera it equals the capture time (e.g.
        # old HTC phones write ONLY this), and for files whose better tags were
        # stripped it's still the in-file date, not the copy date.
        taken_at=_parse_datetime(
            metadata.get("EXIF:DateTimeOriginal")
            or metadata.get("EXIF:CreateDate")
            or metadata.get("XMP:DateCreated")
            or metadata.get("XMP:CreateDate")
            or metadata.get("EXIF:ModifyDate")
        ),
        camera_make=metadata.get("EXIF:Make"),
        camera_model=metadata.get("EXIF:Model"),
        # First tag with a usable name wins: LensModel is the standard EXIF tag,
        # XMP:Lens covers edited exports, Composite:LensID is exiftool's decoded
        # maker-note lookup for RAWs that write nothing else. Fixed-lens compacts
        # (e.g. Sony RX100) write none of those - their lens range sits in
        # LensSpec/LensInfo ("24-70mm F1.8-2.8"), which still names the glass.
        lens_model=next(
            (
                v
                for v in (
                    _clean_lens(metadata.get("EXIF:LensModel")),
                    _clean_lens(metadata.get("XMP:Lens")),
                    _clean_lens(metadata.get("Composite:LensID")),
                    _clean_lens(metadata.get("MakerNotes:LensSpec")),
                    _clean_lens(metadata.get("EXIF:LensInfo")),
                )
                if v
            ),
            None,
        ),
        iso=to_int(metadata.get("EXIF:ISO")),
        aperture=to_float(metadata.get("EXIF:FNumber")),
        shutter_speed=str(shutter) if shutter not in (None, "", "undef") else None,
        focal_length=to_float(metadata.get("EXIF:FocalLength")),
        gps_lat=to_float(metadata.get("Composite:GPSLatitude")),
        gps_lon=to_float(metadata.get("Composite:GPSLongitude")),
    )

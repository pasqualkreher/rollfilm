import json
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

import exiftool

_helper: exiftool.ExifToolHelper | None = None


def _get_helper() -> exiftool.ExifToolHelper:
    global _helper
    if _helper is None:
        _helper = exiftool.ExifToolHelper()
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


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y:%m:%d %H:%M:%S%z"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def read_exif(path: Path) -> ExifData:
    metadata = _get_helper().get_metadata([str(path)])[0]

    return ExifData(
        width=metadata.get("EXIF:ExifImageWidth") or metadata.get("File:ImageWidth"),
        height=metadata.get("EXIF:ExifImageHeight") or metadata.get("File:ImageHeight"),
        taken_at=_parse_datetime(metadata.get("EXIF:DateTimeOriginal")),
        camera_make=metadata.get("EXIF:Make"),
        camera_model=metadata.get("EXIF:Model"),
        iso=metadata.get("EXIF:ISO"),
        aperture=metadata.get("EXIF:FNumber"),
        shutter_speed=str(metadata.get("EXIF:ExposureTime")) if metadata.get("EXIF:ExposureTime") else None,
        focal_length=metadata.get("EXIF:FocalLength"),
        gps_lat=metadata.get("Composite:GPSLatitude"),
        gps_lon=metadata.get("Composite:GPSLongitude"),
    )

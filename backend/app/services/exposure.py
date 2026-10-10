"""Exposure values as the library stores them.

EXIF's ExposureTime is kept as text (exiftool's -n writes "0.004", older
rows carry "1/250"), so a shutter-speed range cannot be a column comparison:
the distinct strings are parsed and the ones inside the range are matched by
value (the statistics page does the same). Two spellings of one stop are one
stop (shutter_key).
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.db.models import Image

# How far outside a requested bound a stored stop may lie and still count:
# relative, so a bound that went through the query string as a short decimal
# ("0.004" for 1/250) finds its stop again, and well under the quarter stop
# that separates neighbouring shutter speeds.
SHUTTER_TOLERANCE = 0.01


def shutter_seconds(text: str | None) -> float | None:
    """EXIF ExposureTime as stored: "1/250", "0.5", "2", sometimes with a
    trailing unit. None for anything that isn't a positive duration."""
    if not text:
        return None
    raw = text.strip().rstrip("s").strip()
    try:
        if "/" in raw:
            num, den = raw.split("/", 1)
            value = float(num) / float(den)
        else:
            value = float(raw)
    except (ValueError, ZeroDivisionError):
        return None
    return value if value > 0 else None


def shutter_key(seconds: float) -> float:
    """One number per stop: "1/250" and "0.004" are the same shutter speed."""
    return float(f"{seconds:.6g}")


def shutter_strings_between(
    db: Session, owner_id: int, lo: float | None, hi: float | None
) -> list[str]:
    """The stored shutter strings of the owner's photos whose exposure time
    lies between `lo` and `hi` seconds (either bound optional), within
    SHUTTER_TOLERANCE. What a range filter matches the column against."""
    rows = (
        db.query(Image.shutter_speed)
        .filter(
            Image.owner_id == owner_id,
            Image.deleted_at.is_(None),
            Image.shutter_speed.isnot(None),
            Image.shutter_speed != "",
        )
        .distinct()
        .all()
    )
    out: list[str] = []
    for (text,) in rows:
        seconds = shutter_seconds(text)
        if seconds is None:
            continue
        if lo is not None and seconds < lo * (1.0 - SHUTTER_TOLERANCE):
            continue
        if hi is not None and seconds > hi * (1.0 + SHUTTER_TOLERANCE):
            continue
        out.append(text)
    return out

"""Editing a photo's metadata by hand: capture time, place, title, author,
copyright, caption and the camera data (body, lens, ISO, aperture, shutter,
focal length) - for one photo or a whole selection.

The original file is never rewritten (see exif.py, "Writing"). An edit lives
in the library's columns, and the fields changed by hand are remembered in
Image.meta_edited. Those - and only those - are then written over what the
file says: into the photo's .xmp sidecar (when sidecars are on) and into
every export and saved copy. A sidecar this app wrote is read back on a new
import, so an edit survives a rebuilt library.

"Restore from file" forgets the edits: the fields go back to what the file
(and a sidecar of another program) says, and the sidecar loses the values
this app put there.
"""
from __future__ import annotations

import json
import logging
import math
import re
from datetime import datetime, timedelta
from typing import Any, Callable

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.models import Image
from app.services import exif as exif_service
from app.services import geocode
from app.services.filesystem import resolve_image_path

logger = logging.getLogger(__name__)

# The fields, as Image.meta_edited names them. "gps" stands for the pair of
# coordinates (and the country looked up from them).
TEXT_FIELDS = ("title", "creator", "copyright", "camera_make", "camera_model", "lens_model")
NUMBER_FIELDS = ("iso", "aperture", "shutter_speed", "focal_length")
FIELDS = ("taken_at", "gps", *TEXT_FIELDS, *NUMBER_FIELDS)
# Editable in the same dialog, but the photo's note: not a file value, so it
# is not marked as edited and "Restore from file" leaves it alone.
NOTE_FIELD = "description"

_MAX_TEXT = 2000


class MetadataError(ValueError):
    """A value that can't be taken - the message is shown to the user."""


# ---- Reading the stored list ------------------------------------------------


def edited_fields(image: Image) -> set[str]:
    raw = getattr(image, "meta_edited", None) or ""
    return {f for f in raw.split(",") if f in FIELDS}


def _set_edited(image: Image, fields: set[str]) -> None:
    image.meta_edited = ",".join(f for f in FIELDS if f in fields) or None


def edited_values(image: Image) -> dict[str, Any]:
    """The hand-edited fields and their values, the shape exif.edited_tag_args
    takes: None = cleared, "gps" = (lat, lon, country) or None."""
    out: dict[str, Any] = {}
    for name in edited_fields(image):
        if name == "gps":
            out["gps"] = (
                (image.gps_lat, image.gps_lon, image.gps_country)
                if image.gps_lat is not None and image.gps_lon is not None
                else None
            )
        elif name == "shutter_speed":
            out[name] = _float_or_none(image.shutter_speed)
        else:
            out[name] = getattr(image, name)
    return out


def _float_or_none(value) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


# ---- Parsing what was typed -------------------------------------------------


def _text(name: str, value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if len(text) > _MAX_TEXT:
        raise MetadataError(f"The {name.replace('_', ' ')} is too long.")
    return text or None


_NUMBER_RE = re.compile(r"[-+]?\d+(?:[.,]\d+)?")


def _number(value, what: str) -> float | None:
    """The number in what was typed ("f/2,8", "35 mm", "ISO 400"), or None
    for an empty field."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = str(value).strip()
        if not text:
            return None
        match = _NUMBER_RE.search(text)
        if not match:
            raise MetadataError(f"“{text}” is not a {what}.")
        number = float(match.group(0).replace(",", "."))
    if not math.isfinite(number) or number <= 0:
        raise MetadataError(f"The {what} has to be more than zero.")
    return number


def parse_shutter(value) -> float | None:
    """Seconds from "1/250", "1/250 s", "0.5", "2s" or '2"'. None = empty."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        seconds = float(value)
    else:
        text = str(value).strip().lower().rstrip("s\" ").strip()
        if not text:
            return None
        fraction = re.fullmatch(r"(\d+(?:[.,]\d+)?)\s*/\s*(\d+(?:[.,]\d+)?)", text)
        try:
            if fraction:
                seconds = float(fraction.group(1).replace(",", ".")) / float(fraction.group(2).replace(",", "."))
            else:
                seconds = float(text.replace(",", "."))
        except (ValueError, ZeroDivisionError):
            raise MetadataError(f"“{value}” is not a shutter speed (try 1/250 or 2).") from None
    if not math.isfinite(seconds) or seconds <= 0 or seconds > 36000:
        raise MetadataError("The shutter speed has to be more than zero.")
    return seconds


def _shutter_text(seconds: float) -> str:
    # The column keeps what exiftool -n reads (seconds as a decimal).
    return repr(round(seconds, 10)).rstrip("0").rstrip(".") if seconds % 1 else str(int(seconds))


def parse_taken_at(value) -> datetime | None:
    """A wall-clock time as the dialog sends it ("2024-05-01T14:30" or with
    seconds). None or "" = leave the date alone."""
    if value is None or str(value).strip() == "":
        return None
    try:
        parsed = datetime.fromisoformat(str(value).strip())
    except ValueError:
        raise MetadataError(f"“{value}” is not a date and time.") from None
    if not 1800 <= parsed.year <= 2200:
        raise MetadataError("That date is out of range.")
    return parsed


def parse_gps(value) -> tuple[float, float] | None:
    """{lat, lon} (or [lat, lon]) -> the pair; None takes the place off."""
    if value is None:
        return None
    try:
        if isinstance(value, dict):
            lat, lon = float(value["lat"]), float(value["lon"])
        else:
            lat, lon = (float(v) for v in value)
    except (KeyError, TypeError, ValueError):
        raise MetadataError("A place needs a latitude and a longitude.") from None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise MetadataError("Latitude goes from -90 to 90, longitude from -180 to 180.")
    return round(lat, 7), round(lon, 7)


# ---- Applying ---------------------------------------------------------------


def _wall_clock(new: datetime, old: datetime | None) -> datetime:
    """The typed time keeps the zone the stored one had: the dialog shows
    and sends wall-clock time, the zone is not up for editing."""
    if new.tzinfo is None and old is not None and old.tzinfo is not None:
        return new.replace(tzinfo=old.tzinfo)
    return new


def parse_fields(fields: dict[str, Any]) -> dict[str, Any]:
    """What was typed, checked and turned into column values: None = clear
    the field; a date left empty is dropped (a photo keeps its date). Raises
    MetadataError on a value that can't be taken."""
    unknown = set(fields) - set(FIELDS) - {NOTE_FIELD}
    if unknown:
        raise MetadataError(f"Unknown field: {', '.join(sorted(unknown))}")
    parsed: dict[str, Any] = {}
    for name, value in fields.items():
        if name in TEXT_FIELDS or name == NOTE_FIELD:
            parsed[name] = _text(name, value)
        elif name == "iso":
            number = _number(value, "ISO value")
            parsed[name] = int(round(number)) if number is not None else None
        elif name == "aperture":
            parsed[name] = _number(value, "f-number")
        elif name == "focal_length":
            parsed[name] = _number(value, "focal length")
        elif name == "shutter_speed":
            parsed[name] = parse_shutter(value)
        elif name == "taken_at":
            when = parse_taken_at(value)
            if when is not None:
                parsed[name] = when
        elif name == "gps":
            parsed[name] = parse_gps(value)
    return parsed


def parse_shift(shift_seconds: int | None) -> timedelta | None:
    shift = timedelta(seconds=int(shift_seconds)) if shift_seconds else None
    if shift is not None and abs(shift) > timedelta(days=366 * 200):
        raise MetadataError("That shift is too large.")
    return shift


def set_parsed(image: Image, parsed: dict[str, Any], country: str | None) -> None:
    """Put parsed values onto a photo's columns and mark them as hand-edited
    (all but the note). `country` is the one looked up for parsed["gps"]."""
    marked = edited_fields(image)
    for name, value in parsed.items():
        if name == "gps":
            if value is None:
                image.gps_lat = image.gps_lon = image.gps_country = None
            else:
                image.gps_lat, image.gps_lon = value
                image.gps_country = country
        elif name == "taken_at":
            image.taken_at = _wall_clock(value, image.taken_at)
        elif name == "shutter_speed":
            image.shutter_speed = _shutter_text(value) if value is not None else None
        else:
            setattr(image, name, value)
        if name != NOTE_FIELD:
            marked.add(name)
    _set_edited(image, marked)


def _country(parsed: dict[str, Any]) -> str | None:
    return geocode.country_for(*parsed["gps"]) if parsed.get("gps") is not None else None


def apply_edit(
    images: list[Image],
    fields: dict[str, Any],
    shift_seconds: int | None,
    partner_of: Callable[[Image], Image | None],
) -> list[Image]:
    """Put an edit onto `images` and their RAW+JPEG partners (a pair is one
    shot). `fields` maps a field name to its new value - None or "" clears
    it; a field that isn't named stays as it is. `shift_seconds` moves every
    capture time by that much (the selection's camera clock was off).
    Returns every row changed, for the sidecar. Raises MetadataError on a
    value that can't be taken, before anything is changed."""
    parsed = parse_fields(fields)
    shift = parse_shift(shift_seconds)

    targets: dict[str, Image] = {}
    for image in images:
        targets.setdefault(image.id, image)
        partner = partner_of(image)
        if partner is not None:
            targets.setdefault(partner.id, partner)

    country = _country(parsed)
    for image in targets.values():
        set_parsed(image, parsed, country)
        if shift is not None and image.taken_at is not None and "taken_at" not in parsed:
            image.taken_at = image.taken_at + shift
            _set_edited(image, edited_fields(image) | {"taken_at"})
    return list(targets.values())


# ---- Restoring from the file ------------------------------------------------


def revert(
    images: list[Image],
    partner_of: Callable[[Image], Image | None],
    helper=None,
) -> tuple[list[Image], int]:
    """Forget the hand edits: every edited field goes back to what the file
    says. The values this app put into the sidecar are taken out first, so
    the file speaks for itself again. Returns (rows changed, files that
    could not be read - an unplugged drive)."""
    from app.services import sidecar as sidecar_service

    targets: dict[str, Image] = {}
    for image in images:
        targets.setdefault(image.id, image)
        partner = partner_of(image)
        if partner is not None:
            targets.setdefault(partner.id, partner)

    changed: list[Image] = []
    unreadable = 0
    tool = helper or exif_service._get_helper()
    for image in targets.values():
        fields = edited_fields(image)
        if not fields:
            continue
        path = resolve_image_path(image)
        if not path.is_file():
            unreadable += 1
            continue
        side = sidecar_service.sidecar_for(image)
        if side is not None and side.is_file():
            try:
                cleared = exif_service.edited_tag_args(
                    {name: None for name in fields}, sidecar=True
                )
                if cleared:
                    tool.execute("-overwrite_original", *cleared, str(side))
            except Exception:
                logger.exception("Could not clear the edited values from %s", side)
        try:
            data = exif_service.read_exif(path, helper=tool)
        except Exception:
            logger.exception("Restore from file: could not read %s", path)
            unreadable += 1
            continue
        for name in fields:
            if name == "taken_at":
                restored = data.taken_at or exif_service.capture_date_from_filename(image.original_filename)
                if restored is not None:
                    image.taken_at = restored
            elif name == "gps":
                image.gps_lat, image.gps_lon = data.gps_lat, data.gps_lon
                image.gps_country = (
                    geocode.country_for(data.gps_lat, data.gps_lon)
                    if data.gps_lat is not None and data.gps_lon is not None
                    else None
                )
            else:
                setattr(image, name, getattr(data, name))
        image.meta_edited = None
        changed.append(image)
    return changed, unreadable


# ---- What the dialog shows --------------------------------------------------


def _value(image: Image, name: str):
    if name == "gps":
        if image.gps_lat is None or image.gps_lon is None:
            return None
        return {"lat": image.gps_lat, "lon": image.gps_lon}
    if name == "taken_at":
        # Wall-clock time, as the dialog edits it.
        return image.taken_at.replace(tzinfo=None).isoformat(timespec="seconds") if image.taken_at else None
    return getattr(image, name)


def backfill_text_from_file(image: Image, helper=None) -> bool:
    """Photos imported before title/author/copyright had columns: read them
    from the file once, when the dialog opens on the photo. True when the
    row changed (the caller commits)."""
    marked = edited_fields(image)
    if image.title or image.creator or image.copyright or marked & {"title", "creator", "copyright"}:
        return False
    path = resolve_image_path(image)
    if not path.is_file():
        return False
    try:
        data = exif_service.read_exif(path, helper=helper)
    except Exception:
        logger.exception("Could not read %s for its title/author/copyright", path)
        return False
    found = False
    for name in ("title", "creator", "copyright"):
        value = getattr(data, name)
        if value:
            setattr(image, name, value)
            found = True
    return found


def _taken_range(times: list[datetime | None]) -> list[str] | None:
    """First and last capture time (wall clock) - what "near in time" is
    measured from."""
    known = [t.replace(tzinfo=None) for t in times if t is not None]
    if not known:
        return None
    return [min(known).isoformat(timespec="seconds"), max(known).isoformat(timespec="seconds")]


def _summarize(rows: list[dict[str, Any]], edited: bool) -> dict[str, Any]:
    """Each field's value where the rows agree, null where they don't."""
    values: dict[str, Any] = {}
    mixed: list[str] = []
    for name in (*FIELDS, NOTE_FIELD):
        seen = [row.get(name) for row in rows]
        first = seen[0] if seen else None
        if all(v == first for v in seen):
            values[name] = first
        else:
            values[name] = None
            mixed.append(name)
    place = None
    if values.get("gps"):
        labels = geocode.place_labels_for([(values["gps"]["lat"], values["gps"]["lon"])])
        place = labels[0] if labels else None
    return {"count": len(rows), "values": values, "mixed": mixed, "edited": edited, "place": place}


def summary(images: list[Image]) -> dict[str, Any]:
    """What the dialog starts from: each field's value where the photos agree
    on it, null where they don't (listed in `mixed`), and whether any of them
    carries a hand edit "Restore from file" could undo."""
    rows = [{name: _value(image, name) for name in (*FIELDS, NOTE_FIELD)} for image in images]
    out = _summarize(rows, any(edited_fields(image) for image in images))
    out["taken_range"] = _taken_range([image.taken_at for image in images])
    return out


# ---- Files in the import review ---------------------------------------------
# A staged file has no columns of its own for this: what the file says sits
# in ImportStagedFile.exif_json, and an edit made in the review in
# ImportStagedFile.meta_edits (JSON: field -> value as parse_fields gives it,
# the date as ISO text, the place as [lat, lon] or null). The commit lays the
# edit over the file's values and marks the fields on the new photo, so the
# library treats them as hand edits from then on. "Restore from file" in the
# review just forgets the edit - the file's values were never touched.


def _load(text: str | None) -> dict[str, Any]:
    try:
        data = json.loads(text) if text else {}
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def staged_edits(staged) -> dict[str, Any]:
    return _load(getattr(staged, "meta_edits", None))


def _staged_taken_at(staged) -> datetime | None:
    text = staged_edits(staged).get("taken_at") or _load(staged.exif_json).get("taken_at")
    try:
        return datetime.fromisoformat(text) if text else None
    except ValueError:
        return None


def overlay_exif(exif: dict[str, Any], staged) -> dict[str, Any]:
    """The file's values (exif_json, as a dict) with the review's edit laid
    over them, in the same keys - what the commit and the review list read."""
    edits = staged_edits(staged)
    if not edits:
        return exif
    out = dict(exif)
    for name, value in edits.items():
        if name == "gps":
            out["gps_lat"], out["gps_lon"] = (value[0], value[1]) if value else (None, None)
        elif name == "shutter_speed":
            out[name] = _shutter_text(value) if value is not None else None
        elif name == NOTE_FIELD:
            out["caption"] = value
        elif name in FIELDS:
            out[name] = value
    return out


def edit_staged(
    files: list,
    fields: dict[str, Any],
    shift_seconds: int | None,
    partner_of: Callable[[Any], Any],
) -> list:
    """apply_edit for files in the import review: the edit goes into each
    file's meta_edits (and its RAW+JPEG partner's). A shift becomes each
    file's own new date."""
    parsed = parse_fields(fields)
    shift = parse_shift(shift_seconds)
    targets: dict[str, Any] = {}
    for f in files:
        targets.setdefault(f.id, f)
        partner = partner_of(f)
        if partner is not None:
            targets.setdefault(partner.id, partner)
    for f in targets.values():
        edits = staged_edits(f)
        for name, value in parsed.items():
            if name == "taken_at":
                edits[name] = _wall_clock(value, _staged_taken_at(f)).isoformat()
            elif name == "gps":
                edits[name] = list(value) if value is not None else None
            else:
                edits[name] = value
        if shift is not None and "taken_at" not in parsed:
            current = _staged_taken_at(f)
            if current is not None:
                edits["taken_at"] = (current + shift).isoformat()
        f.meta_edits = json.dumps(edits) if edits else None
    return list(targets.values())


def staged_summary(files: list) -> dict[str, Any]:
    rows = []
    for f in files:
        values = overlay_exif(_load(f.exif_json), f)
        when = _staged_taken_at(f)
        lat, lon = values.get("gps_lat"), values.get("gps_lon")
        row = {name: values.get(name) for name in TEXT_FIELDS + NUMBER_FIELDS}
        row["taken_at"] = when.replace(tzinfo=None).isoformat(timespec="seconds") if when else None
        row["gps"] = {"lat": lat, "lon": lon} if lat is not None and lon is not None else None
        row[NOTE_FIELD] = values.get("caption")
        rows.append(row)
    out = _summarize(rows, any(staged_edits(f) for f in files))
    out["taken_range"] = _taken_range([_staged_taken_at(f) for f in files])
    return out


def apply_staged_edits(image: Image, staged) -> None:
    """At the commit: the review's edit onto the new (or restored) photo,
    marked as hand-made. The caller commits."""
    edits = staged_edits(staged)
    if not edits:
        return
    parsed: dict[str, Any] = {}
    for name, value in edits.items():
        if name == "taken_at":
            try:
                parsed[name] = datetime.fromisoformat(value)
            except (TypeError, ValueError):
                continue
        elif name == "gps":
            parsed[name] = (value[0], value[1]) if value else None
        elif name in FIELDS or name == NOTE_FIELD:
            parsed[name] = value
    set_parsed(image, parsed, _country(parsed))


# ---- Suggestions from the library -------------------------------------------

# The text fields whose earlier values are offered while typing.
SUGGESTED_FIELDS = ("creator", "copyright", "camera_make", "camera_model", "lens_model")
_MAX_VALUES = 40
# Places a little over a kilometre apart count as one.
_PLACE_DECIMALS = 2
# How far around the photos' own time "near in time" reaches.
_NEAR_HOURS = 6


def _place_rows(rows: list[tuple[float, float, int]], limit: int) -> list[dict[str, Any]]:
    """Coordinate clusters -> named places, most photos first; clusters that
    get the same name are one place."""
    rows = sorted(rows, key=lambda r: -r[2])[: limit * 3]
    labels = geocode.place_labels_for([(lat, lon) for lat, lon, _ in rows]) if rows else []
    places: dict[str, dict[str, Any]] = {}
    for (lat, lon, count), label in zip(rows, labels):
        name = label or f"{lat:.4f}, {lon:.4f}"
        if name in places:
            places[name]["count"] += count
        else:
            places[name] = {"label": name, "lat": lat, "lon": lon, "count": count}
    return sorted(places.values(), key=lambda p: -p["count"])[:limit]


def _clustered(query) -> list[tuple[float, float, int]]:
    lat = func.round(Image.gps_lat, _PLACE_DECIMALS)
    lon = func.round(Image.gps_lon, _PLACE_DECIMALS)
    return [
        (float(a), float(b), int(n))
        for a, b, n in query.with_entities(lat, lon, func.count(Image.id)).group_by(lat, lon).all()
    ]


def suggestions(
    db: Session,
    owner_id: int,
    start: datetime | None = None,
    end: datetime | None = None,
    exclude: list[str] | None = None,
) -> dict[str, Any]:
    """What the dialog offers from the photos already in the library: each
    text field's earlier values (most used first), the places photographed
    most, and - given the photos' time range - the places of photos taken
    within a few hours of them."""
    base = db.query(Image).filter(Image.owner_id == owner_id, Image.deleted_at.is_(None))
    values: dict[str, list[str]] = {}
    for name in SUGGESTED_FIELDS:
        column = getattr(Image, name)
        rows = (
            base.with_entities(column, func.count(Image.id))
            .filter(column.isnot(None), column != "")
            .group_by(column)
            .order_by(func.count(Image.id).desc())
            .limit(_MAX_VALUES)
            .all()
        )
        values[name] = [str(v) for v, _ in rows]

    located = base.filter(Image.gps_lat.isnot(None), Image.gps_lon.isnot(None))
    places = _place_rows(_clustered(located), 12)

    near: list[dict[str, Any]] = []
    if start is not None:
        reach = timedelta(hours=_NEAR_HOURS)
        window = located.filter(
            Image.taken_at >= start.replace(tzinfo=None) - reach,
            Image.taken_at <= (end or start).replace(tzinfo=None) + reach,
        )
        if exclude:
            window = window.filter(Image.id.notin_(exclude))
        near = _place_rows(_clustered(window), 3)
    return {"values": values, "places": places, "near": near}

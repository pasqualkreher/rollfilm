"""Library statistics for the dashboard (top-bar chart icon): counts, storage,
gear usage, exposure habits and activity over time, every number from a
handful of GROUP BYs over the visible (non-trashed) photos.

Cross-filtered like /images/facets: the caller may pin one value per
dimension (a camera, a year, an ISO stop ...). The headline tiles are then
computed under *all* pinned filters, while every chart is computed under all
filters except its own dimension - so the camera chart still offers the other
cameras while the lens, year and ISO charts show only what that camera shot.

Bucket definitions (focal ranges, ISO/aperture stops, shutter ranges) live
only here; the client sends back the bucket's `key` and knows nothing about
its bounds.

Photos indexed from a currently unplugged source drive are counted (the grid
hides them) - the dashboard describes the whole library, not what is mounted
right now.
"""

import math

from fastapi import APIRouter, Depends
from sqlalchemy import case, false, func
from sqlalchemy.orm import Query, Session

from app import schemas
from app.auth import get_current_user
from app.db.models import FileType, Image, User
from app.db.session import get_db

router = APIRouter(prefix="/stats", tags=["stats"])

# A bucket: (key, label, lo, hi) over a numeric column, half-open lo <= v < hi.
Bucket = tuple[str, str, float, float]

# Focal-length ranges (real focal length in mm, as written by the camera),
# named by the photographic range so the chart reads as "what do I actually
# shoot with", not as a raw histogram.
_FOCAL_BUCKETS: list[Bucket] = [
    ("ultra_wide", "Ultra wide (<16mm)", 0.0, 16.0),
    ("wide", "Wide (16-23mm)", 16.0, 24.0),
    ("semi_wide", "Semi wide (24-35mm)", 24.0, 36.0),
    ("normal", "Normal (36-50mm)", 36.0, 51.0),
    ("short_tele", "Short tele (51-85mm)", 51.0, 86.0),
    ("tele", "Tele (86-135mm)", 86.0, 136.0),
    ("long_tele", "Long tele (136-300mm)", 136.0, 301.0),
    ("super_tele", "Super tele (>300mm)", 301.0, math.inf),
]


def _stop_buckets(
    stops: list[float], key: str, label: str, first: str, last: str
) -> list[Bucket]:
    """Full-stop buckets: each stop owns the values nearer to it than to its
    neighbours (bounds at the geometric midpoints), the first and last stops
    take everything beyond them."""
    out: list[Bucket] = []
    for i, stop in enumerate(stops):
        lo = 0.0 if i == 0 else math.sqrt(stops[i - 1] * stop)
        hi = math.inf if i == len(stops) - 1 else math.sqrt(stop * stops[i + 1])
        name = first if i == 0 else last if i == len(stops) - 1 else label.format(f"{stop:g}")
        out.append((key.format(f"{stop:g}"), name, lo, hi))
    return out


_ISO_BUCKETS = _stop_buckets(
    [100, 200, 400, 800, 1600, 3200, 6400, 12800],
    key="iso_{}", label="ISO {}", first="ISO 100 and below", last="ISO 12800 and above",
)
_APERTURE_BUCKETS = _stop_buckets(
    [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22],
    key="f_{}", label="f/{}", first="f/1.4 and wider", last="f/22 and narrower",
)

# Shutter speeds as exposure time in seconds, grouped into the ranges a
# photographer thinks in. Bounds sit at the geometric midpoint between the
# named stops (1/1000 | 1/2000 -> 1/1414 etc.).
_SHUTTER_BUCKETS: list[Bucket] = [
    ("very_fast", "Very fast (1/2000 and faster)", 0.0, 1 / 1414),
    ("fast", "Fast (1/500 - 1/1000)", 1 / 1414, 1 / 354),
    ("handheld", "Handheld (1/60 - 1/250)", 1 / 354, 1 / 42),
    ("slow", "Slow (1/2 - 1/30)", 1 / 42, 0.707),
    ("long", "Long exposure (1 s and longer)", 0.707, math.inf),
]

_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


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


def _bucket_of(buckets: list[Bucket], value: float) -> str | None:
    for key, _label, lo, hi in buckets:
        if lo <= value < hi:
            return key
    return None


def _bucket_bounds(buckets: list[Bucket], key: str) -> tuple[float, float] | None:
    for k, _label, lo, hi in buckets:
        if k == key:
            return lo, hi
    return None


def _two_digits(value: str | None) -> str | None:
    """Month keys as strftime writes them ("07"), whatever the client sent."""
    if value is None:
        return None
    try:
        return f"{int(value):02d}"
    except ValueError:
        return value


@router.get("/library", response_model=schemas.LibraryStats)
def library_stats(
    camera: str | None = None,
    lens: str | None = None,
    focal: str | None = None,
    year: str | None = None,
    month: str | None = None,
    rating: int | None = None,
    file_type: str | None = None,
    iso: str | None = None,
    aperture: str | None = None,
    shutter: str | None = None,
    country: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    visible = db.query(Image).filter(
        Image.owner_id == current_user.id, Image.deleted_at.is_(None)
    )
    month = _two_digits(month)

    # The shutter column is text ("1/250"), so its buckets can't be a SQL
    # range. The library holds a few dozen distinct strings at most: group them
    # once, sort each into its bucket, and filter with IN (...) over the
    # strings of the chosen bucket.
    shutter_strings: dict[str, list[str]] = {}
    for (text,) in (
        visible.with_entities(Image.shutter_speed)
        .filter(Image.shutter_speed.isnot(None), Image.shutter_speed != "")
        .distinct()
        .all()
    ):
        seconds = shutter_seconds(text)
        key = _bucket_of(_SHUTTER_BUCKETS, seconds) if seconds is not None else None
        if key:
            shutter_strings.setdefault(key, []).append(text)

    def in_bucket(column, buckets: list[Bucket], key: str):
        bounds = _bucket_bounds(buckets, key)
        if bounds is None:
            return false()
        lo, hi = bounds
        expr = column >= lo
        return expr if math.isinf(hi) else expr & (column < hi)

    def scoped(*, without: str | None = None) -> Query:
        """The visible library under every pinned filter except `without`."""
        q = visible
        if camera and without != "camera":
            q = q.filter(Image.camera_model == camera)
        if lens and without != "lens":
            q = q.filter(Image.lens_model == lens)
        if focal and without != "focal":
            q = q.filter(in_bucket(Image.focal_length, _FOCAL_BUCKETS, focal))
        if year and without != "year":
            q = q.filter(func.strftime("%Y", Image.taken_at) == year)
        if month and without != "month":
            q = q.filter(func.strftime("%m", Image.taken_at) == month)
        if rating is not None and without != "rating":
            q = q.filter(Image.rating == rating)
        if file_type and without != "file_type":
            try:
                q = q.filter(Image.file_type == FileType(file_type))
            except ValueError:
                q = q.filter(false())
        if iso and without != "iso":
            q = q.filter(in_bucket(Image.iso, _ISO_BUCKETS, iso))
        if aperture and without != "aperture":
            q = q.filter(in_bucket(Image.aperture, _APERTURE_BUCKETS, aperture))
        if shutter and without != "shutter":
            q = q.filter(Image.shutter_speed.in_(shutter_strings.get(shutter, [])))
        if country and without != "country":
            q = q.filter(Image.gps_country == country)
        return q

    def named_facet(column, dimension: str, selected: str | None, limit: int = 10):
        """Top values of a text column (camera, lens, country), most used
        first. The pinned value is appended when it falls outside the top N -
        otherwise the active selection would vanish from its own chart."""
        q = scoped(without=dimension)
        rows = (
            q.with_entities(column, func.count(Image.id))
            .filter(column.isnot(None), column != "")
            .group_by(column)
            .order_by(func.count(Image.id).desc(), column)
            .limit(limit)
            .all()
        )
        out = [schemas.StatCount(key=str(name), name=str(name), count=count) for name, count in rows]
        if selected and all(r.key != selected for r in out):
            count = q.filter(column == selected).count()
            if count:
                out.append(schemas.StatCount(key=selected, name=selected, count=count))
        return out

    def bucket_facet(column, buckets: list[Bucket], dimension: str):
        rows = (
            scoped(without=dimension)
            .with_entities(column, func.count(Image.id))
            .filter(column.isnot(None))
            .group_by(column)
            .all()
        )
        out = []
        for key, label, lo, hi in buckets:
            count = sum(c for v, c in rows if v is not None and lo <= v < hi)
            if count:
                out.append(
                    schemas.StatCount(
                        key=key, name=label, count=count,
                        lo=lo, hi=None if math.isinf(hi) else hi,
                    )
                )
        return out

    def time_facet(fmt: str, dimension: str, name_of=lambda v: v):
        expr = func.strftime(fmt, Image.taken_at)
        rows = (
            scoped(without=dimension)
            .with_entities(expr, func.count(Image.id))
            .filter(Image.taken_at.isnot(None))
            .group_by(expr)
            .order_by(expr)
            .all()
        )
        return [
            schemas.StatCount(key=str(v), name=name_of(str(v)), count=count)
            for v, count in rows
            if v is not None
        ]

    def shutter_facet():
        rows = (
            scoped(without="shutter")
            .with_entities(Image.shutter_speed, func.count(Image.id))
            .filter(Image.shutter_speed.isnot(None), Image.shutter_speed != "")
            .group_by(Image.shutter_speed)
            .all()
        )
        per_key: dict[str, int] = {}
        for text, count in rows:
            seconds = shutter_seconds(text)
            key = _bucket_of(_SHUTTER_BUCKETS, seconds) if seconds is not None else None
            if key:
                per_key[key] = per_key.get(key, 0) + count
        return [
            schemas.StatCount(key=key, name=label, count=per_key[key])
            for key, label, _lo, _hi in _SHUTTER_BUCKETS
            if per_key.get(key)
        ]

    def month_name(key: str) -> str:
        try:
            return _MONTH_NAMES[int(key) - 1]
        except (ValueError, IndexError):
            return key

    # --- Headline numbers: everything pinned applies. -------------------------
    filtered = scoped()
    total_photos, total_bytes = filtered.with_entities(
        func.count(Image.id),
        # Virtual copies share their source's bytes - counting their file_size
        # would report the library bigger than the disk says.
        func.coalesce(
            func.sum(case((Image.virtual_of_image_id.is_(None), Image.file_size), else_=0)), 0
        ),
    ).one()
    type_rows = dict(
        filtered.with_entities(Image.file_type, func.count(Image.id))
        .group_by(Image.file_type)
        .all()
    )
    first_taken, last_taken = filtered.with_entities(
        func.min(Image.taken_at), func.max(Image.taken_at)
    ).one()

    def distinct_count(column) -> int:
        return (
            filtered.with_entities(func.count(func.distinct(column)))
            .filter(column.isnot(None), column != "")
            .scalar()
            or 0
        )

    # --- Which dimensions the (unfiltered) library has data for at all. A
    # chart whose dimension is missing here is not shown; one that is merely
    # emptied by the current filters keeps its place with a placeholder. -----
    def has_any(*conditions) -> bool:
        return db.query(visible.filter(*conditions).exists()).scalar() or False

    has_dates = has_any(Image.taken_at.isnot(None))
    available = [
        dim
        for dim, present in (
            ("camera", has_any(Image.camera_model.isnot(None), Image.camera_model != "")),
            ("lens", has_any(Image.lens_model.isnot(None), Image.lens_model != "")),
            ("focal", has_any(Image.focal_length.isnot(None))),
            ("year", has_dates),
            ("month", has_dates),
            ("rating", has_any(Image.rating > 0)),
            ("file_type", has_any()),
            ("iso", has_any(Image.iso.isnot(None))),
            ("aperture", has_any(Image.aperture.isnot(None))),
            ("shutter", bool(shutter_strings)),
            ("country", has_any(Image.gps_country.isnot(None), Image.gps_country != "")),
        )
        if present
    ]

    type_facet_rows = dict(
        scoped(without="file_type")
        .with_entities(Image.file_type, func.count(Image.id))
        .group_by(Image.file_type)
        .all()
    )
    rating_rows = dict(
        scoped(without="rating")
        .with_entities(Image.rating, func.count(Image.id))
        .group_by(Image.rating)
        .all()
    )

    return schemas.LibraryStats(
        library_total_photos=visible.count(),
        available=available,
        total_photos=total_photos,
        total_bytes=int(total_bytes),
        raw_count=type_rows.get(FileType.raw, 0),
        jpeg_count=type_rows.get(FileType.jpeg, 0),
        # Only shots whose *other* half is also in the library: a photo whose
        # partner sits in the Trash is a single file right now, and counting it
        # made the pair total drift up by one for every second such photo.
        pair_count=filtered.filter(
            Image.paired_image_id.in_(visible.with_entities(Image.id))
        ).count()
        // 2,
        edited_count=filtered.filter(Image.edit_rev > 0).count(),
        with_gps_count=filtered.filter(Image.gps_lat.isnot(None)).count(),
        rated_count=filtered.filter(Image.rating > 0).count(),
        camera_count=distinct_count(Image.camera_model),
        lens_count=distinct_count(Image.lens_model),
        cameras=named_facet(Image.camera_model, "camera", camera),
        lenses=named_facet(Image.lens_model, "lens", lens),
        countries=named_facet(Image.gps_country, "country", country),
        focal_buckets=bucket_facet(Image.focal_length, _FOCAL_BUCKETS, "focal"),
        isos=bucket_facet(Image.iso, _ISO_BUCKETS, "iso"),
        apertures=bucket_facet(Image.aperture, _APERTURE_BUCKETS, "aperture"),
        shutters=shutter_facet(),
        years=time_facet("%Y", "year"),
        months=time_facet("%m", "month", month_name),
        ratings=[
            schemas.StatCount(key=str(stars), name=str(stars), count=rating_rows.get(stars, 0))
            for stars in range(1, 6)
        ],
        file_types=[
            schemas.StatCount(key=ft.value, name=label, count=type_facet_rows.get(ft, 0))
            for ft, label in ((FileType.jpeg, "JPEG files"), (FileType.raw, "RAW files"))
            if type_facet_rows.get(ft)
        ],
        first_taken_at=first_taken,
        last_taken_at=last_taken,
    )

"""Library statistics for the dashboard (top-bar chart icon): one aggregate
snapshot of what's in the library - counts, storage, gear usage, focal-length
distribution, activity per year. Read-only; every number comes from a handful
of GROUP BYs over the visible (non-trashed) photos."""

from fastapi import APIRouter, Depends
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app import schemas
from app.auth import get_current_user
from app.db.models import FileType, Image, User
from app.db.session import get_db

router = APIRouter(prefix="/stats", tags=["stats"])

# Focal-length buckets (real focal length in mm, as written by the camera).
# Labeled by the photographic range name so the chart reads as "what do I
# actually shoot with", not a raw histogram.
_FOCAL_BUCKETS: list[tuple[str, float, float]] = [
    ("Ultra wide (<16mm)", 0.0, 16.0),
    ("Wide (16-23mm)", 16.0, 24.0),
    ("Semi wide (24-35mm)", 24.0, 36.0),
    ("Normal (36-50mm)", 36.0, 51.0),
    ("Short tele (51-85mm)", 51.0, 86.0),
    ("Tele (86-135mm)", 86.0, 136.0),
    ("Long tele (136-300mm)", 136.0, 301.0),
    ("Super tele (>300mm)", 301.0, 100000.0),
]


@router.get("/library", response_model=schemas.LibraryStats)
def library_stats(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    visible = db.query(Image).filter(
        Image.owner_id == current_user.id, Image.deleted_at.is_(None)
    )

    def facet(column, limit: int | None = None) -> list[schemas.StatCount]:
        q = (
            visible.with_entities(column, func.count(Image.id))
            .filter(column.isnot(None), column != "")
            .group_by(column)
            .order_by(func.count(Image.id).desc())
        )
        rows = q.limit(limit).all() if limit else q.all()
        return [schemas.StatCount(name=str(name), count=count) for name, count in rows]

    total_photos, total_bytes = visible.with_entities(
        func.count(Image.id),
        # Virtual copies ("canvas edits") share their source's bytes - counting
        # their file_size would report the library bigger than the disk says.
        func.coalesce(
            func.sum(case((Image.virtual_of_image_id.is_(None), Image.file_size), else_=0)), 0
        ),
    ).one()

    type_rows = dict(
        visible.with_entities(Image.file_type, func.count(Image.id))
        .group_by(Image.file_type)
        .all()
    )

    focal_rows = (
        visible.with_entities(Image.focal_length, func.count(Image.id))
        .filter(Image.focal_length.isnot(None))
        .group_by(Image.focal_length)
        .all()
    )
    focal_buckets = []
    for label, lo, hi in _FOCAL_BUCKETS:
        count = sum(c for mm, c in focal_rows if lo <= mm < hi)
        if count:
            focal_buckets.append(schemas.StatCount(name=label, count=count))

    # Photos per capture year, oldest first (SQLite: strftime on taken_at).
    year_rows = (
        visible.with_entities(func.strftime("%Y", Image.taken_at), func.count(Image.id))
        .filter(Image.taken_at.isnot(None))
        .group_by(func.strftime("%Y", Image.taken_at))
        .order_by(func.strftime("%Y", Image.taken_at))
        .all()
    )

    rating_rows = dict(
        visible.with_entities(Image.rating, func.count(Image.id)).group_by(Image.rating).all()
    )

    first_taken, last_taken = visible.with_entities(
        func.min(Image.taken_at), func.max(Image.taken_at)
    ).one()

    return schemas.LibraryStats(
        total_photos=total_photos,
        total_bytes=int(total_bytes),
        raw_count=type_rows.get(FileType.raw, 0),
        jpeg_count=type_rows.get(FileType.jpeg, 0),
        # Only shots whose *other* half is also in the library: a photo whose
        # partner sits in the Trash is a single file right now, and counting it
        # made the pair total drift up by one for every second such photo.
        pair_count=visible.filter(
            Image.paired_image_id.in_(visible.with_entities(Image.id))
        ).count()
        // 2,
        edited_count=visible.filter(Image.edit_rev > 0).count(),
        with_gps_count=visible.filter(Image.gps_lat.isnot(None)).count(),
        rated_count=visible.filter(Image.rating > 0).count(),
        camera_count=visible.with_entities(func.count(func.distinct(Image.camera_model)))
        .filter(Image.camera_model.isnot(None), Image.camera_model != "")
        .scalar()
        or 0,
        lens_count=visible.with_entities(func.count(func.distinct(Image.lens_model)))
        .filter(Image.lens_model.isnot(None), Image.lens_model != "")
        .scalar()
        or 0,
        cameras=facet(Image.camera_model, limit=10),
        lenses=facet(Image.lens_model, limit=10),
        focal_buckets=focal_buckets,
        years=[
            schemas.StatCount(name=str(year), count=count)
            for year, count in year_rows
            if year is not None
        ],
        ratings=[
            schemas.StatCount(name=str(stars), count=rating_rows.get(stars, 0))
            for stars in range(1, 6)
        ],
        first_taken_at=first_taken,
        last_taken_at=last_taken,
    )

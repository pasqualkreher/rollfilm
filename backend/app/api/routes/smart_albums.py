"""Read-only API for the automatic ("smart") albums. Nothing here is stored:
the list endpoint assembles similarity clusters + time groups on the fly (see
services/smart_albums.py) and the images endpoint resolves one smart album's
members. Smart ids are self-describing strings - "cluster:2", "year:2024",
"month:2024-07", "day:2024-07-12", "place:48.1374,11.5755", "edits:all",
"cluster-group:Mountains" (every moment sharing that base label at once) - so
no id survives a rebuild by accident.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import schemas
from app.auth import get_current_user
from app.db.models import FileType, Image, ImageTag, Tag, User
from app.db.session import get_db
from app.services import smart_albums as smart_service
from app.services import sources as sources_service
from app.services.settings_store import get_smart_album_config

router = APIRouter(prefix="/smart-albums", tags=["smart-albums"])


def _cluster_out(
    db: Session, index: int, cluster: smart_service.SmartCluster
) -> schemas.SmartAlbumOut:
    # Mosaic covers: newest JPEG members only; RAWs (dark render, usually
    # doubling a JPEG of the same shot) only when the cluster has no JPEG.
    covers = [
        row[0]
        for row in db.query(Image.id)
        .filter(Image.id.in_(cluster.image_ids), Image.file_type == FileType.jpeg)
        .order_by(Image.taken_at.desc(), Image.id.asc())
        .limit(smart_service.COVER_COUNT)
        .all()
    ]
    if not covers:
        covers = [cluster.cover_image_id] + [
            i for i in cluster.image_ids if i != cluster.cover_image_id
        ]
        covers = covers[: smart_service.COVER_COUNT]
    return schemas.SmartAlbumOut(
        id=f"cluster:{index}",
        kind="cluster",
        name=cluster.name,
        image_count=len(cluster.image_ids),
        cover_image_id=covers[0],
        cover_image_ids=covers,
        group=cluster.group or cluster.name,
    )


def _time_out(kind: str, album: smart_service.GroupAlbum) -> schemas.SmartAlbumOut:
    return schemas.SmartAlbumOut(
        id=album.id,
        kind=kind,
        name=album.name,
        image_count=album.image_count,
        cover_image_id=album.cover_image_id,
        cover_image_ids=album.cover_image_ids,
    )


@router.get("", response_model=schemas.SmartAlbumsOut)
def list_smart_albums(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    """Assemble the enabled smart-album sections. Disabled ones come back as
    empty lists (and aren't computed at all - switching Moments off also means
    never loading the CLIP model for it)."""
    cfg = get_smart_album_config(db)
    enabled = set(cfg.sections)

    status, clusters = ("ready", [])
    if "moments" in enabled:
        status, clusters = smart_service.get_clusters(db)

    tag_albums = (
        smart_service.get_tag_albums(db, current_user.id) if "tags" in enabled else []
    )

    empty_times = {"years": [], "months": [], "days": []}
    time_albums = (
        smart_service.get_time_albums(db, current_user.id)
        if enabled & {"years", "months", "days"}
        else empty_times
    )
    places = (
        smart_service.get_place_albums(db, current_user.id, cfg.place_radius_km)
        if "places" in enabled
        else []
    )
    country_albums = (
        smart_service.get_country_albums(db, current_user.id)
        if enabled & {"countries", "country_years"}
        else {"countries": [], "country_years": []}
    )
    edits = (
        smart_service.get_edits_album(db, current_user.id)
        if "edits" in enabled
        else []
    )

    def section(key: str, albums, kind: str):
        return [_time_out(kind, a) for a in albums] if key in enabled else []

    return schemas.SmartAlbumsOut(
        clusters_status=status,
        clusters=[_cluster_out(db, i, c) for i, c in enumerate(clusters)],
        tags=[_time_out("tag", a) for a in tag_albums],
        places=[_time_out("place", a) for a in places],
        countries=section("countries", country_albums["countries"], "country"),
        country_years=section("country_years", country_albums["country_years"], "country_year"),
        years=section("years", time_albums["years"], "year"),
        months=section("months", time_albums["months"], "month"),
        days=section("days", time_albums["days"], "day"),
        edits=[_time_out("edits", a) for a in edits],
    )


def _time_bounds(kind: str, key: str) -> tuple[datetime, datetime]:
    if kind == "year":
        y = int(key)
        return datetime(y, 1, 1), datetime(y + 1, 1, 1)
    if kind == "month":
        y, m = (int(p) for p in key.split("-"))
        nxt = (y + 1, 1) if m == 12 else (y, m + 1)
        return datetime(y, m, 1), datetime(*nxt, 1)
    y, m, d = (int(p) for p in key.split("-"))
    start = datetime(y, m, d)
    end = datetime.fromordinal(start.toordinal() + 1)
    return start, end


@router.get("/{smart_id}/images", response_model=list[schemas.ImageOut])
def smart_album_images(
    smart_id: str,
    limit: int = 500,
    offset: int = 0,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    kind, sep, key = smart_id.partition(":")
    if not sep:
        raise HTTPException(status_code=404, detail="Unknown smart album")

    unavailable = sources_service.unavailable_source_ids(db, current_user.id)
    query = db.query(Image).filter(
        Image.owner_id == current_user.id, Image.deleted_at.is_(None)
    )
    query = sources_service.exclude_unavailable(query, unavailable)

    if kind == "cluster":
        _, clusters = smart_service.get_clusters(db)
        try:
            cluster = clusters[int(key)]
        except (ValueError, IndexError):
            # Rebuilds shuffle cluster indices; a stale link just comes up empty.
            raise HTTPException(status_code=404, detail="Smart album no longer exists")
        query = query.filter(Image.id.in_(cluster.image_ids))
    elif kind == "cluster-group":
        # All moments sharing one base label ("Mountains") merged into one view.
        _, clusters = smart_service.get_clusters(db)
        ids = [
            image_id
            for cluster in clusters
            if (cluster.group or cluster.name) == key
            for image_id in cluster.image_ids
        ]
        if not ids:
            raise HTTPException(status_code=404, detail="Smart album no longer exists")
        query = query.filter(Image.id.in_(ids))
    elif kind == "tag":
        tagged = (
            db.query(ImageTag.image_id)
            .join(Tag, Tag.id == ImageTag.tag_id)
            .filter(Tag.owner_id == current_user.id, Tag.name == key)
        )
        query = query.filter(Image.id.in_(tagged))
    elif kind == "place":
        try:
            lat_s, lon_s = key.split(",")
            lat, lon = float(lat_s), float(lon_s)
        except ValueError:
            raise HTTPException(status_code=404, detail="Unknown smart album")
        radius = get_smart_album_config(db).place_radius_km
        ids = smart_service.place_image_ids(db, current_user.id, lat, lon, radius, unavailable)
        query = query.filter(Image.id.in_(ids))
    elif kind == "country":
        query = query.filter(Image.gps_country == key)
    elif kind == "country-year":
        country, _, year_s = key.rpartition(":")
        try:
            year = int(year_s)
        except ValueError:
            raise HTTPException(status_code=404, detail="Unknown smart album")
        query = query.filter(
            Image.gps_country == country,
            Image.taken_at >= datetime(year, 1, 1),
            Image.taken_at < datetime(year + 1, 1, 1),
        )
    elif kind == "edits":
        query = query.filter(smart_service.edited_filter())
    elif kind in ("year", "month", "day"):
        try:
            start, end = _time_bounds(kind, key)
        except ValueError:
            raise HTTPException(status_code=404, detail="Unknown smart album")
        query = query.filter(Image.taken_at >= start, Image.taken_at < end)
    else:
        raise HTTPException(status_code=404, detail="Unknown smart album")

    # Same total order as the library grid (see images.list_images).
    query = query.order_by(
        Image.taken_at.desc(), Image.original_filename.desc(), Image.id.desc()
    )
    return query.offset(offset).limit(limit).all()

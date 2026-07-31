from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends
from fastapi import Query as QueryParam
from sqlalchemy import func
from sqlalchemy.orm import Query, Session

from app import schemas
from app.auth import get_current_user
from app.db.models import AlbumImage, ColorLabel, FileType, Image, ImageTag, Tag, User
from app.db.session import engine, get_db
from app.services import embeddings, geocode, sources as sources_service

router = APIRouter(prefix="/search", tags=["search"])


def _apply_scope(
    query: Query,
    *,
    owner_id: int,
    album_id: str | None,
    rating_min: int | None,
    color_label: ColorLabel | None,
    camera_model: str | None,
    lens_model: str | None,
    focal_min: float | None,
    focal_max: float | None,
    country: str | None,
    date_from: datetime | None,
    date_to: datetime | None,
    tags: list[str] | None,
    view_mode: str,
    db: Session,
) -> Query:
    """Apply the same scope/filters the grid is currently showing, so a search
    only ever returns photos from the active view (the whole library, or one
    album) that also match the active rating/color/date/tag filters."""
    query = query.filter(Image.owner_id == owner_id, Image.deleted_at.is_(None))
    if album_id:
        query = query.join(AlbumImage, AlbumImage.image_id == Image.id).filter(
            AlbumImage.album_id == album_id
        )
    if rating_min is not None:
        query = query.filter(Image.rating >= rating_min)
    if color_label is not None:
        query = query.filter(Image.color_label == color_label)
    if camera_model:
        query = query.filter(Image.camera_model == camera_model)
    if lens_model:
        query = query.filter(Image.lens_model == lens_model)
    # Focal range with the same 0.05mm tolerance as the library filter (the
    # slider's endpoint values are rounded to 0.1mm; see routes/images).
    if focal_min is not None:
        query = query.filter(Image.focal_length >= focal_min - 0.05)
    if focal_max is not None:
        query = query.filter(Image.focal_length <= focal_max + 0.05)
    if country == geocode.NO_LOCATION:
        query = query.filter(Image.gps_lat.is_(None))
    elif country:
        query = query.filter(Image.gps_country == country)
    if date_from:
        query = query.filter(Image.taken_at >= date_from)
    if date_to:
        query = query.filter(Image.taken_at <= date_to)
    wanted = [t for t in (tags or []) if t]
    if wanted:
        # A subquery (rather than a join) so this composes safely with the
        # tag-text-match query below, which already joins ImageTag/Tag itself.
        # AND semantics: the photo must carry every selected tag.
        matching_ids = (
            db.query(ImageTag.image_id)
            .join(Tag, Tag.id == ImageTag.tag_id)
            .filter(Tag.owner_id == owner_id, Tag.name.in_(wanted))
            .group_by(ImageTag.image_id)
            .having(func.count(func.distinct(Tag.name)) == len(wanted))
        )
        query = query.filter(Image.id.in_(matching_ids))
    if view_mode == "jpeg_only":
        query = query.filter(Image.file_type == FileType.jpeg)
    elif view_mode == "raw_only":
        query = query.filter(Image.file_type == FileType.raw)
    return query


# A "city" query returns the photos taken around that city, not the whole
# geotagged library sorted by distance - beyond this radius a photo has
# nothing to do with the place, and the slots are better spent on similarity.
_CITY_RADIUS_KM = 75.0


@router.get("", response_model=list[schemas.SearchResultOut])
def search_images(
    q: str,
    limit: int = 40,
    lang: str | None = None,
    album_id: str | None = None,
    rating_min: int | None = None,
    color_label: ColorLabel | None = None,
    camera_model: str | None = None,
    lens_model: str | None = None,
    focal_min: float | None = None,
    focal_max: float | None = None,
    country: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    tags: list[str] | None = QueryParam(None),
    view_mode: Literal["combined", "jpeg_only", "raw_only"] = "combined",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Free-text photo search, ranked by how explicit the signal is:

    1. Tag matches - a photo tagged "sunset" almost certainly is one.
    2. Location matches - a query naming a country or city (in English or the
       UI language passed as `lang`, e.g. "italien"/"münchen") pulls the
       photos taken there: a whole country newest-first, a city by distance.
    3. CLIP visual similarity fills the remaining slots - finds photos
       matching the *description* even without tags or GPS.

    Everything is constrained to the caller-supplied scope (album + rating /
    color / date / tag filters), so search acts on the grid the user is
    looking at rather than the whole library."""
    scope_kwargs = dict(
        owner_id=current_user.id,
        album_id=album_id,
        rating_min=rating_min,
        color_label=color_label,
        camera_model=camera_model,
        lens_model=lens_model,
        focal_min=focal_min,
        focal_max=focal_max,
        country=country,
        date_from=date_from,
        date_to=date_to,
        tags=tags,
        view_mode=view_mode,
        db=db,
    )

    results: list[schemas.SearchResultOut] = []
    seen_ids: set[str] = set()

    def _append(image: Image, distance: float) -> None:
        if image.id in seen_ids:
            return
        seen_ids.add(image.id)
        results.append(schemas.SearchResultOut(image=image, distance=distance))

    def add(image: Image, distance: float) -> None:
        # RAW+JPEG pairs are the same shot. Whichever half a search matched,
        # return *both* halves in the combined view - exactly like the library
        # index does - so the grid can honour the user's merge toggle: merged,
        # the client collapses the pair onto its JPEG; unmerged, it shows the RAW
        # right next to the JPEG. Neither is possible when the ranked, limit-
        # capped result set carries only one half, so we complete the pair here.
        # Added JPEG-first and adjacently, so the pair stays together and the
        # JPEG is its representative.
        if view_mode == "combined" and image.paired_image_id:
            partner = db.get(Image, image.paired_image_id)
            if partner and partner.owner_id == current_user.id and partner.deleted_at is None:
                jpeg, raw = (
                    (partner, image)
                    if image.file_type == FileType.raw
                    else (image, partner)
                )
                _append(jpeg, distance)
                _append(raw, distance)
                return
        _append(image, distance)

    # Same rule as the library grid: photos from a disconnected external source
    # aren't searchable while their drive/NAS is offline.
    unavailable = sources_service.unavailable_source_ids(db, current_user.id)

    # 1) Tag matches - the most explicit signal there is.
    tag_query = (
        db.query(Image)
        .join(ImageTag, ImageTag.image_id == Image.id)
        .join(Tag, Tag.id == ImageTag.tag_id)
        .filter(Tag.name.ilike(f"%{q}%"))
    )
    tag_matches = (
        sources_service.exclude_unavailable(_apply_scope(tag_query, **scope_kwargs), unavailable)
        .order_by(Image.taken_at.desc())
        .limit(limit)
        .all()
    )
    for image in tag_matches:
        add(image, 0.0)

    # 2) Location matches. A country query (English or UI language) pulls that
    # country's photos newest-first; a city query pulls the photos within
    # _CITY_RADIUS_KM, nearest first. Gated on cheap name lookups so ordinary
    # queries skip the geo work entirely.
    if len(results) < limit:
        country_name = geocode.country_from_query(q, lang=lang)
        if country_name:
            country_matches = (
                sources_service.exclude_unavailable(
                    _apply_scope(db.query(Image), **scope_kwargs).filter(
                        Image.gps_country == country_name
                    ),
                    unavailable,
                )
                .order_by(Image.taken_at.desc())
                .limit(limit)
                .all()
            )
            for image in country_matches:
                add(image, 0.0)
        elif geocode.place_candidates(q, lang=lang):
            geo_query = _apply_scope(db.query(Image), **scope_kwargs).filter(
                Image.gps_lat.isnot(None), Image.gps_lon.isnot(None)
            )
            geo_images = sources_service.exclude_unavailable(geo_query, unavailable).all()
            if geo_images:
                # Disambiguate same-named places toward where this library's
                # photos actually are (Rome, IT vs Rome, GA).
                centroid = (
                    sum(im.gps_lat for im in geo_images) / len(geo_images),
                    sum(im.gps_lon for im in geo_images) / len(geo_images),
                )
                place = geocode.resolve_place(q, near=centroid, lang=lang)
                if place:
                    ranked = sorted(
                        (
                            (
                                im,
                                geocode.haversine_km(
                                    (im.gps_lat, im.gps_lon), (place.lat, place.lon)
                                ),
                            )
                            for im in geo_images
                        ),
                        key=lambda t: t[1],
                    )
                    for im, dist in ranked:
                        if dist > _CITY_RADIUS_KM or len(results) >= limit:
                            break
                        add(im, dist)

    if len(results) < limit:
        vector = embeddings.encode_text(q)
        # Over-fetch candidates: many will be filtered out by the scope, so ask
        # for a generous pool and keep the first that survive, in similarity
        # order. The set of ids allowed by the current scope is looked up once.
        allowed_ids = {
            row.id
            for row in sources_service.exclude_unavailable(
                _apply_scope(db.query(Image.id), **scope_kwargs), unavailable
            ).all()
        }
        candidate_pool = max(limit * 5, 200)
        matches = embeddings.query_similar(engine, vector, k=candidate_pool)
        for image_id, distance in matches:
            if len(results) >= limit:
                break
            if image_id in seen_ids or image_id not in allowed_ids:
                continue
            image = db.get(Image, image_id)
            if image:
                add(image, distance)

    # Pairs are appended adjacently, so the hard cut can split at most the one
    # pair straddling the boundary - keep both its halves rather than orphaning
    # a RAW/JPEG from its partner.
    if len(results) > limit >= 1:
        last, nxt = results[limit - 1].image, results[limit].image
        if last.paired_image_id == nxt.id:
            return results[: limit + 1]
    return results[:limit]

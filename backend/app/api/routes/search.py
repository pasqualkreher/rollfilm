from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Query, Session

from app import schemas
from app.auth import get_current_user
from app.db.models import AlbumImage, ColorLabel, FileType, Image, ImageTag, Tag, User
from app.db.session import engine, get_db
from app.services import embeddings

router = APIRouter(prefix="/search", tags=["search"])


def _apply_scope(
    query: Query,
    *,
    owner_id: int,
    album_id: str | None,
    rating_min: int | None,
    color_label: ColorLabel | None,
    camera_model: str | None,
    date_from: datetime | None,
    date_to: datetime | None,
    view_mode: str,
) -> Query:
    """Apply the same scope/filters the grid is currently showing, so a search
    only ever returns photos from the active view (the whole library, or one
    album) that also match the active rating/color/date filters."""
    query = query.filter(Image.owner_id == owner_id)
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
    if date_from:
        query = query.filter(Image.taken_at >= date_from)
    if date_to:
        query = query.filter(Image.taken_at <= date_to)
    if view_mode == "jpeg_only":
        query = query.filter(Image.file_type == FileType.jpeg)
    elif view_mode == "raw_only":
        query = query.filter(Image.file_type == FileType.raw)
    return query


@router.get("", response_model=list[schemas.SearchResultOut])
def search_images(
    q: str,
    limit: int = 40,
    album_id: str | None = None,
    rating_min: int | None = None,
    color_label: ColorLabel | None = None,
    camera_model: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    view_mode: Literal["combined", "jpeg_only", "raw_only"] = "combined",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Free-text photo search combining exact tag matches (a precise, explicit
    signal - a photo tagged "sunset" almost certainly is one) with CLIP
    visual similarity (which finds photos matching the *description* even
    without any tags). Tag matches are listed first, then similarity results
    fill any remaining slots.

    Everything is constrained to the caller-supplied scope (album + rating /
    color / date filters), so search acts on the grid the user is looking at
    rather than the whole library."""
    scope_kwargs = dict(
        owner_id=current_user.id,
        album_id=album_id,
        rating_min=rating_min,
        color_label=color_label,
        camera_model=camera_model,
        date_from=date_from,
        date_to=date_to,
        view_mode=view_mode,
    )

    results: list[schemas.SearchResultOut] = []
    seen_ids: set[str] = set()

    tag_query = (
        db.query(Image)
        .join(ImageTag, ImageTag.image_id == Image.id)
        .join(Tag, Tag.id == ImageTag.tag_id)
        .filter(Tag.name.ilike(f"%{q}%"))
    )
    tag_matches = (
        _apply_scope(tag_query, **scope_kwargs).order_by(Image.taken_at.desc()).limit(limit).all()
    )
    for image in tag_matches:
        seen_ids.add(image.id)
        results.append(schemas.SearchResultOut(image=image, distance=0.0))

    if len(results) < limit:
        vector = embeddings.encode_text(q)
        # Over-fetch candidates: many will be filtered out by the scope, so ask
        # for a generous pool and keep the first that survive, in similarity
        # order. The set of ids allowed by the current scope is looked up once.
        allowed_ids = {
            row.id for row in _apply_scope(db.query(Image.id), **scope_kwargs).all()
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
                seen_ids.add(image.id)
                results.append(schemas.SearchResultOut(image=image, distance=distance))

    return results[:limit]

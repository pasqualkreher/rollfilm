from fastapi import APIRouter, Depends

from app import schemas
from app.auth import get_current_user
from app.db.models import Image, ImageTag, Tag, User
from app.db.session import engine, get_db
from app.services import embeddings

router = APIRouter(prefix="/search", tags=["search"])


@router.get("", response_model=list[schemas.SearchResultOut])
def search_images(
    q: str,
    limit: int = 40,
    db=Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Free-text photo search combining exact tag matches (a precise, explicit
    signal - a photo tagged "sunset" almost certainly is one) with CLIP
    visual similarity (which finds photos matching the *description* even
    without any tags). Tag matches are listed first, then similarity results
    fill any remaining slots."""
    results: list[schemas.SearchResultOut] = []
    seen_ids: set[str] = set()

    tag_matches = (
        db.query(Image)
        .join(ImageTag, ImageTag.image_id == Image.id)
        .join(Tag, Tag.id == ImageTag.tag_id)
        .filter(Image.owner_id == current_user.id, Tag.name.ilike(f"%{q}%"))
        .order_by(Image.taken_at.desc())
        .limit(limit)
        .all()
    )
    for image in tag_matches:
        seen_ids.add(image.id)
        results.append(schemas.SearchResultOut(image=image, distance=0.0))

    if len(results) < limit:
        vector = embeddings.encode_text(q)
        matches = embeddings.query_similar(engine, vector, k=(limit - len(results)) + len(seen_ids))
        for image_id, distance in matches:
            if image_id in seen_ids or len(results) >= limit:
                continue
            image = db.get(Image, image_id)
            if image and image.owner_id == current_user.id:
                seen_ids.add(image.id)
                results.append(schemas.SearchResultOut(image=image, distance=distance))

    return results[:limit]

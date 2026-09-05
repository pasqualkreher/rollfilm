from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import schemas
from app.auth import get_current_user
from app.db.models import Image, ImageTag, Tag, User
from app.db.session import get_db
from app.services.auto_tags import auto_tag_criterion, auto_tag_error, is_auto_tag

router = APIRouter(prefix="/tags", tags=["tags"])


@router.get("", response_model=list[str])
def list_tags(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """The tags the user's photos carry right now - the Library's tag filter
    and the "propose existing tags" autocomplete (so near-duplicates like
    "sunset" vs "Sunset" don't pile up). A tag that only photos in the Trash
    still carry is not offered: there is nothing to filter for and nothing to
    complete to. Its row stays, so restoring the photos brings it back."""
    rows = (
        db.query(Tag.name)
        .join(ImageTag, ImageTag.tag_id == Tag.id)
        .join(Image, Image.id == ImageTag.image_id)
        .filter(Tag.owner_id == current_user.id, Image.deleted_at.is_(None))
        .distinct()
        .order_by(Tag.name)
        .all()
    )
    return [name for (name,) in rows]


@router.get("/usage", response_model=list[schemas.TagUsage])
def tag_usage(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """The user's own tags (never the app's - see auto_tags) with how many
    photos outside the Trash carry each. Settings lists them so a tag can be
    deleted from every photo at once."""
    live = (
        db.query(ImageTag.tag_id, func.count(ImageTag.id).label("n"))
        .join(Image, Image.id == ImageTag.image_id)
        .filter(Image.deleted_at.is_(None))
        .group_by(ImageTag.tag_id)
        .subquery()
    )
    rows = (
        db.query(Tag.name, func.coalesce(live.c.n, 0))
        .outerjoin(live, live.c.tag_id == Tag.id)
        .filter(Tag.owner_id == current_user.id, ~auto_tag_criterion())
        .order_by(Tag.name)
        .all()
    )
    return [schemas.TagUsage(name=name, count=count) for name, count in rows]


@router.delete("/{name}", status_code=204)
def delete_tag(name: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Delete a tag entirely, also unlinking it from any photos that still carry
    it (so it works whether or not the tag is unused)."""
    if is_auto_tag(name):
        raise HTTPException(status_code=400, detail=auto_tag_error(name))
    tag = db.query(Tag).filter(Tag.owner_id == current_user.id, Tag.name == name).first()
    if tag is None:
        raise HTTPException(status_code=404, detail="Tag not found")
    db.query(ImageTag).filter(ImageTag.tag_id == tag.id).delete()
    db.delete(tag)
    db.commit()

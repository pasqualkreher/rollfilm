from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import schemas
from app.auth import get_current_user
from app.db.models import ImageTag, Tag, User
from app.db.session import get_db

router = APIRouter(prefix="/tags", tags=["tags"])


@router.get("", response_model=list[str])
def list_tags(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """All tag names this user has ever created - used to power the "propose
    existing tags" autocomplete when adding a tag, so near-duplicate tags
    (e.g. "sunset" vs "Sunset") don't pile up."""
    tags = db.query(Tag).filter(Tag.owner_id == current_user.id).order_by(Tag.name).all()
    return [t.name for t in tags]


@router.get("/usage", response_model=list[schemas.TagUsage])
def tag_usage(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Every tag with how many photos currently use it. `count == 0` marks an
    unused tag (left behind after its photos were retagged or deleted), which
    Settings offers to clean up."""
    rows = (
        db.query(Tag.name, func.count(ImageTag.id))
        .outerjoin(ImageTag, ImageTag.tag_id == Tag.id)
        .filter(Tag.owner_id == current_user.id)
        .group_by(Tag.id)
        .order_by(Tag.name)
        .all()
    )
    return [schemas.TagUsage(name=name, count=count) for name, count in rows]


@router.delete("/{name}", status_code=204)
def delete_tag(name: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Delete a tag entirely, also unlinking it from any photos that still carry
    it (so it works whether or not the tag is unused)."""
    tag = db.query(Tag).filter(Tag.owner_id == current_user.id, Tag.name == name).first()
    if tag is None:
        raise HTTPException(status_code=404, detail="Tag not found")
    db.query(ImageTag).filter(ImageTag.tag_id == tag.id).delete()
    db.delete(tag)
    db.commit()


@router.post("/prune-unused", response_model=schemas.PruneTagsResult)
def prune_unused_tags(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Remove every tag that isn't attached to any photo, in one go."""
    used_tag_ids = db.query(ImageTag.tag_id).distinct().subquery()
    unused = (
        db.query(Tag)
        .filter(Tag.owner_id == current_user.id, Tag.id.notin_(used_tag_ids.select()))
        .all()
    )
    removed = sorted(t.name for t in unused)
    for tag in unused:
        db.delete(tag)
    db.commit()
    return schemas.PruneTagsResult(removed=removed)

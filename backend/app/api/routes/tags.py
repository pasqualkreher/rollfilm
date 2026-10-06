from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app import schemas
from app.auth import get_current_user
from app.db.models import Image, ImageTag, Tag, User
from app.db.session import get_db
from app.services import sidecar as sidecar_service
from app.services import tags as tags_service
from app.services.auto_tags import auto_tag_criterion, auto_tag_error, is_auto_tag

router = APIRouter(prefix="/tags", tags=["tags"])


@router.get("", response_model=list[str])
def list_tags(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """The tags the user's photos carry right now - the Library's tag filter
    and the "propose existing tags" autocomplete (so near-duplicates like
    "sunset" vs "Sunset" don't pile up) - plus the kept ones from an imported
    keyword list, which are words to pick from whether or not a photo has
    them yet. A tag that only photos in the Trash still carry is not offered:
    there is nothing to filter for and nothing to complete to. Its row stays,
    so restoring the photos brings it back. A name is a full path
    ("Travel/Italy/Rome"); the UI derives the tree from the paths."""
    live = (
        db.query(Tag.id)
        .join(ImageTag, ImageTag.tag_id == Tag.id)
        .join(Image, Image.id == ImageTag.image_id)
        .filter(Image.deleted_at.is_(None))
    )
    rows = (
        db.query(Tag.name)
        .filter(Tag.owner_id == current_user.id, or_(Tag.kept.is_(True), Tag.id.in_(live)))
        .distinct()
        .order_by(Tag.name)
        .all()
    )
    return [name for (name,) in rows]


@router.get("/usage", response_model=list[schemas.TagUsage])
def tag_usage(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """The user's own tags (never the app's - see auto_tags) with how many
    photos outside the Trash carry each. Settings lists them so a tag can be
    renamed or deleted from every photo at once."""
    live = (
        db.query(ImageTag.tag_id, func.count(ImageTag.id).label("n"))
        .join(Image, Image.id == ImageTag.image_id)
        .filter(Image.deleted_at.is_(None))
        .group_by(ImageTag.tag_id)
        .subquery()
    )
    rows = (
        db.query(Tag.name, func.coalesce(live.c.n, 0), Tag.kept)
        .outerjoin(live, live.c.tag_id == Tag.id)
        .filter(Tag.owner_id == current_user.id, ~auto_tag_criterion())
        .order_by(Tag.name)
        .all()
    )
    return [schemas.TagUsage(name=name, count=count, kept=bool(kept)) for name, count, kept in rows]


@router.get("/export", response_class=PlainTextResponse)
def export_tags(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """The user's tag tree as a keyword list - the tab-indented text file
    Lightroom, Bridge and digiKam import - so the vocabulary built here can
    move on, with the photos or without them."""
    names = [
        name
        for (name,) in db.query(Tag.name)
        .filter(Tag.owner_id == current_user.id, ~auto_tag_criterion())
        .order_by(Tag.name)
    ]
    return PlainTextResponse(
        tags_service.export_keyword_list(names),
        headers={"Content-Disposition": 'attachment; filename="keywords.txt"'},
    )


@router.post("/import", response_model=schemas.TagImportResult)
def import_tags(
    payload: schemas.TagImportRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Take a keyword list in (the same format export_tags writes): every
    path becomes a kept tag, so a tag tree built in digiKam or Lightroom is
    there to pick from before a single photo carries it."""
    created, existing = tags_service.import_keyword_list(db, current_user.id, payload.text)
    db.commit()
    return schemas.TagImportResult(created=created, existing=existing)


@router.patch("/{name:path}", response_model=list[schemas.TagUsage])
def rename_tag(
    name: str,
    payload: schemas.TagRenameRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Rename a tag - and everything filed under it: renaming "Travel" renames
    "Travel/Italy/Rome" too. A path with other parents moves the tag."""
    if is_auto_tag(name):
        raise HTTPException(status_code=400, detail=auto_tag_error(name))
    try:
        renamed = tags_service.rename_tag(db, current_user.id, name, payload.name)
    except LookupError:
        raise HTTPException(status_code=404, detail="Tag not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except tags_service.TagConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    new_names = [new for _, new in renamed]
    tag_ids = [
        t.id for t in db.query(Tag).filter(Tag.owner_id == current_user.id, Tag.name.in_(new_names))
    ]
    touched = tags_service.image_ids_with_tags(db, tag_ids)
    db.commit()
    if touched and sidecar_service.get_sidecar_write(db):
        sidecar_service.schedule(touched)
    return tag_usage(db, current_user)


@router.delete("/{name:path}", status_code=204)
def delete_tag(
    name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    with_children: bool = False,
):
    """Delete a tag entirely, also unlinking it from any photos that still carry
    it (so it works whether or not the tag is unused). With `with_children`
    everything filed under it goes too."""
    if is_auto_tag(name):
        raise HTTPException(status_code=400, detail=auto_tag_error(name))
    tag_ids = [
        t.id
        for t in db.query(Tag).filter(
            Tag.owner_id == current_user.id,
            tags_service.matches_criterion(tags_service.normalize(name))
            if with_children
            else Tag.name == tags_service.normalize(name),
        )
    ]
    touched = tags_service.image_ids_with_tags(db, tag_ids)
    deleted = tags_service.delete_tag(db, current_user.id, name, with_children=with_children)
    if not deleted:
        raise HTTPException(status_code=404, detail="Tag not found")
    db.commit()
    if touched and sidecar_service.get_sidecar_write(db):
        sidecar_service.schedule(touched)

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db.models import Tag, User
from app.db.session import get_db

router = APIRouter(prefix="/tags", tags=["tags"])


@router.get("", response_model=list[str])
def list_tags(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """All tag names this user has ever created - used to power the "propose
    existing tags" autocomplete when adding a tag, so near-duplicate tags
    (e.g. "sunset" vs "Sunset") don't pile up."""
    tags = db.query(Tag).filter(Tag.owner_id == current_user.id).order_by(Tag.name).all()
    return [t.name for t in tags]

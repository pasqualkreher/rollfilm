from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import schemas
from app.auth import get_current_user
from app.db.models import Image, User
from app.db.session import get_db
from app.services.settings_store import get_selects, set_selects

router = APIRouter(prefix="/selects", tags=["selects"])

# Ids per IN (...) query, well under SQLite's bound-variable limit.
_CHUNK = 500


def _live(db: Session, owner_id: int, ids: list[str]) -> list[str]:
    """The ids that are photos of this library and not in the Trash, in the
    order given. A photo deleted for good, or one from a library that was
    wiped or restored over, simply drops out of the tray."""
    found: set[str] = set()
    for start in range(0, len(ids), _CHUNK):
        rows = (
            db.query(Image.id)
            .filter(
                Image.owner_id == owner_id,
                Image.deleted_at.is_(None),
                Image.id.in_(ids[start : start + _CHUNK]),
            )
            .all()
        )
        found.update(row[0] for row in rows)
    return [image_id for image_id in ids if image_id in found]


@router.get("", response_model=schemas.Selects)
def read_selects(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """The Selects tray: the photos gathered to act on, in the order they were
    added. Stored with the library, so it is still there after a restart."""
    return schemas.Selects(ids=_live(db, current_user.id, get_selects(db)))


@router.put("", response_model=schemas.Selects)
def write_selects(
    payload: schemas.Selects,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Replace the tray with this list. The app keeps the list itself and
    sends it whole after every change."""
    ids = _live(db, current_user.id, list(dict.fromkeys(payload.ids)))
    set_selects(db, ids)
    db.commit()
    return schemas.Selects(ids=ids)

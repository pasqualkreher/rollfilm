from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import schemas
from app.auth import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.services import immich as immich_service
from app.services.settings_store import (
    IMMICH_API_KEY,
    IMMICH_BASE_URL,
    get_setting,
    set_setting,
)
from app.workers.queue import immich_upload_history

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("/immich", response_model=schemas.ImmichSettingsOut)
def get_immich_settings(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    base_url = get_setting(db, IMMICH_BASE_URL)
    api_key = get_setting(db, IMMICH_API_KEY)
    return schemas.ImmichSettingsOut(base_url=base_url, api_key_set=bool(api_key))


@router.put("/immich", response_model=schemas.ImmichSettingsOut)
def update_immich_settings(
    payload: schemas.ImmichSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    set_setting(db, IMMICH_BASE_URL, payload.base_url.strip())
    # A null/omitted key leaves the stored one untouched (so the user can edit
    # the host without re-typing the key); an empty string clears it.
    if payload.api_key is not None:
        set_setting(db, IMMICH_API_KEY, payload.api_key.strip())
    db.commit()

    api_key = get_setting(db, IMMICH_API_KEY)
    return schemas.ImmichSettingsOut(base_url=payload.base_url.strip(), api_key_set=bool(api_key))


@router.get("/immich/uploads", response_model=list[schemas.ImmichUploadResult])
def recent_immich_uploads(current_user: User = Depends(get_current_user)):
    """Outcome of recent background Immich uploads (kept in memory since the
    last backend start) — the uploads themselves are fire-and-forget, so this
    is how the UI can show whether they actually arrived."""
    return immich_upload_history()


@router.post("/immich/test", response_model=schemas.ImmichTestResult)
def test_immich_settings(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    base_url = (get_setting(db, IMMICH_BASE_URL) or "").strip()
    api_key = (get_setting(db, IMMICH_API_KEY) or "").strip()
    if not base_url or not api_key:
        return schemas.ImmichTestResult(
            ok=False, message="Set both the Immich host and an API key first."
        )
    ok, message = immich_service.check_connection(base_url, api_key)
    return schemas.ImmichTestResult(ok=ok, message=message)

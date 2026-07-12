"""Thin read/write helpers over the app_settings key-value table plus the
typed Immich config the import pipeline and settings routes both need."""

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.db.models import AppSetting

IMMICH_BASE_URL = "immich_base_url"
IMMICH_API_KEY = "immich_api_key"

TRASH_RETENTION_DAYS = "trash_retention_days"
DEFAULT_TRASH_RETENTION_DAYS = 14


@dataclass(frozen=True)
class ImmichConfig:
    base_url: str
    api_key: str


def get_setting(db: Session, key: str) -> str | None:
    row = db.get(AppSetting, key)
    return row.value if row else None


def set_setting(db: Session, key: str, value: str) -> None:
    row = db.get(AppSetting, key)
    if row is None:
        db.add(AppSetting(key=key, value=value))
    else:
        row.value = value


def get_trash_retention_days(db: Session) -> int:
    """How many days a photo stays in the Trash before the startup purge
    permanently deletes it. 0 means "keep forever" (purge disabled)."""
    raw = get_setting(db, TRASH_RETENTION_DAYS)
    try:
        days = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_TRASH_RETENTION_DAYS
    return max(0, days)


def get_immich_config(db: Session) -> ImmichConfig | None:
    """Both a URL and a key must be present for uploads to be attempted -
    a half-configured integration is treated as "not configured"."""
    base_url = (get_setting(db, IMMICH_BASE_URL) or "").strip()
    api_key = (get_setting(db, IMMICH_API_KEY) or "").strip()
    if not base_url or not api_key:
        return None
    return ImmichConfig(base_url=base_url, api_key=api_key)

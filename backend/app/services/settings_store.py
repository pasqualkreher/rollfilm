"""Thin read/write helpers over the app_settings key-value table plus the
typed Immich config the import pipeline and settings routes both need."""

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.db.models import AppSetting

IMMICH_BASE_URL = "immich_base_url"
IMMICH_API_KEY = "immich_api_key"
IMMICH_SYNC_MODE = "immich_sync_mode"
# "1" while the user has paused automatic syncing (e.g. on a metered mobile
# connection): the background sync loop and the fire-and-forget upload queue
# stand down until resumed. Explicit manual "Add to Immich" pushes still work.
IMMICH_SYNC_PAUSED = "immich_sync_paused"

# How photos reach Immich:
#   manual    - the current workflow: a per-import "upload to Immich" checkbox
#               plus the on-demand "Add to Immich" buttons. Nothing automatic.
#   selective - only photos/albums the user has flagged (immich_sync=True) are
#               synced, automatically, whenever they're imported or flagged.
#   full      - every JPEG and every album is synced to Immich automatically.
IMMICH_MODE_MANUAL = "manual"
IMMICH_MODE_SELECTIVE = "selective"
IMMICH_MODE_FULL = "full"
IMMICH_MODES = (IMMICH_MODE_MANUAL, IMMICH_MODE_SELECTIVE, IMMICH_MODE_FULL)
DEFAULT_IMMICH_SYNC_MODE = IMMICH_MODE_MANUAL

TRASH_RETENTION_DAYS = "trash_retention_days"
DEFAULT_TRASH_RETENTION_DAYS = 14

# "1" to load RAWs with no brightness processing - the native (no auto-bright)
# demosaic exactly as the sensor recorded it, instead of self-normalizing each
# RAW to a consistent brightness. For users who want to do all tone work from
# the true raw data themselves.
RAW_NATIVE_DECODE = "raw_native_decode"

# "1" when the Auto develop button is shown in the editor. Off by default: the
# suggestion only becomes useful once the user has saved a few edits, so it's
# an explicit opt-in from Settings (which explains how it learns).
AUTO_DEVELOP_ENABLED = "auto_develop_enabled"
# Which adjustment groups the Auto suggestion may touch, as a comma-separated
# subset of AUTO_DEVELOP_GROUP_NAMES. Unset = all of them; the field lists per
# group live in services/auto_develop.py (GROUP_FIELDS). Groups the user
# unchecks keep their current slider values when Auto runs.
AUTO_DEVELOP_GROUPS = "auto_develop_groups"
AUTO_DEVELOP_GROUP_NAMES = ("tone", "white_balance", "color", "details", "curves", "effects")


@dataclass(frozen=True)
class ImmichConfig:
    base_url: str
    api_key: str
    sync_mode: str = DEFAULT_IMMICH_SYNC_MODE

    @property
    def album_sync(self) -> bool:
        """Both selective and full modes mirror app albums into Immich albums."""
        return self.sync_mode in (IMMICH_MODE_SELECTIVE, IMMICH_MODE_FULL)


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


def get_raw_native_decode(db: Session) -> bool:
    return get_setting(db, RAW_NATIVE_DECODE) == "1"


def get_auto_develop_enabled(db: Session) -> bool:
    return get_setting(db, AUTO_DEVELOP_ENABLED) == "1"


def get_auto_develop_groups(db: Session) -> list[str]:
    """The adjustment groups Auto develop may touch. Unset means all of them;
    an explicitly empty selection means none (the user unchecked everything)."""
    raw = get_setting(db, AUTO_DEVELOP_GROUPS)
    if raw is None:
        return list(AUTO_DEVELOP_GROUP_NAMES)
    return [n for n in raw.split(",") if n in AUTO_DEVELOP_GROUP_NAMES]


def get_immich_sync_paused(db: Session) -> bool:
    return get_setting(db, IMMICH_SYNC_PAUSED) == "1"


def get_immich_sync_mode(db: Session) -> str:
    mode = get_setting(db, IMMICH_SYNC_MODE)
    return mode if mode in IMMICH_MODES else DEFAULT_IMMICH_SYNC_MODE


def get_immich_config(db: Session) -> ImmichConfig | None:
    """Both a URL and a key must be present for uploads to be attempted -
    a half-configured integration is treated as "not configured"."""
    base_url = (get_setting(db, IMMICH_BASE_URL) or "").strip()
    api_key = (get_setting(db, IMMICH_API_KEY) or "").strip()
    if not base_url or not api_key:
        return None
    return ImmichConfig(base_url=base_url, api_key=api_key, sync_mode=get_immich_sync_mode(db))

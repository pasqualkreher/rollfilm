"""Thin read/write helpers over the app_settings key-value table plus the
typed Immich config the import pipeline and settings routes both need."""

import json
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.db.models import AppSetting, FileType

IMMICH_BASE_URL = "immich_base_url"
IMMICH_API_KEY = "immich_api_key"
IMMICH_SYNC_MODE = "immich_sync_mode"
# "1" while the user has paused automatic syncing (e.g. on a metered mobile
# connection): the background sync loop and the fire-and-forget upload queue
# stand down until resumed. Explicit manual "Add to Immich" pushes still work.
IMMICH_SYNC_PAUSED = "immich_sync_paused"
# "0" switches the whole Immich integration off without losing the stored
# server/key/mode: get_immich_config() then reports "not configured", which is
# the single gate every upload/sync/mirror path already checks. Unset counts
# as enabled so existing configured installations keep behaving as before.
IMMICH_ENABLED = "immich_enabled"
# "1" lets RAW files reach Immich too (default: JPEGs only). A RAW follows its
# paired JPEG: whenever the JPEG is synced, the RAW goes along; an unpaired RAW
# is treated like a JPEG. Switching this off later leaves already uploaded RAWs
# on Immich - it only stops new RAW uploads.
IMMICH_INCLUDE_RAW = "immich_include_raw"

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

# What the Import page does when photos are picked: "ask" each time whether to
# copy them into the library or leave them where they are, or always do one of
# the two. Unset counts as "ask". The client sends the chosen mode with the
# first staging request; the backend never reads this key for itself.
IMPORT_MODE_DEFAULT = "import_mode_default"
IMPORT_MODE_DEFAULTS = ("ask", "copy", "reference")
# What the review does with a session after "Add to library": "ask" each time
# whether it stays open, or always "keep" it open / always "close" it. Unset
# counts as "ask". Like the mode default, only the client reads it.
IMPORT_AFTER_COMMIT = "import_after_commit"
IMPORT_AFTER_COMMIT_CHOICES = ("ask", "keep", "close")
# Whether photos arriving in an import review start out selected for import
# ("select") or not ("deselect", the default - the review is where the keepers
# are picked). Read by the backend when it stages a file, so a choice made
# while more photos are still loading is never overwritten.
IMPORT_SELECT_DEFAULT = "import_select_default"
IMPORT_SELECT_DEFAULT_CHOICES = ("select", "deselect")
# Whether a copy session keeps its collection folder as a backup ("keep") or
# deletes it when the session closes ("delete", the default). Like the mode
# default, only the client reads it: it pre-selects the start dialog and is
# the answer when the dialog is skipped.
IMPORT_BACKUP_DEFAULT = "import_backup_default"
IMPORT_BACKUP_DEFAULT_CHOICES = ("keep", "delete")

# Whether an import takes over what another program wrote into a photo's XMP /
# IPTC blocks or an .xmp sidecar beside it: stars, colour label, keywords,
# caption. On unless switched off ("0") - a library that comes from Lightroom
# or digiKam should arrive with what the photographer gave it.
IMPORT_READ_FILE_METADATA = "import_read_file_metadata"

# Whether the library keeps an .xmp sidecar beside each managed original with
# the photo's stars, label, tags and note, so every other program reads them.
# Off unless switched on ("1"): it writes files into the library folder, and
# that is the user's call. See services/sidecar.py.
SIDECAR_WRITE = "sidecar_write"

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

# Which smart-album sections the Albums page shows, as a comma-separated
# subset of SMART_ALBUM_SECTION_NAMES. Unset = the defaults below; an empty
# string means the user switched every section off.
SMART_ALBUM_SECTIONS = "smart_album_sections"
SMART_ALBUM_SECTION_NAMES = (
    "moments",       # CLIP similarity clusters
    "tags",          # one album per tag the user gave their photos
    "places",        # GPS clusters within the radius below
    "countries",     # one album per country
    "country_years", # one album per country and year ("Italy 2024")
    "days",          # "big days" with unusually many photos
    "years",
    "months",
    "edits",         # everything edited in place plus saved edit copies
)
DEFAULT_SMART_ALBUM_SECTIONS = (
    "moments", "tags", "places", "countries", "days", "years", "months", "edits"
)
# How far (km) a photo may sit from a place's center and still belong to it.
SMART_ALBUM_PLACE_RADIUS_KM = "smart_album_place_radius_km"
DEFAULT_SMART_ALBUM_PLACE_RADIUS_KM = 5.0

# The export dialog's saved presets and the options it was last used with, as
# one JSON object: {"presets": [{"name", "options"}], "last": options | null}.
# The shape of `options` is schemas.ExportOptions; the routes validate it.
EXPORT_SETTINGS = "export_settings"


@dataclass(frozen=True)
class ImmichConfig:
    base_url: str
    api_key: str
    sync_mode: str = DEFAULT_IMMICH_SYNC_MODE
    include_raw: bool = False

    @property
    def album_sync(self) -> bool:
        """Both selective and full modes mirror app albums into Immich albums."""
        return self.sync_mode in (IMMICH_MODE_SELECTIVE, IMMICH_MODE_FULL)

    @property
    def file_types(self) -> tuple[FileType, ...]:
        """Which file types may be uploaded to Immich at all. The single place
        that knows the rule - every upload/sync/progress path checks
        ``image.file_type in config.file_types``."""
        return (FileType.jpeg, FileType.raw) if self.include_raw else (FileType.jpeg,)


@dataclass(frozen=True)
class SmartAlbumConfig:
    sections: tuple[str, ...]
    place_radius_km: float


def get_smart_album_config(db: Session) -> SmartAlbumConfig:
    raw = get_setting(db, SMART_ALBUM_SECTIONS)
    if raw is None:
        sections = DEFAULT_SMART_ALBUM_SECTIONS
    else:
        sections = tuple(s for s in raw.split(",") if s in SMART_ALBUM_SECTION_NAMES)
    raw_radius = get_setting(db, SMART_ALBUM_PLACE_RADIUS_KM)
    try:
        radius = float(raw_radius) if raw_radius else DEFAULT_SMART_ALBUM_PLACE_RADIUS_KM
    except ValueError:
        radius = DEFAULT_SMART_ALBUM_PLACE_RADIUS_KM
    # Clamped so a typo can't make every photo one giant "place" (or none).
    return SmartAlbumConfig(sections=sections, place_radius_km=max(1.0, min(500.0, radius)))


def get_setting(db: Session, key: str) -> str | None:
    row = db.get(AppSetting, key)
    return row.value if row else None


def set_setting(db: Session, key: str, value: str) -> None:
    row = db.get(AppSetting, key)
    if row is None:
        db.add(AppSetting(key=key, value=value))
    else:
        row.value = value


# The Selects tray: the ids of the photos gathered there, in the order they
# were added, as a JSON list. In the library's own database, so the tray
# survives a restart and belongs to this library - a different library folder
# has its own.
SELECTS = "selects"


def get_selects(db: Session) -> list[str]:
    """The stored Selects ids, in order, each once. Anything unreadable counts
    as an empty tray. Not checked against the photos - see routes/selects.py."""
    raw = get_setting(db, SELECTS)
    try:
        data = json.loads(raw) if raw else []
    except ValueError:
        data = []
    if not isinstance(data, list):
        return []
    return list(dict.fromkeys(x for x in data if isinstance(x, str)))


def set_selects(db: Session, ids: list[str]) -> None:
    set_setting(db, SELECTS, json.dumps(list(dict.fromkeys(ids))))


def get_export_settings(db: Session) -> dict:
    """The stored export presets and last-used options. Anything unreadable
    counts as nothing stored - a preset list is never worth failing over."""
    raw = get_setting(db, EXPORT_SETTINGS)
    try:
        data = json.loads(raw) if raw else {}
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    presets = data.get("presets")
    return {
        "presets": presets if isinstance(presets, list) else [],
        "last": data.get("last") if isinstance(data.get("last"), dict) else None,
    }


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


def get_import_mode_default(db: Session) -> str:
    value = get_setting(db, IMPORT_MODE_DEFAULT)
    return value if value in IMPORT_MODE_DEFAULTS else "ask"


def get_import_after_commit(db: Session) -> str:
    value = get_setting(db, IMPORT_AFTER_COMMIT)
    return value if value in IMPORT_AFTER_COMMIT_CHOICES else "ask"


def get_import_select_default(db: Session) -> str:
    value = get_setting(db, IMPORT_SELECT_DEFAULT)
    return value if value in IMPORT_SELECT_DEFAULT_CHOICES else "deselect"


def get_import_backup_default(db: Session) -> str:
    value = get_setting(db, IMPORT_BACKUP_DEFAULT)
    return value if value in IMPORT_BACKUP_DEFAULT_CHOICES else "delete"


def get_import_read_file_metadata(db: Session) -> bool:
    return get_setting(db, IMPORT_READ_FILE_METADATA) != "0"


def get_sidecar_write(db: Session) -> bool:
    return get_setting(db, SIDECAR_WRITE) == "1"


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


def get_immich_enabled(db: Session) -> bool:
    """The master switch of the Immich integration (Settings). Defaults to
    enabled so installations configured before the switch existed keep
    syncing."""
    return get_setting(db, IMMICH_ENABLED) != "0"


def get_immich_include_raw(db: Session) -> bool:
    return get_setting(db, IMMICH_INCLUDE_RAW) == "1"


def get_immich_config(db: Session) -> ImmichConfig | None:
    """Both a URL and a key must be present for uploads to be attempted -
    a half-configured integration is treated as "not configured", and so is a
    deliberately disabled one (the master switch above)."""
    if not get_immich_enabled(db):
        return None
    base_url = (get_setting(db, IMMICH_BASE_URL) or "").strip()
    api_key = (get_setting(db, IMMICH_API_KEY) or "").strip()
    if not base_url or not api_key:
        return None
    return ImmichConfig(
        base_url=base_url,
        api_key=api_key,
        sync_mode=get_immich_sync_mode(db),
        include_raw=get_immich_include_raw(db),
    )

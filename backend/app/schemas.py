from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.db.models import ColorLabel, FileType, ImportSessionStatus


class ImageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    original_filename: str
    file_type: FileType
    raw_format: str | None
    width: int | None
    height: int | None
    taken_at: datetime | None
    imported_at: datetime
    # Set while the photo sits in the in-app Trash (managed photos only).
    deleted_at: datetime | None
    camera_make: str | None
    camera_model: str | None
    iso: int | None
    aperture: float | None
    shutter_speed: str | None
    focal_length: float | None
    gps_lat: float | None
    gps_lon: float | None
    gps_country: str | None = None
    rating: int
    color_label: ColorLabel
    # Flagged for selective Immich sync (see settings_store sync modes).
    immich_sync: bool = False
    paired_image_id: str | None
    # Set when this photo was indexed in place from an external source root
    # (e.g. a NAS) rather than imported into the managed library.
    source_root_id: str | None
    edit_rotation: int
    edit_crop_x: float | None
    edit_crop_y: float | None
    edit_crop_width: float | None
    edit_crop_height: float | None
    edit_flip_h: bool = False
    edit_flip_v: bool = False
    edit_straighten: float = 0.0
    edit_persp_h: int = 0
    edit_persp_v: int = 0
    edit_distortion: int = 0
    # The full develop state as a JSON string (see services/develop.py), or null
    # when neutral; parsed client-side. Supersedes the flat edit_* tonal columns.
    edit_adjustments: str | None = None
    # Per-image cache-buster; String(edit_rev) is the thumbnail URL's ?v=.
    edit_rev: int = 0
    tags: list[str]
    album_ids: list[str]


# The develop adjustments (exposure/contrast/colour/effects/curves/grading/masks)
# are no longer a flat pydantic model - they travel as a single JSON `adjustments`
# object on ImageEdits, validated and clamped server-side by services/develop.py.




class ImageUpdate(BaseModel):
    rating: int | None = None
    color_label: ColorLabel | None = None
    # When set, the same rating/color is also written to this image's RAW+JPEG
    # partner - so rating the JPEG rates the RAW too.
    apply_to_pair: bool = False


class AddTagRequest(BaseModel):
    name: str


class BulkTagRequest(BaseModel):
    image_ids: list[str]
    tag_names: list[str]


class BulkResetRequest(BaseModel):
    """Reset selected aspects of each photo back to its just-imported state.
    Each flag is opt-in so the caller (the grid's Reset menu) can reset any
    combination of metadata and edits. The three metadata flags default to True
    to preserve the original all-metadata behaviour of callers that only send
    ``image_ids``."""

    image_ids: list[str]
    rating: bool = True  # stars back to 0
    color_label: bool = True  # colour label back to none
    tags: bool = True  # remove every user tag
    develop: bool = False  # clear the develop sliders (edit_adjustments)
    geometry: bool = False  # clear crop / rotation / straighten / flip / perspective
    albums: bool = False  # remove from every album


class BulkDevelopRequest(BaseModel):
    """Apply one develop object (e.g. an editor preset) to every listed photo,
    in place. Geometry (crop/rotation/...) is left untouched - a preset is a
    look, not a composition."""

    image_ids: list[str]
    adjustments: dict[str, Any] = Field(default_factory=dict)


class BulkAutoDevelopRequest(BaseModel):
    image_ids: list[str]


class BulkAutoDevelopResult(BaseModel):
    """Outcome of a bulk auto-develop: the (possibly partially) updated rows,
    plus how many photos actually got a suggestion vs. were skipped for having
    no embedding yet or nothing similar to learn from."""

    images: list[ImageOut]
    applied: int
    skipped: int


class RotateRequest(BaseModel):
    degrees: int  # relative delta: +90 or -90


class CropBox(BaseModel):
    x: float
    y: float
    width: float
    height: float


class CropRequest(BaseModel):
    crop: CropBox | None  # null clears the crop


class ImageEdits(BaseModel):
    """The full non-destructive edit: geometry (rotation/crop/flip/straighten/
    perspective/distortion) plus the develop `adjustments` object (tone, colour,
    presence, details, effects, tone curves, colour grading and per-mask local
    adjustments - see services/develop.py). Used to save edits in place, render
    the live preview and bake an edited copy."""

    rotation: int = 0  # absolute, multiple of 90
    crop: CropBox | None = None
    flip_h: bool = False  # mirror left-right
    flip_v: bool = False  # mirror top-bottom
    straighten: float = 0.0  # fine level angle, clockwise degrees (-45..45)
    persp_h: int = 0  # keystone / axis tilt about the vertical axis, -100..100
    persp_v: int = 0  # keystone / axis tilt about the horizontal axis, -100..100
    distortion: int = 0  # lens distortion correction, geometric, -100..100
    # The develop state; arbitrary shape, validated/clamped by develop.normalize().
    adjustments: dict[str, Any] = Field(default_factory=dict)


class AutoAdjustOut(BaseModel):
    """A develop suggestion learned from the user's saved edits: the blended
    adjustments plus how many similar edited photos it was derived from."""

    adjustments: dict[str, Any]
    samples: int


class BulkImageUpdate(BaseModel):
    image_ids: list[str]
    rating: int | None = None
    color_label: ColorLabel | None = None
    # See ImageUpdate.apply_to_pair - fans each change out to RAW+JPEG partners.
    apply_to_pair: bool = False


class BulkDeleteRequest(BaseModel):
    image_ids: list[str]


class BulkDownloadRequest(BaseModel):
    image_ids: list[str]


class ImmichPushRequest(BaseModel):
    image_ids: list[str]


class ImmichSyncToggleRequest(BaseModel):
    image_ids: list[str]
    enabled: bool


class ImmichPushResult(BaseModel):
    uploaded: int
    duplicate: int
    skipped: int
    failed: int
    message: str


class AlbumCreate(BaseModel):
    name: str
    description: str | None = None


class AlbumUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class AlbumOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    description: str | None
    created_at: datetime
    image_count: int = 0
    # Mirror this album to Immich (selective sync).
    immich_sync: bool = False


class AlbumAddImages(BaseModel):
    image_ids: list[str]


class AlbumImmichSyncRequest(BaseModel):
    enabled: bool


class ImportSessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    source_path: str
    status: ImportSessionStatus
    created_at: datetime


class StagedFileOut(BaseModel):
    id: str
    original_filename: str
    file_type: FileType
    selected: bool
    rating: int
    color_label: ColorLabel
    duplicate_of_image_id: str | None
    duplicate_of_staged_file_id: str | None
    is_near_duplicate: bool
    # The exact duplicate this file matches is a managed photo sitting in the
    # Trash: importing it is allowed and restores that photo (so the review UI
    # says "restores from Trash" instead of "already in library").
    duplicate_in_trash: bool = False
    paired_staged_file_id: str | None
    taken_at: datetime | None
    camera_make: str | None
    camera_model: str | None
    width: int | None
    height: int | None
    # Flagged for selective Immich sync during import review.
    immich_sync: bool = False
    # False while the background analysis (thumbnail/EXIF/duplicates) for this
    # file is still running - the review grid shows a placeholder card until
    # it flips, and commit is refused while any file is unprocessed.
    processed: bool = True


class StagedFileUpdate(BaseModel):
    selected: bool | None = None
    rating: int | None = None
    color_label: ColorLabel | None = None
    immich_sync: bool | None = None


class StagedFilesBulkUpdate(BaseModel):
    """One patch applied to many staged files in a single request/transaction -
    "Select all" on a big import used to fire one PATCH per file, which took
    seconds of pure HTTP/commit overhead."""

    file_ids: list[str]
    selected: bool | None = None
    rating: int | None = None
    color_label: ColorLabel | None = None
    immich_sync: bool | None = None


class FolderScanRequest(BaseModel):
    path: str


class ScannedFileOut(BaseModel):
    path: str
    name: str
    size: int


class FolderScanOut(BaseModel):
    """Importable files found under a local folder - the desktop app's direct
    (no-HTTP-upload) import path scans first, then stages in path batches."""

    files: list[ScannedFileOut]
    total_bytes: int


class StagePathsRequest(BaseModel):
    """One batch of a direct folder import: absolute paths of local files the
    backend reads itself. Mirrors the multipart upload's batching contract -
    the first call (no session_id) creates the session, follow-ups append.
    `total_bytes` is the whole planned import, for the disk-space preflight."""

    paths: list[str]
    source_label: str = "Local folder"
    session_id: str | None = None
    total_bytes: int = 0


class CommitImportRequest(BaseModel):
    # Also push the selected JPEGs (never RAWs) to Immich after import.
    upload_to_immich: bool = False
    # Selective sync: flag *every* imported photo for Immich sync (the
    # action-bar checkbox); individual photos can instead be flagged one by
    # one during review (StagedFileUpdate.immich_sync).
    sync_all_to_immich: bool = False


class ImportProgressOut(BaseModel):
    # "staging" | "commit" | "idle"
    phase: str
    # Staging phase: files whose background analysis finished, out of `total`
    # staged so far. Commit phase: photos moved/recorded, out of the plan.
    processed: int
    total: int
    # Staging phase only: files whose bytes are fully copied into the staging
    # folder - runs ahead of `processed` while analysis catches up.
    copied: int = 0
    # Rolling estimate of seconds remaining in this phase; null until known.
    eta_seconds: float | None = None


class ImmichSettingsOut(BaseModel):
    base_url: str | None
    # The stored API key itself is never returned - only whether one is set.
    api_key_set: bool
    # "manual" | "selective" | "full" - see settings_store.IMMICH_MODES.
    sync_mode: str


class ImmichSettingsUpdate(BaseModel):
    base_url: str
    # Omit / send null to keep the existing key when only changing the URL.
    api_key: str | None = None
    sync_mode: str | None = None


class RawDecodeSettingsOut(BaseModel):
    # True = load RAWs with no brightness processing (native sensor exposure).
    native_decode: bool


class RawDecodeSettingsUpdate(BaseModel):
    native_decode: bool


class TrashSettingsOut(BaseModel):
    # Days a photo stays in the Trash before the startup purge deletes it for
    # good; 0 = keep forever.
    retention_days: int


class TrashSettingsUpdate(BaseModel):
    retention_days: int


class AutoDevelopSettingsOut(BaseModel):
    enabled: bool
    # Which adjustment groups the Auto suggestion may touch (subset of
    # settings_store.AUTO_DEVELOP_GROUP_NAMES); unchecked groups keep their
    # current slider values when Auto runs.
    enabled_groups: list[str]
    # How many edited photos the suggestion can currently learn from - shown in
    # Settings so "more edits = better suggestions" is concrete, not abstract.
    example_count: int


class AutoDevelopSettingsUpdate(BaseModel):
    enabled: bool
    # None leaves the stored group selection untouched (the on/off toggle
    # doesn't need to know it); a list replaces it.
    enabled_groups: list[str] | None = None


class ImmichTestResult(BaseModel):
    ok: bool
    message: str


class ImmichUploadResult(BaseModel):
    filename: str
    ok: bool
    detail: str
    at: str


class SourceRootCreate(BaseModel):
    name: str
    path: str


class SourceRootOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    path: str
    created_at: datetime
    last_scanned_at: datetime | None
    image_count: int = 0
    scanning: bool = False
    # False when the source folder isn't currently reachable (external drive
    # unplugged / NAS unmounted). Its photos are hidden from the library while
    # unavailable, but the index is kept so they return when it reconnects.
    available: bool = True


class ScanStatusOut(BaseModel):
    running: bool
    scanned: int
    added: int
    error: str | None = None


class DirEntry(BaseModel):
    name: str
    path: str


class DirListing(BaseModel):
    path: str
    parent: str | None
    exists: bool
    entries: list[DirEntry]


class SearchResultOut(BaseModel):
    image: ImageOut
    distance: float


class Facet(BaseModel):
    """One filter-dropdown option and how many photos carry it."""

    value: str
    count: int


class LibraryFacets(BaseModel):
    cameras: list[Facet]
    regions: list[Facet]
    # Photos with no GPS at all - offered as an explicit "no location" bucket.
    no_location_count: int


class ImageCountOut(BaseModel):
    """Total photos matching a filter set - sizes the library's scrollbar."""

    count: int


# The /images/index response is hand-serialized for speed (see the route) -
# its per-photo shape is documented by LibraryIndexImage in the frontend types.


class SyncResult(BaseModel):
    removed_missing_files: int
    untracked_files_found: int
    orphan_thumbnails_removed: int
    thumbnails_queued: int


class RebuildThumbnailsResult(BaseModel):
    rebuilt: int


class ImmichActivityOut(BaseModel):
    """Live Immich upload activity: queued + in-flight uploads, plus the sync
    mode so the desktop quit-warning can phrase what quitting would mean.
    synced/total drive the Settings progress display: how many of the photos
    the current mode wants on Immich are known to be there already."""

    pending_uploads: int
    sync_mode: str
    synced: int
    total: int
    paused: bool


class ImmichPauseUpdate(BaseModel):
    paused: bool


class RepairDatesResult(BaseModel):
    """Outcome of the capture-date repair: photos checked on disk, rows whose
    taken_at actually changed."""

    checked: int
    fixed: int


class DangerZoneRequest(BaseModel):
    confirmation: str


class RestoreResult(BaseModel):
    images_restored: int
    albums_restored: int


class TagUsage(BaseModel):
    name: str
    count: int


class PruneTagsResult(BaseModel):
    removed: list[str]

from datetime import datetime

from pydantic import BaseModel, ConfigDict

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
    edit_exposure: int
    edit_contrast: int
    edit_highlights: int
    edit_shadows: int
    edit_whites: int
    edit_blacks: int
    edit_saturation: int
    edit_temperature: int
    edit_tint: int
    edit_color_mix: str | None
    edit_vignette: int
    edit_distortion: int
    edit_dehaze: int
    edit_grain: int
    edit_grain_size: int
    edit_denoise: int
    edit_clarity: int
    edit_sharpness: int
    edit_color_tint: int
    edit_chrome_effect: int
    edit_chrome_blue: int
    edit_mist: int
    tags: list[str]
    album_ids: list[str]


class ImageAdjustments(BaseModel):
    """Non-destructive tonal/color slider edits, each -100..100 (0 = neutral)."""

    exposure: int = 0
    contrast: int = 0
    highlights: int = 0
    shadows: int = 0
    whites: int = 0
    blacks: int = 0
    dehaze: int = 0
    saturation: int = 0
    temperature: int = 0
    tint: int = 0




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
    image_ids: list[str]


class RotateRequest(BaseModel):
    degrees: int  # relative delta: +90 or -90


class CropBox(BaseModel):
    x: float
    y: float
    width: float
    height: float


class CropRequest(BaseModel):
    crop: CropBox | None  # null clears the crop


class ImageEdits(ImageAdjustments):
    """The full non-destructive edit: geometry (rotation + crop), the tonal
    sliders, a per-hue colour mixer and a vignette. Used both to save edits in
    place and to bake an edited copy."""

    rotation: int = 0  # absolute, multiple of 90
    crop: CropBox | None = None
    flip_h: bool = False  # mirror left-right
    flip_v: bool = False  # mirror top-bottom
    straighten: float = 0.0  # fine level angle, clockwise degrees (-45..45)
    persp_h: int = 0  # keystone / axis tilt about the vertical axis, -100..100
    persp_v: int = 0  # keystone / axis tilt about the horizontal axis, -100..100
    # {band: [hue, sat, lum]} each -100..100; band in red/orange/.../magenta.
    color_mix: dict[str, list[int]] | None = None
    vignette: int = 0
    distortion: int = 0  # lens distortion correction, geometric
    grain: int = 0  # film grain amount, 0..100
    grain_size: int = 0  # film grain coarseness, 0..100
    denoise: int = 0  # noise reduction, 0..100
    clarity: int = 0  # midtone local contrast, -100..100
    sharpness: int = 0  # edge sharpening / softening, -100..100
    color_tint: int = 0  # global hue rotation, -100..100 -> +/-180 deg
    chrome_effect: int = 0  # Fuji Color Chrome Effect: deepen saturated colours, 0..100
    chrome_blue: int = 0  # Fuji Color Chrome FX Blue: deepen blues, 0..100
    mist: int = 0  # Pro-Mist diffusion: highlight bloom/halation, 0..100


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
    paired_staged_file_id: str | None
    taken_at: datetime | None
    camera_make: str | None
    camera_model: str | None
    width: int | None
    height: int | None
    # Flagged for selective Immich sync during import review.
    immich_sync: bool = False


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
    processed: int
    total: int
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


class TrashSettingsOut(BaseModel):
    # Days a photo stays in the Trash before the startup purge deletes it for
    # good; 0 = keep forever.
    retention_days: int


class TrashSettingsUpdate(BaseModel):
    retention_days: int


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


class SyncResult(BaseModel):
    removed_missing_files: int
    untracked_files_found: int
    orphan_thumbnails_removed: int
    thumbnails_queued: int


class RebuildThumbnailsResult(BaseModel):
    rebuilt: int


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

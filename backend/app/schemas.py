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
    camera_make: str | None
    camera_model: str | None
    iso: int | None
    aperture: float | None
    shutter_speed: str | None
    focal_length: float | None
    gps_lat: float | None
    gps_lon: float | None
    rating: int
    color_label: ColorLabel
    paired_image_id: str | None
    # Set when this photo was indexed in place from an external source root
    # (e.g. a NAS) rather than imported into the managed library.
    source_root_id: str | None
    edit_rotation: int
    edit_crop_x: float | None
    edit_crop_y: float | None
    edit_crop_width: float | None
    edit_crop_height: float | None
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


class AlbumAddImages(BaseModel):
    image_ids: list[str]


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


class StagedFileUpdate(BaseModel):
    selected: bool | None = None
    rating: int | None = None
    color_label: ColorLabel | None = None


class CommitImportRequest(BaseModel):
    # Also push the selected JPEGs (never RAWs) to Immich after import.
    upload_to_immich: bool = False


class ImmichSettingsOut(BaseModel):
    base_url: str | None
    # The stored API key itself is never returned - only whether one is set.
    api_key_set: bool


class ImmichSettingsUpdate(BaseModel):
    base_url: str
    # Omit / send null to keep the existing key when only changing the URL.
    api_key: str | None = None


class ImmichTestResult(BaseModel):
    ok: bool
    message: str


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


class SyncResult(BaseModel):
    removed_missing_files: int
    untracked_files_found: int


class RebuildThumbnailsResult(BaseModel):
    rebuilt: int


class DangerZoneRequest(BaseModel):
    confirmation: str


class RestoreResult(BaseModel):
    images_restored: int
    albums_restored: int

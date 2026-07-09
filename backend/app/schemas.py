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
    edit_rotation: int
    edit_crop_x: float | None
    edit_crop_y: float | None
    edit_crop_width: float | None
    edit_crop_height: float | None
    tags: list[str]
    album_ids: list[str]


class ImageUpdate(BaseModel):
    rating: int | None = None
    color_label: ColorLabel | None = None


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


class BulkImageUpdate(BaseModel):
    image_ids: list[str]
    rating: int | None = None
    color_label: ColorLabel | None = None


class BulkDeleteRequest(BaseModel):
    image_ids: list[str]


class BulkDownloadRequest(BaseModel):
    image_ids: list[str]


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

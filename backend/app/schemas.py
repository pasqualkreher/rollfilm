from datetime import datetime
from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

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
    lens_model: str | None = None
    iso: int | None
    aperture: float | None
    shutter_speed: str | None
    focal_length: float | None
    gps_lat: float | None
    gps_lon: float | None
    gps_country: str | None = None
    rating: int
    color_label: ColorLabel
    # Free-text note typed in the detail view; null when there's none.
    description: str | None = None
    # Flagged for selective Immich sync (see settings_store sync modes).
    immich_sync: bool = False
    # Read from Image.visible_paired_image_id, which hides a partner that is on
    # the other side of the Trash - a pair only counts as a pair while both
    # halves are in the same place. The plain column is the fallback so this
    # still validates from a mapping.
    paired_image_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("visible_paired_image_id", "paired_image_id"),
    )
    # Set when this photo was indexed in place from an external source root
    # (e.g. a NAS) rather than imported into the managed library.
    source_root_id: str | None
    # Set when this row is a virtual copy ("virtual copy") of another photo:
    # same file on disk, its own develop state. See /images/{id}/virtual-copy.
    virtual_of_image_id: str | None = None
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
    # Free-text note. "" clears it; omitted (null) leaves it alone.
    description: str | None = None
    # When set, the same rating/color is also written to this image's RAW+JPEG
    # partner - so rating the JPEG rates the RAW too.
    apply_to_pair: bool = False


class ImageRenameRequest(BaseModel):
    # The new name. With an extension it must match the file's current one (the
    # extension is what makes a RAF a RAF); without one the current extension is
    # kept. Path separators are rejected - a rename is not a move.
    name: str
    # Rename this photo's RAW/JPEG partner to the same stem, keeping its own
    # extension - so the two halves of one shot stay named alike on disk.
    rename_pair: bool = True


class ImageRenameResult(BaseModel):
    image: ImageOut
    # The partner's new name when it was renamed too, else null.
    paired_filename: str | None = None
    # Set when the partner was meant to be renamed but couldn't be (its own
    # target name is taken, or its file is unreachable) - the UI says so
    # instead of silently leaving the pair half-renamed.
    pair_error: str | None = None


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


class SegmentRequest(ImageEdits):
    """A segmentation ask: which subject to find, plus the geometry it should be
    found in. Inherits the edit payload because the mask must come back in the
    *framed* image's coordinates - the same space every other mask lives in - so
    the server has to know the crop/rotation the editor is currently showing.
    The tonal part of the payload is ignored (see
    thumbnails.render_framed_base_image)."""

    subject: str = "sky"


class SegmentOut(BaseModel):
    """The found region as a base64 8-bit grayscale PNG (soft, 0..255 = how
    strongly the pixel belongs to the subject).

    `found` is the answer to "is this subject in the photo at all", and it comes
    from `peak` - the model's strongest evidence anywhere in the frame - NOT
    from `coverage`. Five people at the far end of a room are unmistakably
    people and cover a tenth of a percent of the frame; judging by area would
    throw exactly the masks away that are most tedious to draw by hand."""

    subject: str
    mask: str
    width: int
    height: int
    coverage: float  # 0..1, the mean of the returned field
    peak: float  # 0..1, the model's peak confidence before the field was scaled
    found: bool


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


class ExportRequest(BaseModel):
    image_ids: list[str]
    # JPEG quality 1-100 and an optional long-edge pixel cap (None = original
    # size). Shared by the single-photo and selection export dialogs.
    quality: int = 90
    max_size: int | None = None


class ExportStartRequest(ExportRequest):
    # "jpeg" renders the saved edits into fresh JPEGs; "original" hands out the
    # library files byte-for-byte (RAW stays RAW, metadata untouched).
    format: Literal["jpeg", "original"] = "jpeg"


class ExportStartResponse(BaseModel):
    job_id: str
    total: int


class ExportJobProgress(BaseModel):
    done: int
    total: int
    state: Literal["running", "ready", "error", "cancelled"]
    # Set once ready: the download filename (drives the save dialog's
    # suggestion before the result request is made).
    filename: str | None = None
    error: str | None = None


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
    # Tag rule: photos carrying ANY of these tags are members automatically.
    tag_filter: list[str] = []


class AlbumUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    # None = leave unchanged; [] = clear the rule (back to a manual album).
    tag_filter: list[str] | None = None


class AlbumOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    description: str | None
    created_at: datetime
    image_count: int = 0
    # Up to 4 member ids (album order) for the card's mini mosaic preview.
    cover_image_ids: list[str] = []
    # Mirror this album to Immich (selective sync).
    immich_sync: bool = False
    # Tag rule: photos with any of these tags are members automatically.
    tag_filter: list[str] = []


class LayoutItemIn(BaseModel):
    """One placed item as the canvas sends it back. Ids are minted by the
    client (a UUID per new item), so a save is a plain replace: whatever the
    canvas holds is what the layout is."""

    id: str
    kind: Literal["photo", "text"] = "photo"
    image_id: str | None = None
    # A frame whose photo was permanently deleted: it stays on the page as a
    # placeholder. Round-trips through saves so autosave never erases the gap.
    missing: bool = False
    page: int = 0
    x_mm: float = 0.0
    y_mm: float = 0.0
    width_mm: float = 60.0
    height_mm: float = 40.0
    rotation: float = 0.0
    z: int = 0
    content_scale: float = 1.0
    content_dx: float = 0.0
    content_dy: float = 0.0
    text: str | None = None
    style: dict[str, Any] | None = None


class LayoutItemOut(LayoutItemIn):
    # False when the photo behind a frame is currently in the Trash or gone
    # from an unplugged source: the canvas keeps the item (and sends it back
    # untouched) but has nothing to draw, exactly like album membership
    # surviving a trip through the Trash.
    available: bool = True


class CanvasLayoutIn(BaseModel):
    page_mode: Literal["pages", "infinite"] = "pages"
    page_width_mm: float = 297.0
    page_height_mm: float = 210.0
    page_count: int = 1
    background: str = "#ffffff"
    show_grid: bool = False
    grid_mm: float = 10.0
    snap: bool = True
    # Page margin (guide, snap target, auto-layout inset), in mm.
    margin_mm: float = 12.0
    show_page_guide: bool = False
    # Whether this canvas appears on the Canvases shelf of the Albums page.
    show_in_canvases: bool = False
    items: list[LayoutItemIn] = []


class LayoutVersionOut(BaseModel):
    """One kept snapshot of a canvas, as the version list shows it. The
    document itself stays on the server - it only travels when restored."""

    id: str
    name: str
    created_at: datetime


class LayoutVersionIn(BaseModel):
    name: str = ""


class CanvasShelfIn(BaseModel):
    enabled: bool


class CanvasLayoutOut(BaseModel):
    canvas_id: str
    page_mode: Literal["pages", "infinite"]
    page_width_mm: float
    page_height_mm: float
    page_count: int
    background: str
    show_grid: bool
    grid_mm: float
    snap: bool
    margin_mm: float = 12.0
    show_page_guide: bool = False
    show_in_canvases: bool = False
    # The version the Canvases shelf shows (last kept or last loaded), and the
    # kept versions themselves, newest first.
    active_version_id: str | None = None
    versions: list[LayoutVersionOut] = []
    updated_at: datetime | None = None
    items: list[LayoutItemOut] = []


class CanvasPreviewOut(BaseModel):
    """Just enough of a canvas's working layout to draw the overview card's
    paper preview - same shape the shelf's gallery cards use, minus the
    version bookkeeping. None until the canvas has been saved once."""

    page_mode: Literal["pages", "infinite"]
    page_width_mm: float
    page_height_mm: float
    page_count: int
    background: str
    show_page_guide: bool = False
    items: list[LayoutItemOut] = []
    # Per-photo cache-buster for thumbnail URLs (image id -> ?v value).
    thumb_versions: dict[str, str] = {}


class CanvasSummaryOut(BaseModel):
    """One canvas in the overview: name, size, when it last changed - and the
    working layout itself, so the overview can show the design, not a label."""

    id: str
    name: str
    created_at: datetime
    updated_at: datetime | None = None
    image_count: int = 0
    item_count: int = 0
    show_in_canvases: bool = False
    preview: CanvasPreviewOut | None = None


class CanvasCreateIn(BaseModel):
    name: str = "Canvas"


class CanvasRenameIn(BaseModel):
    name: str


class CanvasImagesIn(BaseModel):
    image_ids: list[str]


class CanvasGalleryOut(BaseModel):
    """One card on the Canvases shelf: a canvas's chosen version, with just
    enough of its document to draw the print-style preview."""

    canvas_id: str
    canvas_name: str
    version_id: str
    version_name: str
    version_count: int
    created_at: datetime
    page_mode: Literal["pages", "infinite"]
    page_width_mm: float
    page_height_mm: float
    page_count: int
    background: str
    # A free canvas with the page guide on prints as the guide's sheets - the
    # shelf's print view and export need to cut the same way.
    show_page_guide: bool = False
    items: list[LayoutItemOut] = []
    # Per-photo cache-buster for thumbnail URLs (image id -> ?v value), since
    # the shelf has no ImageOut rows to derive it from.
    thumb_versions: dict[str, str] = {}


class SmartAlbumOut(BaseModel):
    # "cluster:<index>" / "year:2024" / "month:2024-07" / "day:2024-07-12" /
    # "place:48.1374,11.5755" / "country:Italy" / "country-year:Italy:2024" -
    # virtual, so the id encodes what the album *is* instead of naming a row.
    id: str
    kind: Literal["cluster", "tag", "year", "month", "day", "place", "country", "country_year", "edits"]
    name: str
    image_count: int
    cover_image_id: str | None = None
    # Up to 4 member ids (newest first) for the card's mini mosaic preview.
    cover_image_ids: list[str] = []
    # Clusters only: the base label ("Mountains") shared by sibling moments
    # ("Mountains · Alpine", "Mountains · Mediterranean") so the UI can stack
    # them under one expandable group card.
    group: str | None = None


class SmartAlbumsOut(BaseModel):
    # "building" while the very first cluster pass runs, "refreshing" while
    # served clusters are stale and a rebuild runs (e.g. embeddings still
    # backfilling after an import); the frontend polls until "ready".
    clusters_status: Literal["building", "refreshing", "ready"]
    clusters: list[SmartAlbumOut]
    # One album per tag ("albums by tag") - the "tags" section.
    tags: list[SmartAlbumOut] = []
    places: list[SmartAlbumOut]
    countries: list[SmartAlbumOut]
    country_years: list[SmartAlbumOut]
    years: list[SmartAlbumOut]
    months: list[SmartAlbumOut]
    days: list[SmartAlbumOut]
    edits: list[SmartAlbumOut]


class SmartAlbumSettingsOut(BaseModel):
    # Enabled section keys (subset of settings_store.SMART_ALBUM_SECTION_NAMES).
    sections: list[str]
    place_radius_km: float


class SmartAlbumSettingsUpdate(BaseModel):
    sections: list[str] | None = None
    place_radius_km: float | None = None


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
    # RAW only: the background demosaiced grid thumbnail is ready - the review
    # grid busts its img URL on the flip, swapping the embedded-preview thumb
    # for the sensor-accurate render.
    has_demosaic_thumb: bool = False
    # False while the background analysis (thumbnail/EXIF/duplicates) for this
    # file is still running - the review grid shows a placeholder card until
    # it flips, and commit is refused while any file is unprocessed.
    processed: bool = True


class StagedFilesOut(BaseModel):
    """The review grid's file list, with the session's change counter. When
    the client polls with the version it already has and nothing changed, the
    response is just {version, unchanged: true} - no rows loaded, nothing
    serialized, nothing re-rendered."""

    version: int
    unchanged: bool = False
    files: list[StagedFileOut] = []


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
    # Bytes landed so far - the client computes copy rate/ETA from bytes so a
    # tail of big RAWs doesn't make a per-file estimate grow mid-import.
    copied_bytes: int = 0
    # Rolling estimate of seconds remaining in this phase; null until known.
    eta_seconds: float | None = None


class ImmichSettingsOut(BaseModel):
    base_url: str | None
    # The stored API key itself is never returned - only whether one is set.
    api_key_set: bool
    # "manual" | "selective" | "full" - see settings_store.IMMICH_MODES.
    sync_mode: str
    # Master switch: False turns the whole integration off (uploads, sync loop,
    # album mirroring, the import checkboxes) while keeping the config stored.
    enabled: bool


class ImmichSettingsUpdate(BaseModel):
    base_url: str
    # Omit / send null to keep the existing key when only changing the URL.
    api_key: str | None = None
    sync_mode: str | None = None
    # Omit / send null to leave the master switch unchanged.
    enabled: bool | None = None


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


class BorgSettingsOut(BaseModel):
    enabled: bool
    repo: str | None
    # The stored passphrase itself is never returned - only whether one is set.
    passphrase_set: bool
    # Whether the `borg` binary is installed on this machine; when false the UI
    # shows install instructions and backups are disabled.
    available: bool
    # Live status of the background/manual backup runner.
    running: bool
    last_ok: bool | None
    last_message: str
    last_archive: str | None
    last_finished_at: str | None


class BorgSettingsUpdate(BaseModel):
    enabled: bool
    repo: str
    # Omit / send null to keep the existing passphrase when only changing other
    # fields; an empty string clears it (unencrypted repo).
    passphrase: str | None = None


class BorgTestResult(BaseModel):
    ok: bool
    message: str


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
    # Lens names present in the library, and the distinct focal lengths (facet
    # values are the formatted mm numbers, e.g. "23" or "8.8").
    lenses: list[Facet]
    focal_lengths: list[Facet]
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


class RebuildProgressOut(BaseModel):
    # Live state of the (single) rebuild-all run: photos finished of total.
    active: bool
    total: int
    done: int


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


class BackgroundActivityOut(BaseModel):
    """Work that outlives the screen that started it. The desktop shell asks
    before quitting, so a library isn't left half-rendered or unsearchable."""

    # Thumbnails/previews still to render (only ever the ones an import
    # couldn't hand over ready-made).
    derivatives_pending: int
    # The CLIP search backfill is scan-based, so it has no queue length - just
    # whether it is working.
    embeddings_running: bool
    # A library merge copying photos in from another drive.
    merge_active: bool
    # Everything above resumes by itself on the next start, which is what makes
    # "quit now" a safe offer rather than a loss.
    resumes_next_run: bool = True


class LibraryMergeRequest(BaseModel):
    # Absolute path of the other library's folder - the one holding its year
    # folders and its .photomanager data dir.
    path: str


class LibraryMergeSummary(BaseModel):
    """What merging that library would do, shown before anything is copied."""

    library_root: str
    photos: int
    new_photos: int
    known_photos: int
    bytes_to_copy: int
    albums: int
    tags: int


class LibraryMergeResult(BaseModel):
    added: int
    updated: int
    skipped: int
    copied_bytes: int
    # Stopped by the user rather than run to the end. What had already come
    # across stays; running it again picks up where it left off.
    canceled: bool = False


class LibraryMergeProgressOut(BaseModel):
    """Live state of the background merge, polled by the import screen."""

    active: bool
    total: int
    done: int
    copied_bytes: int
    # None until enough photos have finished to measure a rate from.
    eta_seconds: float | None = None
    # Outcome of the last finished run - still here after leaving the screen.
    result: LibraryMergeResult | None = None
    error: str | None = None


class TagUsage(BaseModel):
    name: str
    count: int


class StatCount(BaseModel):
    """One labeled count in the stats dashboard (a camera, a year, a bucket)."""

    name: str
    count: int


class LibraryStats(BaseModel):
    """Aggregate snapshot for the statistics dashboard."""

    total_photos: int
    total_bytes: int
    raw_count: int
    jpeg_count: int
    pair_count: int
    edited_count: int
    with_gps_count: int
    rated_count: int
    camera_count: int
    lens_count: int
    cameras: list[StatCount]
    lenses: list[StatCount]
    focal_buckets: list[StatCount]
    years: list[StatCount]
    ratings: list[StatCount]
    first_taken_at: datetime | None = None
    last_taken_at: datetime | None = None


class PruneTagsResult(BaseModel):
    removed: list[str]

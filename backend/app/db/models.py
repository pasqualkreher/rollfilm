import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ColorLabel(str, enum.Enum):
    none = "none"
    red = "red"
    orange = "orange"
    yellow = "yellow"
    green = "green"
    blue = "blue"
    magenta = "magenta"
    gray = "gray"


class FileType(str, enum.Enum):
    jpeg = "jpeg"
    png = "png"
    raw = "raw"


class ImportSessionStatus(str, enum.Enum):
    staging = "staging"
    committed = "committed"
    discarded = "discarded"


class User(Base):
    """The single local user (id=1), seeded on first access. This is a
    single-user desktop app; the owner_id columns below all point at this row.
    See app/auth.py: get_current_user()."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class SourceRoot(Base):
    """A folder outside the managed library (e.g. a mounted NAS) that is scanned
    and indexed *in place* - the photos under it are added to the library but
    their files are never copied or moved. Multiple source roots can be
    registered. See app/services/sources.py."""

    __tablename__ = "source_roots"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), default=1, index=True)
    name: Mapped[str] = mapped_column(String)
    # Absolute path as seen *inside the backend* (i.e. the container mount point).
    path: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    last_scanned_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class Image(Base):
    __tablename__ = "images"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), default=1, index=True)

    # For managed (imported) photos this is relative to settings.library_root,
    # e.g. "2026/2026-07-08/IMG_0001.CR2". For photos indexed from an external
    # source root it is the absolute on-disk path (source_root_id is set); the
    # file stays where it is. Resolve either via services.filesystem.resolve_image_path.
    file_path: Mapped[str] = mapped_column(String, unique=True)
    # Null = managed library file; set = indexed in place from this source root.
    source_root_id: Mapped[str | None] = mapped_column(
        ForeignKey("source_roots.id"), nullable=True, index=True
    )
    original_filename: Mapped[str] = mapped_column(String)

    file_hash: Mapped[str] = mapped_column(String, index=True)
    perceptual_hash: Mapped[str | None] = mapped_column(String, index=True, nullable=True)

    file_type: Mapped[FileType] = mapped_column(Enum(FileType), index=True)
    raw_format: Mapped[str | None] = mapped_column(String, nullable=True)

    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    file_size: Mapped[int] = mapped_column(Integer)

    taken_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    # Set = the photo sits in the in-app Trash (soft-deleted): hidden from the
    # library but its file stays on disk until it's restored or permanently
    # deleted. Only managed photos are ever trashed - deleting a photo indexed
    # from a source root removes just the row (the external file is never ours
    # to delete).
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )

    camera_make: Mapped[str | None] = mapped_column(String, nullable=True)
    camera_model: Mapped[str | None] = mapped_column(String, nullable=True)
    iso: Mapped[int | None] = mapped_column(Integer, nullable=True)
    aperture: Mapped[float | None] = mapped_column(Float, nullable=True)
    shutter_speed: Mapped[str | None] = mapped_column(String, nullable=True)
    focal_length: Mapped[float | None] = mapped_column(Float, nullable=True)
    gps_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    gps_lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Country name reverse-geocoded from the GPS fix (offline), for the region
    # filter. Null when there's no GPS or it hasn't been resolved yet.
    gps_country: Mapped[str | None] = mapped_column(String, nullable=True, index=True)

    rating: Mapped[int] = mapped_column(Integer, default=0)
    color_label: Mapped[ColorLabel] = mapped_column(Enum(ColorLabel), default=ColorLabel.none)

    # Selective Immich sync: when set, this photo is synced to Immich (JPEG only)
    # automatically - on import and when the flag is toggled on. Ignored in the
    # "manual" and "full" sync modes (manual uses the per-import checkbox; full
    # syncs everything regardless of this flag). See services/settings_store.py.
    immich_sync: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", index=True)
    # Immich asset UUID, recorded whenever an upload succeeds (Immich also
    # returns it for checksum duplicates, so re-syncs backfill it). It's what
    # lets a permanent deletion here remove the matching asset over there.
    # Null = not known to be on Immich (never uploaded, or uploaded before this
    # column existed - removal then falls back to a SHA-1 lookup).
    immich_asset_id: Mapped[str | None] = mapped_column(String, nullable=True)

    # Self-referential RAW<->JPEG sibling pairing for the "combined" library
    # view (see services/pairing.py). Only set on one side or the other is
    # enough to reconstruct the pair; we set it symmetrically for simpler
    # querying from either row.
    paired_image_id: Mapped[str | None] = mapped_column(
        ForeignKey("images.id"), nullable=True
    )
    paired_image: Mapped["Image | None"] = relationship(
        "Image", remote_side="Image.id", foreign_keys=[paired_image_id]
    )

    # Non-destructive manual edits layered on top of the auto-oriented preview
    # (see services/raw.py) - the original file on disk is never touched.
    # edit_crop_* are fractions (0..1) of the rotated image; all null means
    # "no crop". Rotating resets any crop, since crop coordinates are only
    # meaningful relative to a specific rotation.
    edit_rotation: Mapped[int] = mapped_column(Integer, default=0)
    edit_crop_x: Mapped[float | None] = mapped_column(Float, nullable=True)
    edit_crop_y: Mapped[float | None] = mapped_column(Float, nullable=True)
    edit_crop_width: Mapped[float | None] = mapped_column(Float, nullable=True)
    edit_crop_height: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Mirror flips and a fine straighten angle (clockwise degrees), applied
    # before the manual crop (see thumbnails.apply_edits).
    edit_flip_h: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    edit_flip_v: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    edit_straighten: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    # Keystone / axis-tilt perspective correction, each -100..100 (0 = none).
    edit_persp_h: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    edit_persp_v: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # Non-destructive tonal/color slider edits, each -100..100 (0 = neutral).
    # Applied together with rotation/crop when derivatives are regenerated; the
    # original file on disk is never modified. See thumbnails.apply_adjustments.
    edit_exposure: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    edit_contrast: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    edit_highlights: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    edit_shadows: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    edit_whites: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    edit_blacks: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    edit_saturation: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    edit_temperature: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    edit_tint: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Per-hue HSL mixer as JSON ({band: [hue, sat, lum]}), null = neutral; and a
    # vignette amount (-100 darken .. +100 lighten corners).
    edit_color_mix: Mapped[str | None] = mapped_column(String, nullable=True)
    edit_vignette: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Lens distortion correction (-100 barrel .. +100 pincushion), geometric.
    edit_distortion: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Effects: dehaze (-100..100), film grain (0..100), denoise (0..100).
    edit_dehaze: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    edit_grain: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    edit_grain_size: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    edit_denoise: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Detail: clarity (-100..100 midtone local contrast) and sharpness (-100..100,
    # negative softens).
    edit_clarity: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    edit_sharpness: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Global colour-mixer tint: rotates all hues (-100..100 -> +/-180 deg).
    edit_color_tint: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Fujifilm-style Color Chrome Effect (0..100, deepens saturated colours) and
    # Color Chrome FX Blue (0..100, deepens blues specifically).
    edit_chrome_effect: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    edit_chrome_blue: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Pro-Mist-style diffusion (0..100): highlights bloom/halate softly.
    edit_mist: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # --- Develop adjustments v2 ------------------------------------------------
    # The whole non-geometry develop state - tone, colour, presence, details,
    # effects, tone curves, colour grading, colour calibration and per-mask local
    # adjustments - as one JSON object (see services/develop.py). This supersedes
    # the individual edit_* tonal/effect columns above, which are kept only so a
    # pre-v2 edit can still be recovered and are no longer read by the render
    # pipeline. Null when the develop state is fully neutral.
    edit_adjustments: Mapped[str | None] = mapped_column(String, nullable=True)
    # Per-image cache-buster, bumped on every edit save (edits/rotate/crop). The
    # thumbnail URL's ?v= is String(edit_rev); the server is the sole source of
    # truth for it, replacing the old recomputed per-field version string.
    edit_rev: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # For photos created via "save copy": the develop JSON that was baked into
    # this flattened JPEG. Never read by the render pipeline (the pixels already
    # contain the edit - re-applying would double it); it exists purely as
    # training data for the auto-develop suggestion (services/auto_develop.py),
    # so a saved copy teaches the feature just like an in-place edit does.
    applied_adjustments: Mapped[str | None] = mapped_column(String, nullable=True)

    albums: Mapped[list["AlbumImage"]] = relationship(back_populates="image", cascade="all, delete-orphan")
    tag_links: Mapped[list["ImageTag"]] = relationship(cascade="all, delete-orphan")

    @property
    def tags(self) -> list[str]:
        return sorted(link.tag.name for link in self.tag_links)

    @property
    def album_ids(self) -> list[str]:
        return [link.album_id for link in self.albums]


class Tag(Base):
    __tablename__ = "tags"
    __table_args__ = (UniqueConstraint("owner_id", "name"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), default=1, index=True)
    name: Mapped[str] = mapped_column(String, index=True)


class ImageTag(Base):
    __tablename__ = "image_tags"
    __table_args__ = (UniqueConstraint("image_id", "tag_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    image_id: Mapped[str] = mapped_column(ForeignKey("images.id"), index=True)
    tag_id: Mapped[str] = mapped_column(ForeignKey("tags.id"), index=True)

    tag: Mapped["Tag"] = relationship()


class Album(Base):
    __tablename__ = "albums"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), default=1, index=True)
    name: Mapped[str] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    # Reserved for future nested albums; MVP UI treats albums as a flat list.
    parent_album_id: Mapped[str | None] = mapped_column(ForeignKey("albums.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    # Selective Immich sync: when set, this album is mirrored to an Immich album
    # of the same name and its JPEG photos are uploaded and added to it.
    immich_sync: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")

    images: Mapped[list["AlbumImage"]] = relationship(back_populates="album", cascade="all, delete-orphan")


class AlbumImage(Base):
    __tablename__ = "album_images"
    __table_args__ = (UniqueConstraint("album_id", "image_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    album_id: Mapped[str] = mapped_column(ForeignKey("albums.id"), index=True)
    image_id: Mapped[str] = mapped_column(ForeignKey("images.id"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)

    album: Mapped["Album"] = relationship(back_populates="images")
    image: Mapped["Image"] = relationship(back_populates="albums")


class ImportSession(Base):
    __tablename__ = "import_sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), default=1, index=True)
    source_path: Mapped[str] = mapped_column(String)
    status: Mapped[ImportSessionStatus] = mapped_column(
        Enum(ImportSessionStatus), default=ImportSessionStatus.staging
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    staged_files: Mapped[list["ImportStagedFile"]] = relationship(
        back_populates="import_session", cascade="all, delete-orphan"
    )


class AppSetting(Base):
    """Simple key-value store for app-wide configuration the user sets from the
    Settings screen (e.g. Immich server URL + API key). Single-user app, so
    these are global rather than owner-scoped."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str] = mapped_column(String)


class ImportStagedFile(Base):
    __tablename__ = "import_staged_files"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    import_session_id: Mapped[str] = mapped_column(ForeignKey("import_sessions.id"), index=True)

    staged_path: Mapped[str] = mapped_column(String)
    original_filename: Mapped[str] = mapped_column(String)
    file_type: Mapped[FileType] = mapped_column(Enum(FileType))

    sha256: Mapped[str] = mapped_column(String, index=True)
    perceptual_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    exif_json: Mapped[str | None] = mapped_column(String, nullable=True)

    # False while the background analysis (preview/phash/EXIF/thumbnail +
    # duplicate detection) hasn't finished for this file yet. The copy phase
    # creates rows unprocessed and returns immediately; a background worker
    # fills in the analysis fields and flips this. Commit refuses to run while
    # any file in the session is unprocessed. server_default "1": rows staged
    # before this column existed were always fully analyzed at staging time.
    processed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="1")

    duplicate_of_image_id: Mapped[str | None] = mapped_column(ForeignKey("images.id"), nullable=True)
    # Duplicate of another file staged earlier in the *same* batch (e.g. an
    # SD card with two copies of a shot) - distinct from duplicate_of_image_id,
    # which flags a match against the already-committed library.
    duplicate_of_staged_file_id: Mapped[str | None] = mapped_column(
        ForeignKey("import_staged_files.id"), nullable=True
    )
    is_near_duplicate: Mapped[bool] = mapped_column(Boolean, default=False)

    selected: Mapped[bool] = mapped_column(Boolean, default=True)
    # Lets the user rate/color-tag during review and then filter the import
    # selection down by them, same as in the library - independent of the
    # rating/color_label the committed Image row ends up with.
    rating: Mapped[int] = mapped_column(Integer, default=0)
    color_label: Mapped[ColorLabel] = mapped_column(Enum(ColorLabel), default=ColorLabel.none)
    # Selective Immich sync: flag set during import review; transferred to the
    # committed Image row, which then uploads right after import (selective
    # mode only - see import_pipeline.commit_import_session).
    immich_sync: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")

    import_session: Mapped["ImportSession"] = relationship(back_populates="staged_files")


class ImmichPendingDeletion(Base):
    """A durable "remove this asset from Immich" to-do, written in the same
    transaction that permanently deletes a synced photo (see
    services/trash.hard_delete_images). Processed - and only then removed - by
    the background Immich sync loop (services/immich_sync.py), so a slow or
    unreachable Immich never blocks the deletion nor silently loses the
    removal."""

    __tablename__ = "immich_pending_deletions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    # The Immich asset UUID when the deleted photo had one recorded; otherwise
    # sha1_checksum (hex of the deleted file, Immich's checksum algorithm) is
    # set and resolved against the server at sync time.
    asset_id: Mapped[str | None] = mapped_column(String, nullable=True)
    sha1_checksum: Mapped[str | None] = mapped_column(String, nullable=True)
    # Only for logging/history - the photo row is gone by the time this runs.
    filename: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

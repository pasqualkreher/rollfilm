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
    """Single seeded row for now (id=1). See app/auth.py: get_current_user()
    always returns this row until real multi-user auth is added, at which
    point every owner_id-scoped query below already works unchanged."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class Image(Base):
    __tablename__ = "images"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), default=1, index=True)

    # Relative to settings.library_root, e.g. "2026/2026-07-08/IMG_0001.CR2".
    file_path: Mapped[str] = mapped_column(String, unique=True)
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

    camera_make: Mapped[str | None] = mapped_column(String, nullable=True)
    camera_model: Mapped[str | None] = mapped_column(String, nullable=True)
    iso: Mapped[int | None] = mapped_column(Integer, nullable=True)
    aperture: Mapped[float | None] = mapped_column(Float, nullable=True)
    shutter_speed: Mapped[str | None] = mapped_column(String, nullable=True)
    focal_length: Mapped[float | None] = mapped_column(Float, nullable=True)
    gps_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    gps_lon: Mapped[float | None] = mapped_column(Float, nullable=True)

    rating: Mapped[int] = mapped_column(Integer, default=0)
    color_label: Mapped[ColorLabel] = mapped_column(Enum(ColorLabel), default=ColorLabel.none)

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

    import_session: Mapped["ImportSession"] = relationship(back_populates="staged_files")

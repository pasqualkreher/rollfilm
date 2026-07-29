import json

from fastapi import APIRouter, Depends
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app import schemas
from app.api.deps import get_owned_album, get_owned_image
from app.auth import get_current_user
from app.db.models import Album, AlbumImage, FileType, Image, ImageTag, Tag, User
from app.db.session import get_db
from app.services.filesystem import resolve_image_path
from app.services.settings_store import IMMICH_MODE_FULL, ImmichConfig, get_immich_config
from app.workers.queue import (
    enqueue_immich_album_delete,
    enqueue_immich_album_remove_assets,
    enqueue_immich_album_rename,
    enqueue_immich_upload,
)

router = APIRouter(prefix="/albums", tags=["albums"])


def _mirrored(immich: ImmichConfig | None, album: Album) -> bool:
    """Whether this album is kept in sync with a same-named Immich album:
    every album in full mode, only flagged ones in selective mode."""
    return immich is not None and (
        immich.sync_mode == IMMICH_MODE_FULL or (immich.album_sync and album.immich_sync)
    )


def _clean_tag_filter(tags: list[str]) -> list[str]:
    """Normalize a tag rule: strip, drop empties, dedupe (order preserved)."""
    seen: set[str] = set()
    out: list[str] = []
    for tag in tags:
        t = tag.strip()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _tagged_image_ids(db: Session, owner_id: int, tag_names: list[str]):
    """Subquery of image ids carrying ANY of the given tags."""
    return (
        db.query(ImageTag.image_id)
        .join(Tag, Tag.id == ImageTag.tag_id)
        .filter(Tag.owner_id == owner_id, Tag.name.in_(tag_names))
    )


def _membership(db: Session, album: Album):
    """Filter criterion for an album's effective members: the manually added
    photos, plus - when the album carries a tag rule - every photo with any
    of those tags."""
    manual = db.query(AlbumImage.image_id).filter(AlbumImage.album_id == album.id)
    tags = album.tag_filter_list
    if tags:
        return or_(
            Image.id.in_(manual), Image.id.in_(_tagged_image_ids(db, album.owner_id, tags))
        )
    return Image.id.in_(manual)


def _member_images_query(db: Session, album: Album):
    """All live member photos of an album (manual + tag rule)."""
    return db.query(Image).filter(
        Image.owner_id == album.owner_id,
        Image.deleted_at.is_(None),
        _membership(db, album),
    )


def _enqueue_member_uploads(db: Session, immich: ImmichConfig, album: Album) -> None:
    """Queue an Immich upload of every JPEG member (manual + tag rule), each
    added to the same-named Immich album."""
    for image in _member_images_query(db, album).filter(Image.file_type == FileType.jpeg):
        path = resolve_image_path(image)
        if path.exists():
            enqueue_immich_upload(
                immich.base_url,
                immich.api_key,
                path,
                image.taken_at,
                (album.name,),
                image_id=image.id,
            )


def _to_album_out(db: Session, album: Album) -> schemas.AlbumOut:
    # Photos sitting in the Trash keep their album membership (so restoring
    # puts them back), but they shouldn't inflate the visible count. Members
    # via the tag rule count too, so the card number matches opening the album.
    count = _member_images_query(db, album).count()
    # The first few photos (in album order) feed the card's mosaic preview.
    # JPEGs only - RAWs (dark render, usually doubling a JPEG of the same
    # shot) only when the album holds no JPEG at all. Manually placed photos
    # keep their curated order; tag-rule members fill any remaining slots
    # newest first.
    covers_base = (
        db.query(AlbumImage.image_id)
        .join(Image, Image.id == AlbumImage.image_id)
        .filter(AlbumImage.album_id == album.id, Image.deleted_at.is_(None))
        .order_by(AlbumImage.position.asc())
    )

    def fill(file_filter) -> list[str]:
        ids = [row[0] for row in covers_base.filter(file_filter).limit(4)]
        if len(ids) < 4 and album.tag_filter_list:
            extra = (
                _member_images_query(db, album)
                .filter(file_filter, Image.id.notin_(ids))
                .order_by(Image.taken_at.desc(), Image.id.asc())
                .limit(4 - len(ids))
                .all()
            )
            ids += [image.id for image in extra]
        return ids

    covers = fill(Image.file_type == FileType.jpeg)
    if not covers:
        covers = fill(Image.file_type != FileType.jpeg)
    return schemas.AlbumOut(
        id=album.id,
        name=album.name,
        description=album.description,
        created_at=album.created_at,
        image_count=count,
        cover_image_ids=covers,
        immich_sync=album.immich_sync,
        tag_filter=album.tag_filter_list,
    )


@router.get("", response_model=list[schemas.AlbumOut])
def list_albums(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    albums = db.query(Album).filter(Album.owner_id == current_user.id).order_by(Album.created_at.desc()).all()
    return [_to_album_out(db, album) for album in albums]


@router.post("", response_model=schemas.AlbumOut)
def create_album(
    payload: schemas.AlbumCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tags = _clean_tag_filter(payload.tag_filter)
    album = Album(
        owner_id=current_user.id,
        name=payload.name,
        description=payload.description,
        tag_filter=json.dumps(tags) if tags else None,
    )
    db.add(album)
    db.commit()
    db.refresh(album)
    return _to_album_out(db, album)


@router.get("/{album_id}", response_model=schemas.AlbumOut)
def get_album(album_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    album = get_owned_album(db, current_user.id, album_id)
    return _to_album_out(db, album)


@router.patch("/{album_id}", response_model=schemas.AlbumOut)
def update_album(
    album_id: str,
    payload: schemas.AlbumUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    album = get_owned_album(db, current_user.id, album_id)
    old_name = album.name
    old_tags = album.tag_filter_list
    if payload.name is not None:
        album.name = payload.name
    if payload.description is not None:
        album.description = payload.description
    if payload.tag_filter is not None:
        tags = _clean_tag_filter(payload.tag_filter)
        album.tag_filter = json.dumps(tags) if tags else None
    db.commit()
    db.refresh(album)
    # Renaming a mirrored album must follow through to Immich, or the by-name
    # mapping breaks (future uploads would spawn a fresh album under the new
    # name while the old one lingered).
    immich = get_immich_config(db)
    if album.name != old_name and _mirrored(immich, album):
        enqueue_immich_album_rename(immich.base_url, immich.api_key, old_name, album.name)
    # A widened tag rule pulls new photos into a mirrored album - push them the
    # same way flagging the album for sync does (re-uploads dedupe over there).
    if album.tag_filter_list != old_tags and _mirrored(immich, album):
        _enqueue_member_uploads(db, immich, album)
    return _to_album_out(db, album)


@router.delete("/{album_id}", status_code=204)
def delete_album(album_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    album = get_owned_album(db, current_user.id, album_id)
    immich = get_immich_config(db)
    mirrored = _mirrored(immich, album)
    name = album.name
    db.delete(album)
    db.commit()
    # Deleting an app album also deletes its Immich mirror. Only the album:
    # the photos stay in the library here and the assets stay in the Immich
    # timeline over there.
    if mirrored:
        enqueue_immich_album_delete(immich.base_url, immich.api_key, name)


@router.post("/{album_id}/images", response_model=schemas.AlbumOut)
def add_images_to_album(
    album_id: str,
    payload: schemas.AlbumAddImages,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    album = get_owned_album(db, current_user.id, album_id)
    existing_ids = {
        row.image_id
        for row in db.query(AlbumImage).filter(AlbumImage.album_id == album.id).all()
    }
    next_position = len(existing_ids)
    added: list[Image] = []
    for image_id in payload.image_ids:
        image = get_owned_image(db, current_user.id, image_id)
        if image_id in existing_ids:
            continue
        db.add(AlbumImage(album_id=album.id, image_id=image_id, position=next_position))
        next_position += 1
        added.append(image)
    db.commit()

    # A synced album mirrors its membership to Immich: photos added later must
    # upload + join the Immich album just like the ones present when the album
    # was flagged (full mode mirrors every album).
    immich = get_immich_config(db)
    if added and _mirrored(immich, album):
        for image in added:
            if image.file_type != FileType.jpeg or image.deleted_at is not None:
                continue
            path = resolve_image_path(image)
            if path.exists():
                enqueue_immich_upload(
                    immich.base_url,
                    immich.api_key,
                    path,
                    image.taken_at,
                    (album.name,),
                    image_id=image.id,
                )
    db.refresh(album)
    return _to_album_out(db, album)


@router.post("/{album_id}/immich-sync", response_model=schemas.AlbumOut)
def set_album_immich_sync(
    album_id: str,
    payload: schemas.AlbumImmichSyncRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Flag/unflag an album for selective Immich sync. Flagging on queues a
    background upload of every JPEG in the album, each added to a same-named
    Immich album; unflagging just clears the flag."""
    album = get_owned_album(db, current_user.id, album_id)
    album.immich_sync = payload.enabled
    db.commit()

    immich = get_immich_config(db)
    if payload.enabled and immich is not None:
        _enqueue_member_uploads(db, immich, album)
    db.refresh(album)
    return _to_album_out(db, album)


@router.delete("/{album_id}/images/{image_id}", status_code=204)
def remove_image_from_album(
    album_id: str,
    image_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    album = get_owned_album(db, current_user.id, album_id)
    db.query(AlbumImage).filter(
        AlbumImage.album_id == album_id, AlbumImage.image_id == image_id
    ).delete()
    db.commit()
    # Mirror the removal: take the asset out of the Immich album too (it stays
    # in the Immich timeline). Only possible when we know its asset id - photos
    # never uploaded have nothing to remove anyway.
    immich = get_immich_config(db)
    if _mirrored(immich, album):
        image = db.get(Image, image_id)
        if image is not None and image.immich_asset_id:
            enqueue_immich_album_remove_assets(
                immich.base_url, immich.api_key, album.name, [image.immich_asset_id]
            )

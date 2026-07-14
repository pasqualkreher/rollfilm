from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import schemas
from app.api.deps import get_owned_album, get_owned_image
from app.auth import get_current_user
from app.db.models import Album, AlbumImage, FileType, Image, User
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


def _to_album_out(db: Session, album: Album) -> schemas.AlbumOut:
    # Photos sitting in the Trash keep their album membership (so restoring
    # puts them back), but they shouldn't inflate the visible count.
    count = (
        db.query(func.count(AlbumImage.id))
        .join(Image, Image.id == AlbumImage.image_id)
        .filter(AlbumImage.album_id == album.id, Image.deleted_at.is_(None))
        .scalar()
    )
    return schemas.AlbumOut(
        id=album.id,
        name=album.name,
        description=album.description,
        created_at=album.created_at,
        image_count=count,
        immich_sync=album.immich_sync,
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
    album = Album(owner_id=current_user.id, name=payload.name, description=payload.description)
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
    if payload.name is not None:
        album.name = payload.name
    if payload.description is not None:
        album.description = payload.description
    db.commit()
    db.refresh(album)
    # Renaming a mirrored album must follow through to Immich, or the by-name
    # mapping breaks (future uploads would spawn a fresh album under the new
    # name while the old one lingered).
    immich = get_immich_config(db)
    if album.name != old_name and _mirrored(immich, album):
        enqueue_immich_album_rename(immich.base_url, immich.api_key, old_name, album.name)
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
        images = (
            db.query(Image)
            .join(AlbumImage, AlbumImage.image_id == Image.id)
            .filter(
                AlbumImage.album_id == album.id,
                Image.deleted_at.is_(None),
                Image.file_type == FileType.jpeg,
            )
            .all()
        )
        for image in images:
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

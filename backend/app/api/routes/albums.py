from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import schemas
from app.api.deps import get_owned_album, get_owned_image
from app.auth import get_current_user
from app.db.models import Album, AlbumImage, Image, User
from app.db.session import get_db

router = APIRouter(prefix="/albums", tags=["albums"])


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
    if payload.name is not None:
        album.name = payload.name
    if payload.description is not None:
        album.description = payload.description
    db.commit()
    db.refresh(album)
    return _to_album_out(db, album)


@router.delete("/{album_id}", status_code=204)
def delete_album(album_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    album = get_owned_album(db, current_user.id, album_id)
    db.delete(album)
    db.commit()


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
    for image_id in payload.image_ids:
        get_owned_image(db, current_user.id, image_id)
        if image_id in existing_ids:
            continue
        db.add(AlbumImage(album_id=album.id, image_id=image_id, position=next_position))
        next_position += 1
    db.commit()
    db.refresh(album)
    return _to_album_out(db, album)


@router.delete("/{album_id}/images/{image_id}", status_code=204)
def remove_image_from_album(
    album_id: str,
    image_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    get_owned_album(db, current_user.id, album_id)
    db.query(AlbumImage).filter(
        AlbumImage.album_id == album_id, AlbumImage.image_id == image_id
    ).delete()
    db.commit()

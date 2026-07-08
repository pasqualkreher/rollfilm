from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.db.models import Album, Image, ImportSession


def get_owned_image(db: Session, owner_id: int, image_id: str) -> Image:
    image = db.get(Image, image_id)
    if image is None or image.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="Image not found")
    return image


def get_owned_album(db: Session, owner_id: int, album_id: str) -> Album:
    album = db.get(Album, album_id)
    if album is None or album.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="Album not found")
    return album


def get_owned_import_session(db: Session, owner_id: int, session_id: str) -> ImportSession:
    session = db.get(ImportSession, session_id)
    if session is None or session.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="Import session not found")
    return session

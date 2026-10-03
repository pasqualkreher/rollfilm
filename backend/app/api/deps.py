from fastapi import HTTPException
from sqlalchemy.orm import Session, selectinload

from app.db.models import Album, Canvas, Image, ImageTag, ImportSession

# Everything ImageOut reads off rows other than the image's own: the pair
# partner (visible_paired_image_id), its tags and its albums. A list of photos
# loads them with these - one query per relationship for the whole page.
# Left to lazy loading it is several small queries PER PHOTO, and each of
# those has to win the interpreter back from whatever else the backend is
# busy with: while a library merge or a batch of RAW renders ran, a grid page
# of 200 photos took 3-7 seconds instead of a few hundredths.
IMAGE_OUT_LOADS = (
    selectinload(Image.paired_image),
    selectinload(Image.albums),
    selectinload(Image.tag_links).selectinload(ImageTag.tag),
)


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


def get_owned_canvas(db: Session, owner_id: int, canvas_id: str) -> Canvas:
    canvas = db.get(Canvas, canvas_id)
    if canvas is None or canvas.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="Canvas not found")
    return canvas


def get_owned_import_session(db: Session, owner_id: int, session_id: str) -> ImportSession:
    session = db.get(ImportSession, session_id)
    if session is None or session.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="Import session not found")
    return session

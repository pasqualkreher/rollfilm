"""Named snapshots of a photo's edit, and lifting an edit to the current
process version.

    GET    /images/{id}/snapshots                   newest first
    POST   /images/{id}/snapshots                   {name, edits?} - edits omitted:
                                                    the stored edit as it is now
    DELETE /images/{id}/snapshots/{sid}
    POST   /images/{id}/snapshots/{sid}/restore     the snapshot becomes the edit
    POST   /images/{id}/edits/upgrade-process       the edit renders on
                                                    develop.CURRENT_PROCESS

Restoring and the upgrade both go through the PATCH /images/{id}/edits route
itself (routes/images.save_edits), so they validate, tag, render and move the
edit revision exactly as a save from the editor does.
"""

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import schemas
from app.api.deps import get_owned_image
from app.api.routes import images as images_routes
from app.auth import get_current_user
from app.db.models import EditSnapshot, User
from app.db.session import get_db
from app.services import develop

router = APIRouter(prefix="/images", tags=["edit-snapshots"])


def _edits_json(edits: schemas.ImageEdits) -> str:
    data = edits.model_dump(mode="json")
    # Kept complete and in range, so the snapshot reads the same whatever
    # the develop schema adds later (new keys come in at their defaults).
    data["adjustments"] = develop.normalize(data.get("adjustments"))
    return json.dumps(data, separators=(",", ":"))


def _out(snapshot: EditSnapshot) -> schemas.EditSnapshotOut:
    try:
        edits = schemas.ImageEdits.model_validate(json.loads(snapshot.edits))
    except ValueError:
        edits = schemas.ImageEdits()
    return schemas.EditSnapshotOut(
        id=snapshot.id, image_id=snapshot.image_id, name=snapshot.name,
        created_at=snapshot.created_at, edits=edits,
    )


def _owned_snapshot(db: Session, image_id: str, snapshot_id: str) -> EditSnapshot:
    snapshot = db.get(EditSnapshot, snapshot_id)
    if snapshot is None or snapshot.image_id != image_id:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    return snapshot


@router.get("/{image_id}/snapshots", response_model=list[schemas.EditSnapshotOut])
def list_snapshots(
    image_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    get_owned_image(db, current_user.id, image_id)
    rows = (
        db.query(EditSnapshot)
        .filter(EditSnapshot.image_id == image_id)
        .order_by(EditSnapshot.created_at.desc(), EditSnapshot.id)
        .all()
    )
    return [_out(s) for s in rows]


@router.post("/{image_id}/snapshots", response_model=schemas.EditSnapshotOut, status_code=201)
def create_snapshot(
    image_id: str,
    payload: schemas.EditSnapshotCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    image = get_owned_image(db, current_user.id, image_id)
    if payload.edits is not None:
        # Held to what a save would accept: a snapshot that cannot be
        # restored is no snapshot.
        images_routes._validate_edits(payload.edits)
        edits = payload.edits
    else:
        edits = schemas.ImageEdits.model_validate(develop.stored_edits(image))
    name = payload.name.strip()
    if not name:
        count = db.query(EditSnapshot).filter(EditSnapshot.image_id == image_id).count()
        name = f"Snapshot {count + 1}"
    snapshot = EditSnapshot(image_id=image.id, name=name, edits=_edits_json(edits))
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)
    return _out(snapshot)


@router.delete("/{image_id}/snapshots/{snapshot_id}", status_code=204)
def delete_snapshot(
    image_id: str,
    snapshot_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    get_owned_image(db, current_user.id, image_id)
    db.delete(_owned_snapshot(db, image_id, snapshot_id))
    db.commit()


@router.post("/{image_id}/snapshots/{snapshot_id}/restore", response_model=schemas.ImageOut)
def restore_snapshot(
    image_id: str,
    snapshot_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    get_owned_image(db, current_user.id, image_id)
    edits = _out(_owned_snapshot(db, image_id, snapshot_id)).edits
    return images_routes.save_edits(image_id, edits, defer_derivatives=False, db=db, current_user=current_user)


@router.post("/{image_id}/edits/upgrade-process", response_model=schemas.ImageOut)
def upgrade_process(
    image_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Render the photo's edit on the current process version - the newest
    maths for every slider it uses, which can change how it looks (that is
    why an edit is never lifted on its own). A photo already there, or with
    no develop edit, is saved as it is."""
    image = get_owned_image(db, current_user.id, image_id)
    edits = develop.stored_edits(image)
    if edits["adjustments"]["process"] == develop.CURRENT_PROCESS:
        return image
    edits["adjustments"]["process"] = develop.CURRENT_PROCESS
    return images_routes.save_edits(
        image_id, schemas.ImageEdits.model_validate(edits), defer_derivatives=False,
        db=db, current_user=current_user,
    )

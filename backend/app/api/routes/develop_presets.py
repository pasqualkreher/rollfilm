"""Editor presets in the library (services/develop_presets).

    GET    /develop-presets            every preset, by group then name
    POST   /develop-presets            a new one (409 when the name is taken)
    PUT    /develop-presets/{id}       change name, group, sections or look
    DELETE /develop-presets/{id}
    POST   /develop-presets/import     the body is a preset file (version 1 or 2)
    GET    /develop-presets/export     every preset as a version 2 file

Applying a preset to photos is POST /images/bulk-develop with the preset's
`adjustments` and `sections`.
"""

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import schemas
from app.auth import get_current_user
from app.db.models import DevelopPreset, User
from app.db.session import get_db
from app.services import develop_presets as presets_service

router = APIRouter(prefix="/develop-presets", tags=["develop-presets"])


def _all(db: Session, owner_id: int) -> list[DevelopPreset]:
    # Ungrouped first, then the folders; names without regard to case, the
    # way the picker lists them.
    return (
        db.query(DevelopPreset)
        .filter(DevelopPreset.owner_id == owner_id)
        .order_by(
            DevelopPreset.group_name.is_not(None),
            func.lower(func.coalesce(DevelopPreset.group_name, "")),
            func.lower(DevelopPreset.name),
        )
        .all()
    )


def _owned(db: Session, owner_id: int, preset_id: str) -> DevelopPreset:
    preset = db.get(DevelopPreset, preset_id)
    if preset is None or preset.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="Preset not found")
    return preset


def _name_or_400(name: str | None) -> str:
    cleaned = presets_service.clean_name(name)
    if not cleaned:
        raise HTTPException(status_code=400, detail="A preset needs a name")
    return cleaned


def _taken(db: Session, owner_id: int, name: str, other_than: str | None = None) -> bool:
    q = db.query(DevelopPreset.id).filter(DevelopPreset.owner_id == owner_id, DevelopPreset.name == name)
    if other_than is not None:
        q = q.filter(DevelopPreset.id != other_than)
    return q.first() is not None


@router.get("", response_model=list[schemas.DevelopPresetOut])
def list_presets(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return [presets_service.to_dict(p) for p in _all(db, current_user.id)]


@router.post("", response_model=schemas.DevelopPresetOut, status_code=201)
def create_preset(
    payload: schemas.DevelopPresetIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    name = _name_or_400(payload.name)
    if _taken(db, current_user.id, name):
        raise HTTPException(status_code=409, detail="A preset with that name already exists")
    preset = DevelopPreset(owner_id=current_user.id, name=name)
    presets_service.write_fields(
        preset, group=payload.group, sections=payload.sections, adjustments=payload.adjustments
    )
    db.add(preset)
    db.commit()
    db.refresh(preset)
    return presets_service.to_dict(preset)


@router.get("/export")
def export_presets(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return presets_service.export_file(_all(db, current_user.id))


@router.post("/import", response_model=schemas.DevelopPresetImportResult)
def import_presets(
    doc: Any = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        created, replaced = presets_service.import_file(db, current_user.id, doc)
    except presets_service.PresetFileError:
        raise HTTPException(status_code=400, detail="That is not a preset file")
    db.commit()
    return schemas.DevelopPresetImportResult(
        created=created,
        replaced=replaced,
        presets=[presets_service.to_dict(p) for p in _all(db, current_user.id)],
    )


@router.put("/{preset_id}", response_model=schemas.DevelopPresetOut)
def update_preset(
    preset_id: str,
    payload: schemas.DevelopPresetUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    preset = _owned(db, current_user.id, preset_id)
    sent = payload.model_fields_set
    name = None
    if "name" in sent:
        name = _name_or_400(payload.name)
        if _taken(db, current_user.id, name, other_than=preset.id):
            raise HTTPException(status_code=409, detail="A preset with that name already exists")
    presets_service.write_fields(
        preset,
        name=name,
        group=payload.group if "group" in sent else ...,
        sections=payload.sections if "sections" in sent and payload.sections is not None else ...,
        adjustments=payload.adjustments if payload.adjustments is not None else ...,
    )
    db.commit()
    db.refresh(preset)
    return presets_service.to_dict(preset)


@router.delete("/{preset_id}", status_code=204)
def delete_preset(
    preset_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    db.delete(_owned(db, current_user.id, preset_id))
    db.commit()

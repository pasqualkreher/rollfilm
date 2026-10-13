"""Editor presets kept in the library, and the file they travel in.

A preset is a look: the develop object (develop.normalize() shape) plus the
sections of it the preset carries (develop.SECTION_KEYS). Applying one with
sections touches only those groups of the photo's edit (develop.merge_sections).

The file is the one the editor has always written, one version up:

    {"format": "rollfilm-presets", "version": 2,
     "presets": [{"name", "group", "sections", "adjustments"}, ...]}

Version 1 (frontend/src/utils/presets.ts, presets kept in the browser) wrote
"presets" as an object keyed by name, each entry only {"adjustments"} - no
group, no sections. Such a preset carries every section, which is what
applying it always did.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import DevelopPreset
from app.services import develop

FILE_FORMAT = "rollfilm-presets"
FILE_VERSION = 2


class PresetFileError(ValueError):
    """The text handed to the import is not a preset file."""


def clean_sections(sections: Any) -> list[str]:
    """The known section names of `sections`, in develop.SECTIONS order and
    once each; None (said nothing) is every section."""
    if sections is None:
        return list(develop.SECTIONS)
    wanted = {s for s in sections if isinstance(s, str)} if isinstance(sections, (list, tuple)) else set()
    return [s for s in develop.SECTIONS if s in wanted]


def clean_name(name: Any) -> str:
    return name.strip() if isinstance(name, str) else ""


def clean_group(group: Any) -> str | None:
    if not isinstance(group, str):
        return None
    return group.strip() or None


def clean_adjustments(adjustments: Any) -> dict[str, Any]:
    """The develop object as a preset stores it: complete and in range."""
    return develop.normalize(adjustments if isinstance(adjustments, dict) else {})


def to_dict(preset: DevelopPreset) -> dict[str, Any]:
    """The row as the API and the file show it."""
    try:
        sections = json.loads(preset.sections)
    except (TypeError, ValueError):
        sections = None
    try:
        adjustments = json.loads(preset.adjustments)
    except (TypeError, ValueError):
        adjustments = {}
    return {
        "id": preset.id,
        "name": preset.name,
        "group": preset.group_name,
        "sections": clean_sections(sections),
        "adjustments": clean_adjustments(adjustments),
        "created_at": preset.created_at,
        "updated_at": preset.updated_at,
    }


def write_fields(preset: DevelopPreset, *, name: str | None = None, group: Any = ...,
                 sections: Any = ..., adjustments: Any = ...) -> None:
    """Set the fields given (`...` = leave as it is), cleaned, and stamp the
    change."""
    if name is not None:
        preset.name = name
    if group is not ...:
        preset.group_name = clean_group(group)
    if sections is not ...:
        preset.sections = json.dumps(clean_sections(sections))
    if adjustments is not ...:
        preset.adjustments = json.dumps(clean_adjustments(adjustments), separators=(",", ":"))
    preset.updated_at = datetime.now(timezone.utc)


def parse_file(doc: Any) -> list[dict[str, Any]]:
    """The presets a file holds, each {name, group, sections, adjustments},
    cleaned. Entries without a name or a develop object are skipped; a later
    entry of the same name wins (as it did in the browser). Raises
    PresetFileError when `doc` is not a preset file at all."""
    if isinstance(doc, (str, bytes)):
        try:
            doc = json.loads(doc)
        except ValueError as e:
            raise PresetFileError("Not a preset file") from e
    if not isinstance(doc, dict) or doc.get("format") != FILE_FORMAT:
        raise PresetFileError("Not a preset file")
    raw = doc.get("presets")
    entries: list[tuple[Any, dict]] = []
    if isinstance(raw, dict):
        # Version 1: {name: {"adjustments": {...}}}.
        entries = [(name, entry) for name, entry in raw.items() if isinstance(entry, dict)]
    elif isinstance(raw, list):
        entries = [(entry.get("name"), entry) for entry in raw if isinstance(entry, dict)]
    else:
        raise PresetFileError("Not a preset file")
    out: dict[str, dict[str, Any]] = {}
    for name, entry in entries:
        name = clean_name(name)
        adjustments = entry.get("adjustments")
        if not name or not isinstance(adjustments, dict):
            continue
        out[name] = {
            "name": name,
            "group": clean_group(entry.get("group")),
            # Absent (every version 1 preset) means every section.
            "sections": clean_sections(entry.get("sections")),
            "adjustments": clean_adjustments(adjustments),
        }
    return list(out.values())


def export_file(presets: list[DevelopPreset]) -> dict[str, Any]:
    return {
        "format": FILE_FORMAT,
        "version": FILE_VERSION,
        "presets": [
            {k: v for k, v in to_dict(p).items() if k in ("name", "group", "sections", "adjustments")}
            for p in presets
        ],
    }


def import_file(db: Session, owner_id: int, doc: Any) -> tuple[int, int]:
    """Store the presets of a file. A name already in the library is
    replaced by the file's preset of that name - importing the same file
    twice leaves one of each. Returns (created, replaced); the caller
    commits."""
    created = replaced = 0
    for entry in parse_file(doc):
        row = (
            db.query(DevelopPreset)
            .filter(DevelopPreset.owner_id == owner_id, DevelopPreset.name == entry["name"])
            .one_or_none()
        )
        if row is None:
            row = DevelopPreset(owner_id=owner_id, name=entry["name"])
            db.add(row)
            created += 1
        else:
            replaced += 1
        write_fields(row, group=entry["group"], sections=entry["sections"], adjustments=entry["adjustments"])
    return created, replaced

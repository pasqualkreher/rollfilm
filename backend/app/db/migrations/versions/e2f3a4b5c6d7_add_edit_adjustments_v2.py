"""add edit_adjustments v2 (JSON develop state) + edit_rev, backfill from legacy columns

Revision ID: e2f3a4b5c6d7
Revises: d0e1f2a3b4c5
Create Date: 2026-07-20 12:00:00.000000

The whole non-geometry develop state now lives in one JSON column
(``edit_adjustments``) instead of ~22 individual ``edit_*`` columns, and a
monotonic ``edit_rev`` replaces the recomputed per-field thumbnail version.
The legacy columns are kept (so a pre-v2 edit can be recovered); this migration
backfills the new object from them, rescaling to the new RapidRAW-style ranges
so existing edits keep their look:
  - exposure: old -100..100 (== +/-2 EV) -> EV float via /50
  - saturation: old >0 acted as *vibrance* (weighted) -> vibrance; old <0 was
    linear -> saturation
  - color_tint: old -100..100 (== +/-180 deg) -> hue degrees via *1.8
  - denoise: old single slider -> both luma + colour noise reduction
"""
import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from app.services import develop


revision: str = "e2f3a4b5c6d7"
down_revision: Union[str, None] = "d0e1f2a3b4c5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_LEGACY_COLS = [
    "id", "edit_rotation", "edit_crop_x", "edit_flip_h", "edit_flip_v",
    "edit_straighten", "edit_persp_h", "edit_persp_v", "edit_distortion",
    "edit_exposure", "edit_contrast", "edit_highlights", "edit_shadows",
    "edit_whites", "edit_blacks", "edit_saturation", "edit_temperature",
    "edit_tint", "edit_dehaze", "edit_color_mix", "edit_vignette", "edit_grain",
    "edit_grain_size", "edit_denoise", "edit_clarity", "edit_sharpness",
    "edit_color_tint", "edit_chrome_effect", "edit_chrome_blue", "edit_mist",
]


def _adjustments_from_row(r: dict) -> str | None:
    """Build a v2 develop JSON blob from a legacy row, or None when neutral."""
    adj = develop.defaults()
    adj["exposure"] = (r["edit_exposure"] or 0) / 50.0
    sat = r["edit_saturation"] or 0
    if sat > 0:
        adj["vibrance"] = sat
    elif sat < 0:
        adj["saturation"] = sat
    adj["contrast"] = r["edit_contrast"] or 0
    adj["highlights"] = r["edit_highlights"] or 0
    adj["shadows"] = r["edit_shadows"] or 0
    adj["whites"] = r["edit_whites"] or 0
    adj["blacks"] = r["edit_blacks"] or 0
    adj["temperature"] = r["edit_temperature"] or 0
    adj["tint"] = r["edit_tint"] or 0
    adj["hue"] = (r["edit_color_tint"] or 0) * 1.8
    adj["clarity"] = r["edit_clarity"] or 0
    adj["dehaze"] = r["edit_dehaze"] or 0
    adj["sharpness"] = r["edit_sharpness"] or 0
    adj["luma_noise_reduction"] = r["edit_denoise"] or 0
    adj["color_noise_reduction"] = r["edit_denoise"] or 0
    if r["edit_grain"]:
        adj["grain_amount"] = r["edit_grain"] or 0
        adj["grain_size"] = r["edit_grain_size"] or 0
    adj["vignette_amount"] = r["edit_vignette"] or 0
    adj["chrome_effect"] = r["edit_chrome_effect"] or 0
    adj["chrome_blue"] = r["edit_chrome_blue"] or 0
    adj["mist"] = r["edit_mist"] or 0
    if r["edit_color_mix"]:
        try:
            mix = json.loads(r["edit_color_mix"])
            if isinstance(mix, dict):
                for band, vals in mix.items():
                    if band in adj["hsl"] and isinstance(vals, (list, tuple)):
                        adj["hsl"][band] = [int(vals[i]) if i < len(vals) else 0 for i in range(3)]
        except (ValueError, TypeError):
            pass
    return develop.dumps(adj)


def _has_geometry_edit(r: dict) -> bool:
    return bool(
        (r["edit_rotation"] or 0) % 360
        or r["edit_crop_x"] is not None
        or r["edit_flip_h"]
        or r["edit_flip_v"]
        or (r["edit_straighten"] or 0)
        or (r["edit_persp_h"] or 0)
        or (r["edit_persp_v"] or 0)
        or (r["edit_distortion"] or 0)
    )


def upgrade() -> None:
    op.add_column("images", sa.Column("edit_adjustments", sa.String(), nullable=True))
    op.add_column("images", sa.Column("edit_rev", sa.Integer(), nullable=False, server_default="0"))

    conn = op.get_bind()
    rows = conn.execute(sa.text(f"SELECT {', '.join(_LEGACY_COLS)} FROM images")).mappings().all()
    for r in rows:
        blob = _adjustments_from_row(r)
        rev = 1 if (blob is not None or _has_geometry_edit(r)) else 0
        if blob is None and rev == 0:
            continue  # untouched photo - leave edit_adjustments NULL, edit_rev 0
        conn.execute(
            sa.text("UPDATE images SET edit_adjustments = :adj, edit_rev = :rev WHERE id = :id"),
            {"adj": blob, "rev": rev, "id": r["id"]},
        )


def downgrade() -> None:
    op.drop_column("images", "edit_rev")
    op.drop_column("images", "edit_adjustments")

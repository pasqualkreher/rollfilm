"""add tonal/color adjustment edits to images

Revision ID: e1f2a3b4c5d6
Revises: c9a2e5f1b30d
Create Date: 2026-07-10 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e1f2a3b4c5d6'
down_revision: Union[str, None] = 'c9a2e5f1b30d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Non-destructive slider edits (-100..100, 0 = neutral). server_default '0' keeps
# this safe against libraries that already have committed photos.
_COLUMNS = (
    "edit_exposure",
    "edit_contrast",
    "edit_highlights",
    "edit_shadows",
    "edit_saturation",
    "edit_temperature",
    "edit_tint",
)


def upgrade() -> None:
    for name in _COLUMNS:
        op.add_column("images", sa.Column(name, sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    for name in reversed(_COLUMNS):
        op.drop_column("images", name)

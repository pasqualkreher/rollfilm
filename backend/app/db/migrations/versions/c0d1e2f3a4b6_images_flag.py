"""images.flag: pick / reject for culling

Revision ID: c0d1e2f3a4b6
Revises: b9c0d1e2f3a4
Create Date: 2026-10-13 09:00:00.000000

The two-state flag every culling workflow runs on - P picks, X rejects, U
takes it off - beside the stars and the colour label. Rollfilm-internal
(Lightroom does not write flags into files either); a rejected photo is
still a photo until its owner moves it to the Trash.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c0d1e2f3a4b6"
down_revision: Union[str, None] = "b9c0d1e2f3a4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("images", sa.Column("flag", sa.String(), nullable=True))
    op.create_index("ix_images_flag", "images", ["flag"])


def downgrade() -> None:
    op.drop_index("ix_images_flag", table_name="images")
    op.drop_column("images", "flag")

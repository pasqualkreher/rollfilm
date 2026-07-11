"""add deleted_at (in-app trash) to images

Revision ID: b1c2d3e4f5a6
Revises: a0c1d2e3f4b5
Create Date: 2026-07-12 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b1c2d3e4f5a6"
down_revision: Union[str, None] = "a0c1d2e3f4b5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("images", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(op.f("ix_images_deleted_at"), "images", ["deleted_at"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_images_deleted_at"), table_name="images")
    op.drop_column("images", "deleted_at")

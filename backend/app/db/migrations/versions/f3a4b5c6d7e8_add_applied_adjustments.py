"""add applied_adjustments (develop JSON baked into a saved copy)

Revision ID: f3a4b5c6d7e8
Revises: e2f3a4b5c6d7
Create Date: 2026-07-23 12:00:00.000000

"Save copy" flattens the edit into a new JPEG, so the develop settings that
produced it were lost. They now get stored on the copy row so the auto-develop
suggestion can learn from copies just like from in-place edits. Existing copies
can't be backfilled (the payload was never stored) and simply don't contribute.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f3a4b5c6d7e8"
down_revision: Union[str, None] = "e2f3a4b5c6d7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("images", sa.Column("applied_adjustments", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("images", "applied_adjustments")

"""add immich_asset_id to images and the immich_pending_deletions table
(remove permanently deleted photos from Immich)

Revision ID: c9d0e1f2a3b4
Revises: b7c8d9e0f1a2
Create Date: 2026-07-14 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c9d0e1f2a3b4'
down_revision: Union[str, None] = 'b7c8d9e0f1a2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'images',
        sa.Column('immich_asset_id', sa.String(), nullable=True),
    )
    op.create_table(
        'immich_pending_deletions',
        sa.Column('id', sa.String(), primary_key=True),
        sa.Column('asset_id', sa.String(), nullable=True),
        sa.Column('sha1_checksum', sa.String(), nullable=True),
        sa.Column('filename', sa.String(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table('immich_pending_deletions')
    op.drop_column('images', 'immich_asset_id')

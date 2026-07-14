"""add immich_sync flag to images and albums (selective Immich sync)

Revision ID: a1b2c3d4e5f6
Revises: f7a8b9c0d1e2
Create Date: 2026-07-14 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = 'f7a8b9c0d1e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'images',
        sa.Column('immich_sync', sa.Boolean(), nullable=False, server_default='0'),
    )
    op.create_index('ix_images_immich_sync', 'images', ['immich_sync'])
    op.add_column(
        'albums',
        sa.Column('immich_sync', sa.Boolean(), nullable=False, server_default='0'),
    )


def downgrade() -> None:
    op.drop_column('albums', 'immich_sync')
    op.drop_index('ix_images_immich_sync', table_name='images')
    op.drop_column('images', 'immich_sync')

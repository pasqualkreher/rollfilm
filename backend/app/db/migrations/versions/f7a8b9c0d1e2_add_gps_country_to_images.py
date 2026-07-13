"""add gps_country (reverse-geocoded region) to images

Revision ID: f7a8b9c0d1e2
Revises: e6f7a8b9c0d1
Create Date: 2026-07-13 00:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f7a8b9c0d1e2'
down_revision: Union[str, None] = 'e6f7a8b9c0d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('images', sa.Column('gps_country', sa.String(), nullable=True))
    op.create_index('ix_images_gps_country', 'images', ['gps_country'])


def downgrade() -> None:
    op.drop_index('ix_images_gps_country', table_name='images')
    op.drop_column('images', 'gps_country')

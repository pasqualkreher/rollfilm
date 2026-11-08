"""add title / creator / copyright and the hand-edited field list to images

Revision ID: f3a4b5c6d7e9
Revises: e2f3a4b5c6d8
Create Date: 2026-11-08 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f3a4b5c6d7e9'
down_revision: Union[str, None] = 'e2f3a4b5c6d8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('images', sa.Column('title', sa.String(), nullable=True))
    op.add_column('images', sa.Column('creator', sa.String(), nullable=True))
    op.add_column('images', sa.Column('copyright', sa.String(), nullable=True))
    op.add_column('images', sa.Column('meta_edited', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('images', 'meta_edited')
    op.drop_column('images', 'copyright')
    op.drop_column('images', 'creator')
    op.drop_column('images', 'title')

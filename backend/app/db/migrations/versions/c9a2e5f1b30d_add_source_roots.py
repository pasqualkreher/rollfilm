"""add external source roots (scan-in-place)

Revision ID: c9a2e5f1b30d
Revises: b2f1c7a4d9e0
Create Date: 2026-07-09 14:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c9a2e5f1b30d'
down_revision: Union[str, None] = 'b2f1c7a4d9e0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'source_roots',
        sa.Column('id', sa.String(), nullable=False),
        sa.Column('owner_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('path', sa.String(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('last_scanned_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['owner_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_source_roots_owner_id', 'source_roots', ['owner_id'])

    # Plain nullable column (no DB-level FK): SQLite can't ADD a foreign-key
    # constraint via ALTER, and the ORM relationship doesn't require one. The
    # index gives us fast "photos from this source" lookups.
    op.add_column('images', sa.Column('source_root_id', sa.String(), nullable=True))
    op.create_index('ix_images_source_root_id', 'images', ['source_root_id'])


def downgrade() -> None:
    op.drop_index('ix_images_source_root_id', table_name='images')
    op.drop_column('images', 'source_root_id')
    op.drop_index('ix_source_roots_owner_id', table_name='source_roots')
    op.drop_table('source_roots')

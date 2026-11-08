"""add meta_edits (metadata edited in the import review) to staged files

Revision ID: a4b5c6d7e8f0
Revises: f3a4b5c6d7e9
Create Date: 2026-11-08 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a4b5c6d7e8f0'
down_revision: Union[str, None] = 'f3a4b5c6d7e9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('import_staged_files', sa.Column('meta_edits', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('import_staged_files', 'meta_edits')

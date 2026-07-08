"""add in-batch duplicate tracking

Revision ID: aa093e250449
Revises: 55be4bd74c10
Create Date: 2026-07-08 18:28:56.398712

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'aa093e250449'
down_revision: Union[str, None] = '55be4bd74c10'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # SQLite can't ALTER a constraint onto an existing table directly - batch
    # mode rebuilds the table (copy-and-move) to add the FK.
    with op.batch_alter_table('import_staged_files') as batch_op:
        batch_op.add_column(sa.Column('duplicate_of_staged_file_id', sa.String(), nullable=True))
        batch_op.create_foreign_key(
            'fk_import_staged_files_duplicate_of_staged_file_id',
            'import_staged_files',
            ['duplicate_of_staged_file_id'],
            ['id'],
        )


def downgrade() -> None:
    with op.batch_alter_table('import_staged_files') as batch_op:
        batch_op.drop_constraint('fk_import_staged_files_duplicate_of_staged_file_id', type_='foreignkey')
        batch_op.drop_column('duplicate_of_staged_file_id')

"""drop the stored Borg backup settings

Revision ID: c8e9f0a1b2d3
Revises: b7d8e9f0a1c2
Create Date: 2026-10-03 14:00:00.000000

The automatic Borg backup is gone. A library that had it configured still
carries the repository address and the passphrase (in plaintext) in
app_settings, with no screen left to clear them; this drops the rows. The Borg
repository itself is not touched.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c8e9f0a1b2d3"
down_revision: Union[str, None] = "b7d8e9f0a1c2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "DELETE FROM app_settings "
            "WHERE key IN ('borg_enabled', 'borg_repo', 'borg_passphrase')"
        )
    )


def downgrade() -> None:
    # The settings are gone for good; nothing reads them any more.
    pass

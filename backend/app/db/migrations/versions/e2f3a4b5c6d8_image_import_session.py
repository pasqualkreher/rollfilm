"""images.import_session_id: every photo remembers its roll

Revision ID: e2f3a4b5c6d8
Revises: d1e2f3a4b5c7
Create Date: 2026-10-18 18:00:00.000000

Every import session is a roll: the photos that came in through it stay
together afterwards (a Rolls row in Albums, "By roll" in the Library, the
contact sheet after an import). Until now a photo only knew the day it was
imported on; the session it came through was recorded on the staged file
(duplicate_of_image_id points at the photo it became), so the column is
filled from there for everything imported before. Sessions that imported
anything and were then closed read as "committed" from now on - "discarded"
is left to the sessions that never imported a photo.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "e2f3a4b5c6d8"
down_revision: Union[str, None] = "d1e2f3a4b5c7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.add_column(sa.Column("import_session_id", sa.String(), nullable=True))
        batch.create_foreign_key(
            "fk_images_import_session_id", "import_sessions", ["import_session_id"], ["id"]
        )
    op.create_index("ix_images_import_session_id", "images", ["import_session_id"])
    # The backfill looks a staged file up by the photo it became; without an
    # index that is a full scan of import_staged_files per photo.
    op.create_index(
        "ix_import_staged_files_duplicate_of_image_id",
        "import_staged_files",
        ["duplicate_of_image_id"],
    )
    op.execute(
        """
        UPDATE images SET import_session_id = (
            SELECT f.import_session_id FROM import_staged_files f
            WHERE f.duplicate_of_image_id = images.id AND f.imported = 1
            ORDER BY f.id LIMIT 1
        )
        WHERE import_session_id IS NULL
        """
    )
    op.execute(
        """
        UPDATE import_sessions SET status = 'committed'
        WHERE status = 'discarded' AND id IN (
            SELECT DISTINCT import_session_id FROM images WHERE import_session_id IS NOT NULL
        )
        """
    )


def downgrade() -> None:
    op.drop_index("ix_import_staged_files_duplicate_of_image_id", table_name="import_staged_files")
    op.drop_index("ix_images_import_session_id", table_name="images")
    with op.batch_alter_table("images") as batch:
        batch.drop_constraint("fk_images_import_session_id", type_="foreignkey")
        batch.drop_column("import_session_id")

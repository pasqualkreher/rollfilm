"""an import session collects from several sources, each continued on its own

Revision ID: c8e9f0a1b2c3
Revises: c7d8e9f0a1b2
Create Date: 2026-09-12 09:00:00.000000

"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c8e9f0a1b2c3"
down_revision: Union[str, None] = "c7d8e9f0a1b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "import_session_sources",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "import_session_id", sa.String(), sa.ForeignKey("import_sessions.id"), nullable=False
        ),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("root", sa.String(), nullable=False),
        sa.Column("volume_mount", sa.String(), nullable=True),
        sa.Column("volume_uuid", sa.String(), nullable=True),
        sa.Column("volume_name", sa.String(), nullable=True),
        sa.Column("file_count", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_import_session_sources_import_session_id",
        "import_session_sources",
        ["import_session_id"],
    )
    op.add_column("import_staged_files", sa.Column("source_id", sa.String(), nullable=True))
    op.create_index("ix_import_staged_files_source_id", "import_staged_files", ["source_id"])

    # The single source a session used to carry becomes its first source row,
    # and the files staged from it point at that row.
    bind = op.get_bind()
    sessions = bind.execute(
        sa.text(
            "SELECT id, source_root, volume_mount, volume_uuid, volume_name, source_file_count, "
            "created_at FROM import_sessions WHERE source_root IS NOT NULL"
        )
    ).fetchall()
    for row in sessions:
        source_id = str(uuid.uuid4())
        label = row.source_root.rstrip("/\\").replace("\\", "/").split("/")[-1] or row.source_root
        bind.execute(
            sa.text(
                "INSERT INTO import_session_sources (id, import_session_id, label, root, "
                "volume_mount, volume_uuid, volume_name, file_count, created_at) VALUES "
                "(:id, :session, :label, :root, :mount, :uuid, :name, :count, :created)"
            ),
            {
                "id": source_id,
                "session": row.id,
                "label": label,
                "root": row.source_root,
                "mount": row.volume_mount,
                "uuid": row.volume_uuid,
                "name": row.volume_name,
                "count": row.source_file_count,
                "created": row.created_at,
            },
        )
        bind.execute(
            sa.text(
                "UPDATE import_staged_files SET source_id = :source WHERE import_session_id = "
                ":session AND source_relpath IS NOT NULL"
            ),
            {"source": source_id, "session": row.id},
        )

    with op.batch_alter_table("import_sessions") as batch:
        batch.drop_column("source_root")
        batch.drop_column("volume_mount")
        batch.drop_column("volume_uuid")
        batch.drop_column("volume_name")
        batch.drop_column("source_file_count")


def downgrade() -> None:
    op.add_column("import_sessions", sa.Column("source_root", sa.String(), nullable=True))
    op.add_column("import_sessions", sa.Column("volume_mount", sa.String(), nullable=True))
    op.add_column("import_sessions", sa.Column("volume_uuid", sa.String(), nullable=True))
    op.add_column("import_sessions", sa.Column("volume_name", sa.String(), nullable=True))
    op.add_column("import_sessions", sa.Column("source_file_count", sa.Integer(), nullable=True))
    bind = op.get_bind()
    # Keep the first source of each session; the rest can't be represented.
    for row in bind.execute(
        sa.text(
            "SELECT import_session_id, root, volume_mount, volume_uuid, volume_name, file_count "
            "FROM import_session_sources ORDER BY created_at"
        )
    ).fetchall():
        bind.execute(
            sa.text(
                "UPDATE import_sessions SET source_root = :root, volume_mount = :mount, "
                "volume_uuid = :uuid, volume_name = :name, source_file_count = :count "
                "WHERE id = :session AND source_root IS NULL"
            ),
            {
                "root": row.root,
                "mount": row.volume_mount,
                "uuid": row.volume_uuid,
                "name": row.volume_name,
                "count": row.file_count,
                "session": row.import_session_id,
            },
        )
    op.drop_index("ix_import_staged_files_source_id", "import_staged_files")
    op.drop_column("import_staged_files", "source_id")
    op.drop_index("ix_import_session_sources_import_session_id", "import_session_sources")
    op.drop_table("import_session_sources")

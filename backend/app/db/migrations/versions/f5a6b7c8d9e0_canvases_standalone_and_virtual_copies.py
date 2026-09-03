"""canvases become standalone (with membership) and images learn virtual copies

Revision ID: f5a6b7c8d9e0
Revises: e4f5a6b7c8d9
Create Date: 2026-09-03 14:00:00.000000

A canvas used to be a property of one album (album_layouts.album_id, unique).
It is a document in its own right now: a `canvases` row carries the name, a
`canvas_images` row per member photo feeds the filmstrip, and the layout table
is renamed to `canvas_layouts` and re-keyed by canvas_id. Every existing album
canvas is migrated into a standalone canvas named after its album, and the
album's photos become the canvas's members - so nothing anyone designed moves
or loses its filmstrip.

`images.virtual_of_image_id` is the "canvas edit" virtual copy: a second row
for the same file on disk, with its own develop state. Additive and nullable
on purpose - the images table is never rebuilt by this migration (it can be
huge, and this runs unattended at app start).

`layout_items.missing` keeps a frame on the page as a placeholder after its
photo is permanently deleted, instead of the frame vanishing with it.
"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f5a6b7c8d9e0"
down_revision: Union[str, None] = "e4f5a6b7c8d9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()

    op.create_table(
        "canvases",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(), nullable=False, server_default="Canvas"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_canvases_owner_id", "canvases", ["owner_id"])

    op.create_table(
        "canvas_images",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("canvas_id", sa.String(), sa.ForeignKey("canvases.id"), nullable=False),
        sa.Column("image_id", sa.String(), sa.ForeignKey("images.id"), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("canvas_id", "image_id"),
    )
    op.create_index("ix_canvas_images_canvas_id", "canvas_images", ["canvas_id"])
    op.create_index("ix_canvas_images_image_id", "canvas_images", ["image_id"])

    # One standalone canvas per existing album layout, named after the album,
    # with the album's photos as members. Timestamps borrow the layout's
    # updated_at so the overview sorts sensibly on day one.
    layouts = bind.execute(
        sa.text(
            "SELECT al.id, al.owner_id, al.updated_at, a.id AS album_id, a.name "
            "FROM album_layouts al JOIN albums a ON a.id = al.album_id"
        )
    ).fetchall()
    op.add_column("album_layouts", sa.Column("canvas_id", sa.String(), nullable=True))
    for row in layouts:
        canvas_id = str(uuid.uuid4())
        bind.execute(
            sa.text(
                "INSERT INTO canvases (id, owner_id, name, created_at) "
                "VALUES (:id, :owner, :name, :created)"
            ),
            {"id": canvas_id, "owner": row.owner_id, "name": row.name, "created": row.updated_at},
        )
        bind.execute(
            sa.text(
                "INSERT INTO canvas_images (canvas_id, image_id, added_at) "
                "SELECT :canvas, ai.image_id, :added FROM album_images ai "
                "WHERE ai.album_id = :album"
            ),
            {"canvas": canvas_id, "added": row.updated_at, "album": row.album_id},
        )
        bind.execute(
            sa.text("UPDATE album_layouts SET canvas_id = :canvas WHERE id = :id"),
            {"canvas": canvas_id, "id": row.id},
        )

    # Re-key the layout table. The rename updates layout_items'/layout_versions'
    # foreign-key clauses in place (SQLite rewrites referencing FKs on ALTER
    # TABLE RENAME); the batch rebuild then drops the album column. Rows whose
    # album vanished mid-flight (none, in practice) would violate NOT NULL -
    # delete any canvas-less stragglers first rather than fail the upgrade.
    op.drop_index("ix_album_layouts_album_id", table_name="album_layouts")
    op.rename_table("album_layouts", "canvas_layouts")
    bind.execute(sa.text("DELETE FROM canvas_layouts WHERE canvas_id IS NULL"))
    with op.batch_alter_table("canvas_layouts") as batch:
        batch.drop_column("album_id")
        batch.alter_column("canvas_id", existing_type=sa.String(), nullable=False)
    op.create_index(
        "ix_canvas_layouts_canvas_id", "canvas_layouts", ["canvas_id"], unique=True
    )

    op.add_column(
        "images", sa.Column("virtual_of_image_id", sa.String(), nullable=True)
    )
    op.create_index("ix_images_virtual_of_image_id", "images", ["virtual_of_image_id"])

    op.add_column(
        "layout_items",
        sa.Column("missing", sa.Boolean(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("layout_items", "missing")
    op.drop_index("ix_images_virtual_of_image_id", table_name="images")
    op.drop_column("images", "virtual_of_image_id")
    # Downgrade re-attaches each canvas layout to an album only where a
    # same-named album still exists; layouts without one are dropped, which is
    # the honest inverse of "canvases stopped belonging to albums".
    bind = op.get_bind()
    op.drop_index("ix_canvas_layouts_canvas_id", table_name="canvas_layouts")
    with op.batch_alter_table("canvas_layouts") as batch:
        batch.add_column(sa.Column("album_id", sa.String(), nullable=True))
    bind.execute(
        sa.text(
            "UPDATE canvas_layouts SET album_id = ("
            " SELECT a.id FROM albums a JOIN canvases c ON c.name = a.name"
            " WHERE c.id = canvas_layouts.canvas_id LIMIT 1)"
        )
    )
    bind.execute(sa.text("DELETE FROM canvas_layouts WHERE album_id IS NULL"))
    with op.batch_alter_table("canvas_layouts") as batch:
        batch.drop_column("canvas_id")
        batch.alter_column("album_id", existing_type=sa.String(), nullable=False)
    op.rename_table("canvas_layouts", "album_layouts")
    op.create_index("ix_album_layouts_album_id", "album_layouts", ["album_id"], unique=True)
    op.drop_index("ix_canvas_images_image_id", table_name="canvas_images")
    op.drop_index("ix_canvas_images_canvas_id", table_name="canvas_images")
    op.drop_table("canvas_images")
    op.drop_index("ix_canvases_owner_id", table_name="canvases")
    op.drop_table("canvases")

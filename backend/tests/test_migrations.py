"""The Alembic history is what turns every user's catalog into the current
schema on launch (run_server.run_migrations), so it is tested the way it runs
there: programmatically, against a real SQLite file.

- An empty file upgraded from base to head has the schema the models declare.
  A model column with no migration (or a migration nobody mirrored in the
  model) shows up here instead of as "no such column" on someone's machine.
- The newest revisions can be downgraded one step and upgraded again, which is
  the way back when a release has to be pulled.
- A catalog from roughly ten revisions ago, with a user and a photo in it,
  reaches head and still has the photo.

Revisions are read from the script directory at run time, so the tests follow
new migrations without being edited.
"""

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text

from app.config import settings
from app.db.base import Base
from app.db import models  # noqa: F401  (registers every model on Base.metadata)

MIGRATIONS = Path(__file__).resolve().parent.parent / "app" / "db" / "migrations"

# Tables that exist in a real catalog but are not part of the Alembic history:
# alembic's own bookkeeping, and the sqlite-vec virtual table plus its shadow
# tables, which services/embeddings.ensure_embeddings_table creates at startup.
IGNORED_TABLES = {"alembic_version"}
IGNORED_TABLE_PREFIXES = ("image_embeddings",)

# Drift that is already in the shipped history and cannot be fixed without a
# new migration: these columns were created nullable by their migrations
# (c8e9f0a1b2c3, c9d0e1f2a3b4, f5a6b7c8d9e0) while the models declare them
# NOT NULL. The ORM always fills them, so nothing breaks today. Listed here so
# the test still catches every NEW mismatch; the last test fails once one of
# these is fixed, so the entry is removed with the fix.
# Columns whose nullability the models and the migrations disagree on. Empty:
# the three that drifted were made nullable in the models (2026-10-13), as the
# migrations had always created them.
KNOWN_NULLABILITY_DRIFT: set[tuple[str, str]] = set()


@pytest.fixture()
def alembic_cfg(tmp_path, monkeypatch):
    """A config pointing at the source tree's migrations and a fresh database.

    migrations/env.py builds its URL from settings.db_path every time a
    command runs, so patching the settings singleton is enough. No ini file:
    env.py only reconfigures logging when there is one, and that would
    silence pytest's own loggers."""
    db_path = tmp_path / "library.db"
    monkeypatch.setattr(settings, "db_path", db_path)
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS))
    return cfg


def _engine():
    return create_engine(f"sqlite:///{settings.db_path}")


def _revisions(cfg: Config) -> list:
    """Every revision, newest first."""
    script = ScriptDirectory.from_config(cfg)
    heads = script.get_heads()
    assert len(heads) == 1, f"the migration history has {len(heads)} heads ({heads}); merge them"
    return list(script.walk_revisions())


def _current(engine) -> str | None:
    with engine.connect() as conn:
        return conn.execute(text("SELECT version_num FROM alembic_version")).scalar()


def _ignored(table: str) -> bool:
    return table in IGNORED_TABLES or table.startswith(IGNORED_TABLE_PREFIXES)


def _schema_differences(engine) -> tuple[list[str], set]:
    """Table names, column names and nullability: migrated DB vs. models."""
    inspector = inspect(engine)
    problems: list[str] = []
    drift_seen: set = set()
    db_tables = {t for t in inspector.get_table_names() if not _ignored(t)}
    model_tables = set(Base.metadata.tables)
    for table in sorted(model_tables - db_tables):
        problems.append(f"table {table!r} is in the models but no migration creates it")
    for table in sorted(db_tables - model_tables):
        problems.append(f"table {table!r} is created by a migration but has no model")
    for table in sorted(db_tables & model_tables):
        db_cols = {c["name"]: c["nullable"] for c in inspector.get_columns(table)}
        model_cols = {c.name: c.nullable for c in Base.metadata.tables[table].columns}
        for col in sorted(model_cols.keys() - db_cols.keys()):
            problems.append(f"{table}.{col} is in the model but not in the migrated database")
        for col in sorted(db_cols.keys() - model_cols.keys()):
            problems.append(f"{table}.{col} is in the migrated database but not in the model")
        for col in sorted(db_cols.keys() & model_cols.keys()):
            if db_cols[col] == model_cols[col]:
                continue
            if (table, col) in KNOWN_NULLABILITY_DRIFT:
                drift_seen.add((table, col))
                continue
            problems.append(
                f"{table}.{col}: migrated database nullable={db_cols[col]}, model nullable={model_cols[col]}"
            )
    return problems, drift_seen


def test_upgrade_from_empty_matches_the_models(alembic_cfg):
    command.upgrade(alembic_cfg, "head")
    engine = _engine()
    try:
        assert _current(engine) == _revisions(alembic_cfg)[0].revision
        problems, _ = _schema_differences(engine)
    finally:
        engine.dispose()
    assert not problems, "schema after `alembic upgrade head` differs from Base.metadata:\n  " + "\n  ".join(
        problems
    )


def test_known_drift_is_still_there(alembic_cfg):
    # Keeps KNOWN_NULLABILITY_DRIFT honest: an entry nobody needs any more
    # would quietly excuse the same mismatch coming back later.
    command.upgrade(alembic_cfg, "head")
    engine = _engine()
    try:
        _, drift_seen = _schema_differences(engine)
    finally:
        engine.dispose()
    fixed = KNOWN_NULLABILITY_DRIFT - drift_seen
    assert not fixed, f"no longer drifting, remove from KNOWN_NULLABILITY_DRIFT: {sorted(fixed)}"


def test_newest_revisions_downgrade_and_upgrade_again(alembic_cfg):
    newest = _revisions(alembic_cfg)[:3]
    for revision in newest:
        if not isinstance(revision.down_revision, str):
            # The first revision (None) or a merge point (a tuple): there is
            # no single step back to take.
            continue
        settings.db_path.unlink(missing_ok=True)
        command.upgrade(alembic_cfg, revision.revision)
        command.downgrade(alembic_cfg, revision.down_revision)
        engine = _engine()
        try:
            assert _current(engine) == revision.down_revision, revision.revision
        finally:
            engine.dispose()
        command.upgrade(alembic_cfg, revision.revision)
        engine = _engine()
        try:
            assert _current(engine) == revision.revision
        finally:
            engine.dispose()


# Values for the NOT NULL columns of a row inserted at an older revision, by
# the column's declared SQL type. Whatever exists at that revision gets one.
def _filler(sql_type: str):
    t = sql_type.upper()
    if "INT" in t or "BOOL" in t:
        return 0
    if "FLOAT" in t or "REAL" in t or "NUMERIC" in t:
        return 0.0
    if "DATETIME" in t or "TIMESTAMP" in t:
        return "2026-07-01 12:00:00.000000"
    if "DATE" in t:
        return "2026-07-01"
    if "JSON" in t:
        return "{}"
    return "x"


def _insert_row(conn, table: str, known: dict) -> None:
    """Insert one row with the given values plus a filler for every other
    NOT NULL column without a default that exists in the table right now."""
    values = dict(known)
    for col in conn.execute(text(f"PRAGMA table_info({table})")).mappings():
        name = col["name"]
        if name in values or not col["notnull"] or col["dflt_value"] is not None or col["pk"]:
            continue
        values[name] = _filler(col["type"] or "")
    columns = ", ".join(values)
    params = ", ".join(f":{k}" for k in values)
    conn.execute(text(f"INSERT INTO {table} ({columns}) VALUES ({params})"), values)


def test_an_older_catalog_upgrades_and_keeps_its_photo(alembic_cfg):
    revisions = _revisions(alembic_cfg)
    old = revisions[min(10, len(revisions) - 1)]
    command.upgrade(alembic_cfg, old.revision)

    engine = _engine()
    try:
        with engine.begin() as conn:
            _insert_row(conn, "users", {"id": 1, "username": "local"})
            _insert_row(
                conn,
                "images",
                {
                    "id": "img-1",
                    "owner_id": 1,
                    "file_path": "2026/2026-07-01/a.jpg",
                    "original_filename": "a.jpg",
                    "file_hash": "hash-a",
                    # Enum columns hold the member name; "x" would not load.
                    "file_type": "jpeg",
                    "file_size": 3,
                },
            )
    finally:
        engine.dispose()

    command.upgrade(alembic_cfg, "head")

    engine = _engine()
    try:
        assert _current(engine) == revisions[0].revision
        with engine.connect() as conn:
            row = conn.execute(
                text("SELECT owner_id, file_path, original_filename, file_type FROM images WHERE id = 'img-1'")
            ).one()
            user = conn.execute(text("SELECT username FROM users WHERE id = 1")).scalar()
    finally:
        engine.dispose()
    assert tuple(row) == (1, "2026/2026-07-01/a.jpg", "a.jpg", "jpeg")
    assert user == "local"

import sqlite_vec
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

engine = create_engine(
    f"sqlite:///{settings.db_path}",
    # `timeout` is the sqlite3 driver's lock wait (seconds) - together with
    # busy_timeout below it makes writers queue instead of erroring.
    connect_args={"check_same_thread": False, "timeout": 15},
    # A SQLite connection is a local file handle, so the pool exists for reuse,
    # not to ration a scarce resource - but the default QueuePool cap
    # (5 + 10 overflow) rationed anyway, with a hard failure mode: during an
    # import, uvicorn's request threads (grid thumbnails, review polling), the
    # staging-analysis workers and the post-import workers together can hold
    # more than 15 connections, and every further checkout died 30s later with
    # "QueuePool limit reached, connection timed out". Unlimited overflow makes
    # checkout always succeed (extra connections are simply closed on return);
    # WAL + busy_timeout already serialize the actual writes.
    pool_size=10,
    max_overflow=-1,
)


@event.listens_for(Engine, "connect")
def _on_connect(dbapi_connection, connection_record):
    dbapi_connection.execute("PRAGMA foreign_keys = ON")
    # WAL keeps readers working while background writers commit. With the
    # default rollback journal, every write locked the whole database - during
    # the hours of post-import thumbnail/embedding work after a big import,
    # foreground requests intermittently died with "database is locked" and
    # the UI looked hung. NORMAL synchronous is the recommended WAL pairing
    # (fsync on checkpoint, not on every commit).
    dbapi_connection.execute("PRAGMA journal_mode = WAL")
    dbapi_connection.execute("PRAGMA synchronous = NORMAL")
    dbapi_connection.execute("PRAGMA busy_timeout = 15000")
    dbapi_connection.enable_load_extension(True)
    sqlite_vec.load(dbapi_connection)
    dbapi_connection.enable_load_extension(False)


def ensure_indexes() -> None:
    """Indexes the hot library queries lean on, created idempotently at
    startup (they aren't part of the Alembic history). The composite index
    matches the grid's exact filter + ordering - owner, not-deleted, newest
    capture first with the deterministic tie-breakers - so building the
    library index/list is an index walk instead of a full-table sort."""
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS idx_images_owner_deleted_taken "
            "ON images (owner_id, deleted_at, taken_at DESC, original_filename ASC, id ASC)"
        )
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS idx_images_owner_country "
            "ON images (owner_id, gps_country)"
        )


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

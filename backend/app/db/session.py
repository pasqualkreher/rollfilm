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


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

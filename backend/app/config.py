import tempfile
from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_data_dir() -> Path:
    """Where app data lives when nothing else is configured (native desktop run).

    The Electron shell overrides this via PM_DATA_DIR (its userData dir); the
    Docker setup instead sets the individual *_ROOT / DB_PATH env vars, so this
    default is never hit there.
    """
    return Path.home() / "Library" / "Application Support" / "PhotoManager"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Base directory for all app data. Each concrete path below defaults to a
    # sub-directory of this, but can still be overridden individually on its own
    # env var (LIBRARY_ROOT, DB_PATH, ...) - which is exactly what Docker does.
    pm_data_dir: Path = Field(default_factory=_default_data_dir)

    library_root: Path = None  # type: ignore[assignment]  # filled from pm_data_dir below
    db_path: Path = None  # type: ignore[assignment]
    import_staging_root: Path = None  # type: ignore[assignment]
    thumbnail_cache_root: Path = None  # type: ignore[assignment]
    model_cache_root: Path = None  # type: ignore[assignment]
    # Review thumbnails/previews of STAGED files. Deliberately NOT under
    # pm_data_dir: when the library lives on an external HDD, staging shares
    # that disk with the copy stream - and the per-photo thumbnail/preview
    # writes (analysis) plus the review grid's reads were head seeks against
    # the sequential copy. The system temp dir sits on the internal disk, and
    # everything in here is disposable cache (deleted with its session;
    # previews/demosaics re-render on a cache miss).
    staged_thumbs_root: Path = None  # type: ignore[assignment]

    clip_model_name: str = "ViT-B-32"
    clip_model_pretrained: str = "laion2b_s34b_b79k"

    @model_validator(mode="before")
    @classmethod
    def _derive_paths(cls, data):
        # Fill any path not explicitly provided (via env / .env) from pm_data_dir.
        if isinstance(data, dict):
            base = Path(data.get("pm_data_dir") or _default_data_dir())
            data.setdefault("library_root", base / "library")
            data.setdefault("db_path", base / "db" / "library.db")
            data.setdefault("import_staging_root", base / "staging")
            data.setdefault("thumbnail_cache_root", base / "thumbnails")
            data.setdefault("model_cache_root", base / "models")
            data.setdefault(
                "staged_thumbs_root", Path(tempfile.gettempdir()) / "rollfilm-staged-thumbs"
            )
        return data


settings = Settings()

for directory in (
    settings.library_root,
    settings.db_path.parent,
    settings.import_staging_root,
    settings.thumbnail_cache_root,
    settings.model_cache_root,
    settings.staged_thumbs_root,
):
    directory.mkdir(parents=True, exist_ok=True)

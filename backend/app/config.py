from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    library_root: Path = Path("/data/library")
    db_path: Path = Path("/data/db/library.db")
    import_staging_root: Path = Path("/data/staging")
    thumbnail_cache_root: Path = Path("/data/thumbnails")
    model_cache_root: Path = Path("/data/models")

    # "none" today (single seeded local user). "multiuser" is reserved for the
    # future hosted mode - see app/auth.py.
    auth_mode: str = "none"

    clip_model_name: str = "ViT-B-32"
    clip_model_pretrained: str = "laion2b_s34b_b79k"

    duplicate_phash_hamming_threshold: int = 5


settings = Settings()

for directory in (
    settings.library_root,
    settings.db_path.parent,
    settings.import_staging_root,
    settings.thumbnail_cache_root,
    settings.model_cache_root,
):
    directory.mkdir(parents=True, exist_ok=True)

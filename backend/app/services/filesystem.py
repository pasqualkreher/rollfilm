from datetime import datetime
from pathlib import Path


def library_relative_path(taken_at: datetime, original_filename: str, library_root: Path) -> str:
    """Default organization scheme: LIBRARY_ROOT/YYYY/YYYY-MM-DD/original_filename.

    Resolves collisions by appending "_1", "_2", ... before the extension,
    checked directly against the filesystem (the library root is the source
    of truth, not just the DB).
    """
    day_dir = library_root / f"{taken_at.year:04d}" / taken_at.strftime("%Y-%m-%d")
    day_dir.mkdir(parents=True, exist_ok=True)

    stem = Path(original_filename).stem
    suffix = Path(original_filename).suffix
    candidate = day_dir / original_filename
    counter = 1
    while candidate.exists():
        candidate = day_dir / f"{stem}_{counter}{suffix}"
        counter += 1

    return str(candidate.relative_to(library_root))

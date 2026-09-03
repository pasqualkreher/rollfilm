from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from app.config import settings

if TYPE_CHECKING:
    from app.db.models import Image


# Separates a virtual copy's synthetic file_path ("<source path>#vc-<id>") from
# the real path it borrows. "#" can't appear in an imported path (the importer
# writes YYYY/YYYY-MM-DD/<filename> and the OS path joins never add one), so
# splitting on the marker is unambiguous.
VIRTUAL_PATH_MARKER = "#vc-"


def strip_virtual_marker(file_path: str) -> str:
    """The real on-disk path a (possibly virtual) file_path refers to."""
    marker = file_path.find(VIRTUAL_PATH_MARKER)
    return file_path if marker < 0 else file_path[:marker]


def resolve_image_path(image: "Image") -> Path:
    """The on-disk location of an image's original file.

    Managed (imported) photos live under LIBRARY_ROOT with a relative
    file_path; photos indexed from an external source root store their absolute
    path and stay wherever they are (e.g. on a NAS). A virtual copy ("canvas
    edit") owns no file: its synthetic file_path carries its source's path plus
    a marker suffix, stripped off here - so every reader in the app renders a
    virtual copy from the source's bytes without knowing the difference. This
    is the single place any of that is resolved - callers should never join
    library_root by hand.
    """
    file_path = strip_virtual_marker(image.file_path)
    if image.source_root_id:
        return Path(file_path)
    return settings.library_root / file_path


def library_relative_path(
    taken_at: datetime,
    original_filename: str,
    library_root: Path,
    is_taken: Callable[[str], bool] | None = None,
) -> str:
    """Default organization scheme: LIBRARY_ROOT/YYYY/YYYY-MM-DD/original_filename.

    Resolves collisions by appending "_1", "_2", ... before the extension,
    checked directly against the filesystem (the library root is the source
    of truth, not just the DB). `is_taken` lets callers veto candidates the
    filesystem alone can't see - paths already claimed by a DB row (e.g. a
    trashed photo whose file left the library) or by an earlier file in the
    same commit batch, where nothing has been moved onto disk yet.
    """
    day_dir = library_root / f"{taken_at.year:04d}" / taken_at.strftime("%Y-%m-%d")
    day_dir.mkdir(parents=True, exist_ok=True)

    stem = Path(original_filename).stem
    suffix = Path(original_filename).suffix

    def _claimed(path: Path) -> bool:
        if path.exists():
            return True
        return is_taken is not None and is_taken(str(path.relative_to(library_root)))

    candidate = day_dir / original_filename
    counter = 1
    while _claimed(candidate):
        candidate = day_dir / f"{stem}_{counter}{suffix}"
        counter += 1

    return str(candidate.relative_to(library_root))

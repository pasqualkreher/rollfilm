"""File names built from a template the user typed, e.g. "{date}_{seq}".

One place for what a placeholder means and for what a file name may contain,
shared by everything that names files for the user (export today; a template
typed there has to mean the same thing wherever it is typed next).
"""

import re
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.db.models import Image

# Characters no sane filename carries, and that Windows outright forbids: path
# separators (a rename is not a move), the reserved punctuation, and control
# bytes.
ILLEGAL_NAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# What a template may ask for. {name} is the photo's current name without its
# extension; {seq} counts the photos of one run, zero-padded so they sort.
PLACEHOLDERS = ("name", "date", "time", "seq", "camera", "rating")

_PLACEHOLDER_RE = re.compile(r"\{([^{}]*)\}")
# The filesystem cap is 255 bytes for the whole name; the stem leaves room for
# an extension and a collision suffix.
_MAX_STEM_BYTES = 200


def template_error(template: str) -> str | None:
    """Why this template can't be used, in words for the user - or None."""
    unknown = sorted({p for p in _PLACEHOLDER_RE.findall(template) if p not in PLACEHOLDERS})
    if unknown:
        known = ", ".join(f"{{{p}}}" for p in PLACEHOLDERS)
        return f"Unknown placeholder {{{unknown[0]}}}. Use {known}."
    literal = _PLACEHOLDER_RE.sub("", template)
    if "{" in literal or "}" in literal:
        return "A placeholder is written like {name}."
    if ILLEGAL_NAME_CHARS.search(literal):
        return 'A file name can\'t contain / \\ : * ? " < > or |.'
    return None


def seq_width(total: int) -> int:
    """Digits of {seq} for a run of `total` photos: at least three, so a
    handful of photos and a few hundred sort the same way in a file list."""
    return max(3, len(str(max(1, total))))


def render_stem(template: str | None, image: "Image", seq: int = 1, total: int = 1) -> str:
    """The file name (without extension) `template` gives this photo. An
    empty template, or one that comes out empty for this photo, is the
    photo's own name - a file is never left nameless."""
    own = Path(image.original_filename).stem
    if not template or not template.strip():
        return own
    taken = image.taken_at
    values = {
        "name": own,
        "date": taken.strftime("%Y-%m-%d") if taken else "",
        "time": taken.strftime("%H%M%S") if taken else "",
        "seq": str(seq).zfill(seq_width(total)),
        "camera": image.camera_model or "",
        "rating": str(image.rating or 0),
    }
    stem = _PLACEHOLDER_RE.sub(lambda m: values.get(m.group(1), m.group(0)), template)
    # A value can carry what a name must not ("X-T5 / II"); a missing one
    # leaves its separators behind ("_001" for a photo without a date).
    stem = ILLEGAL_NAME_CHARS.sub("-", stem).strip(" ._-")
    while len(stem.encode("utf-8")) > _MAX_STEM_BYTES:
        stem = stem[:-1]
    return stem or own

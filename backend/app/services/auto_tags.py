"""Tags Rollfilm assigns on its own.

"edit" follows a photo's develop/geometry state, "edit copy" marks a baked
copy saved from the editor and "virtual copy" a second library entry that
shares another photo's file. A virtual copy that carries edits also gets "edit".
"canvas artifact" marks a virtual copy that no canvas holds any more: canvases
mint virtual copies to edit a placed photo, so once the frame or the canvas is
gone the copy would sit in the library with nothing saying where it came from.
The tag goes away again when the copy is placed on (or added to) a canvas.

Membership tags say where a photo is used: every photo in at least one album
carries "album" plus one "album: <name>" tag per album it belongs to,
and every photo a canvas holds (in its filmstrip or placed on the page)
carries "canvas" plus "canvas: <name>". Album and canvas names are unique, so a
name tag points at exactly one album or canvas; see
app/services/membership_tags.py for how they are kept in step.

They all describe what a photo *is*, so nothing lets the user hand them out
or take them away: the tag inputs refuse them, the per-photo remove and the
tag manager's delete/prune skip them, and a tag reset leaves them on the photo.
"""
from sqlalchemy import or_

from app.db.models import Tag

CANVAS_ARTIFACT_TAG = "canvas artifact"

AUTO_TAGS: frozenset[str] = frozenset({"edit", "edit copy", "virtual copy", CANVAS_ARTIFACT_TAG})

IN_ALBUM_TAG = "album"
IN_CANVAS_TAG = "canvas"
ALBUM_TAG_PREFIX = "album: "
CANVAS_TAG_PREFIX = "canvas: "

MEMBERSHIP_TAGS: frozenset[str] = frozenset({IN_ALBUM_TAG, IN_CANVAS_TAG})


def album_tag(name: str) -> str:
    """The tag every photo of the album called `name` carries."""
    return f"{ALBUM_TAG_PREFIX}{name.strip()}"


def canvas_tag(name: str) -> str:
    """The tag every photo of the canvas called `name` carries."""
    return f"{CANVAS_TAG_PREFIX}{name.strip()}"


def is_membership_tag(name: str) -> bool:
    """True for the tags that mirror album/canvas membership - the two
    umbrella tags and anything under the "album: " / "canvas: " prefixes."""
    folded = name.strip().casefold()
    return folded in MEMBERSHIP_TAGS or folded.startswith((ALBUM_TAG_PREFIX, CANVAS_TAG_PREFIX))


def is_auto_tag(name: str) -> bool:
    """True for every app-managed name (and their case variants, so a
    hand-typed "Edit" or "Album: x" can't masquerade as one)."""
    return name.strip().casefold() in AUTO_TAGS or is_membership_tag(name)


def auto_tag_error(name: str) -> str:
    return f"“{name.strip()}” is assigned automatically and can't be added or removed by hand"


def membership_tag_criterion():
    """SQL filter matching the membership tags (see is_membership_tag)."""
    return or_(
        Tag.name.in_(MEMBERSHIP_TAGS),
        Tag.name.like(f"{ALBUM_TAG_PREFIX}%"),
        Tag.name.like(f"{CANVAS_TAG_PREFIX}%"),
    )


def auto_tag_criterion():
    """SQL filter matching every app-managed tag (see is_auto_tag)."""
    return or_(Tag.name.in_(AUTO_TAGS), membership_tag_criterion())

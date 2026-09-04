"""Tags Rollfilm assigns on its own.

"edit" follows a photo's develop/geometry state, "edit copy" marks a baked
copy saved from the editor and "virtual copy" a second library entry that
shares another photo's file. A virtual copy that carries edits also gets "edit".
They describe what a photo *is*, so nothing lets the user hand them out or
take them away: the tag inputs refuse them, the per-photo remove and the tag
manager's delete/prune skip them, and a tag reset leaves them on the photo.
"""

AUTO_TAGS: frozenset[str] = frozenset({"edit", "edit copy", "virtual copy"})


def is_auto_tag(name: str) -> bool:
    """True for the exact auto-managed names (and their case variants, so a
    hand-typed "Edit" can't masquerade as one)."""
    return name.strip().casefold() in AUTO_TAGS


def auto_tag_error(name: str) -> str:
    return f"“{name.strip()}” is assigned automatically and can't be added or removed by hand"

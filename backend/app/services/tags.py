"""The user's tags, and the hierarchy inside their names.

A tag's name is its full path: "Rome" or "Travel/Italy/Rome". Nothing else
stores the tree - no parent column, no second table - so every reader that
knows a tag by name (the grid's filter, the album rules, the export writer,
the membership tags) keeps working untouched, and a parent is simply a
prefix: "Travel" covers "Travel/Italy/Rome". That is also how Lightroom
(lr:hierarchicalSubject, "Travel|Italy|Rome") and digiKam (TagsList,
"Travel/Italy/Rome") keep theirs, so a path reads and writes 1:1 with them
(services/exif.py).

A photo carries the leaf path only; its parents are implied. Filtering by a
parent is a prefix match (`matches_criterion`), the tree the UI shows is
derived from the paths, and renaming a parent renames every path under it.

The vocabulary itself is not stored: a tag exists while a photo carries it
(services/tag_cleanup.py) - except for tags that came in with an imported
keyword list, which are marked `kept` and stay as words to pick from.
"""
from __future__ import annotations

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.db.models import Image, ImageTag, Tag
from app.services.auto_tags import is_auto_tag

SEPARATOR = "/"


def normalize(path: str) -> str:
    """Trim every component and drop empty ones: " Travel / Italy " is the
    tag "Travel/Italy". The app's own tags keep their names as they are
    (an "album: x/y" is one flat name, whatever it contains)."""
    if is_auto_tag(path):
        return path.strip()
    parts = [p.strip() for p in path.split(SEPARATOR)]
    return SEPARATOR.join(p for p in parts if p)


def leaf(path: str) -> str:
    return path.rsplit(SEPARATOR, 1)[-1]


def parent(path: str) -> str | None:
    head, sep, _ = path.rpartition(SEPARATOR)
    return head if sep else None


def ancestors(path: str) -> list[str]:
    """"Travel/Italy/Rome" -> ["Travel", "Travel/Italy"]."""
    parts = path.split(SEPARATOR)
    return [SEPARATOR.join(parts[:i]) for i in range(1, len(parts))]


def is_under(path: str, ancestor: str) -> bool:
    return path == ancestor or path.startswith(ancestor + SEPARATOR)


def matches_criterion(path: str):
    """SQL filter for the tag itself and everything filed under it."""
    return or_(Tag.name == path, Tag.name.like(_like_prefix(path) + "%", escape="\\"))


def any_of_criterion(paths: list[str]):
    """SQL filter for any of these tags or anything filed under them."""
    normalized = [normalize(p) for p in paths if p]
    normalized = [p for p in normalized if p]
    if not normalized:
        return Tag.name.in_([])
    return or_(*(matches_criterion(p) for p in normalized))


def _like_prefix(path: str) -> str:
    escaped = path.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return escaped + SEPARATOR


def get_or_create_tag(db: Session, owner_id: int, name: str) -> Tag:
    name = normalize(name)
    tag = db.query(Tag).filter(Tag.owner_id == owner_id, Tag.name == name).first()
    if tag is None:
        tag = Tag(owner_id=owner_id, name=name)
        db.add(tag)
        db.flush()
    return tag


def user_tags(db: Session, image: Image) -> list[str]:
    """The tags the user gave a photo, by name - not the ones the app keeps
    for itself ("edit", "album: ...", see auto_tags), which say where a photo
    sits in this library. What a sidecar, an export and a copy carry."""
    return [
        name
        for (name,) in db.query(Tag.name)
        .join(ImageTag, ImageTag.tag_id == Tag.id)
        .filter(ImageTag.image_id == image.id)
        .order_by(Tag.name)
        if not is_auto_tag(name)
    ]


def add_tag_to_image(db: Session, owner_id: int, image: Image, name: str) -> None:
    name = normalize(name)
    if not name:
        return
    tag = get_or_create_tag(db, owner_id, name)
    exists = (
        db.query(ImageTag.id)
        .filter(ImageTag.image_id == image.id, ImageTag.tag_id == tag.id)
        .first()
    )
    if not exists:
        db.add(ImageTag(image_id=image.id, tag_id=tag.id))


def subtree(db: Session, owner_id: int, path: str) -> list[Tag]:
    """The tag and every tag filed under it."""
    return (
        db.query(Tag)
        .filter(Tag.owner_id == owner_id, matches_criterion(path))
        .order_by(Tag.name)
        .all()
    )


class TagConflict(Exception):
    pass


def rename_tag(db: Session, owner_id: int, path: str, new_path: str) -> list[tuple[str, str]]:
    """Rename a tag, and with it everything filed under it: "Travel" ->
    "Trips" turns "Travel/Italy/Rome" into "Trips/Italy/Rome". A new path
    with more or fewer components moves the tag in the tree. Refuses to land
    on a name that exists (a merge is not a rename). Returns (old, new) per
    tag renamed."""
    path = normalize(path)
    new_path = normalize(new_path)
    if not new_path:
        raise ValueError("The name can't be empty.")
    if is_auto_tag(new_path):
        raise ValueError(f"“{new_path}” is a name the app uses itself.")
    if new_path == path:
        return []
    if is_under(new_path, path) and new_path != path:
        raise ValueError("A tag can't be moved under itself.")
    tags = subtree(db, owner_id, path)
    if not tags:
        raise LookupError("Tag not found")
    renamed: list[tuple[str, str]] = []
    for tag in tags:
        target = new_path + tag.name[len(path):]
        clash = (
            db.query(Tag.id)
            .filter(Tag.owner_id == owner_id, Tag.name == target, Tag.id != tag.id)
            .first()
        )
        if clash:
            raise TagConflict(f"“{target}” already exists.")
        renamed.append((tag.name, target))
    for tag, (_, target) in zip(tags, renamed):
        tag.name = target
    db.flush()
    return renamed


def delete_tag(db: Session, owner_id: int, path: str, *, with_children: bool) -> list[str]:
    """Delete a tag from every photo and from the list. With `with_children`
    everything filed under it goes too; without, the children stay and the
    parent is only gone as a tag of its own (its name still shows in the
    tree, implied by the children). Returns the names deleted."""
    path = normalize(path)
    if with_children:
        tags = subtree(db, owner_id, path)
    else:
        tags = db.query(Tag).filter(Tag.owner_id == owner_id, Tag.name == path).all()
    names = [t.name for t in tags]
    if tags:
        ids = [t.id for t in tags]
        db.query(ImageTag).filter(ImageTag.tag_id.in_(ids)).delete(synchronize_session=False)
        for tag in tags:
            db.delete(tag)
        db.flush()
    return names


def image_ids_with_tags(db: Session, tag_ids: list[str]) -> list[str]:
    if not tag_ids:
        return []
    rows = db.query(ImageTag.image_id).filter(ImageTag.tag_id.in_(tag_ids)).distinct().all()
    return [image_id for (image_id,) in rows]


# ---- Keyword lists ----------------------------------------------------------
# The text format Lightroom ("Export Keywords…"), Bridge and digiKam 8.8+
# share: one keyword per line, children indented by one tab under their
# parent. Lightroom also writes synonyms in braces and "[...]" flags; those
# lines are skipped. A line that is itself a path ("A/B/C") is taken as one.


def export_keyword_list(paths: list[str]) -> str:
    """The user's tag paths as an indented keyword list, parents implied."""
    tree: dict = {}
    for path in sorted({normalize(p) for p in paths if p}):
        node = tree
        for part in path.split(SEPARATOR):
            node = node.setdefault(part, {})
    lines: list[str] = []

    def walk(node: dict, depth: int) -> None:
        for name in sorted(node, key=str.casefold):
            lines.append("\t" * depth + name)
            walk(node[name], depth + 1)

    walk(tree, 0)
    return "\n".join(lines) + ("\n" if lines else "")


def parse_keyword_list(text: str) -> list[str]:
    """The paths in an indented keyword list, leaves and parents alike (so an
    empty parent is still a word to pick from). Indentation is tabs, as the
    format says; runs of four spaces are accepted as a tab for lists that
    passed through an editor."""
    paths: list[str] = []
    seen: set[str] = set()
    stack: list[str] = []
    for raw in text.splitlines():
        if not raw.strip():
            continue
        expanded = raw.replace("    ", "\t")
        depth = len(expanded) - len(expanded.lstrip("\t"))
        name = expanded.strip()
        # Lightroom's synonym lines and "[export]" style flags.
        if name.startswith("{") or name.startswith("["):
            continue
        if name.startswith("-"):
            name = name[1:].strip()
        components = [p.strip() for p in name.split(SEPARATOR) if p.strip()]
        if not components:
            continue
        del stack[depth:]
        if len(stack) < depth:
            # A deeper indent than the line above: file it under the last
            # parent there is rather than losing it.
            depth = len(stack)
        stack.extend(components)
        for i in range(depth + 1, len(stack) + 1):
            path = SEPARATOR.join(stack[:i])
            if path.casefold() not in seen:
                seen.add(path.casefold())
                paths.append(path)
    return paths


def import_keyword_list(db: Session, owner_id: int, text: str) -> tuple[int, int]:
    """Add every path of a keyword list as a kept tag. Returns (created,
    already there)."""
    created = existing = 0
    for path in parse_keyword_list(text):
        if is_auto_tag(path):
            continue
        tag = db.query(Tag).filter(Tag.owner_id == owner_id, Tag.name == path).first()
        if tag is None:
            db.add(Tag(owner_id=owner_id, name=path, kept=True))
            created += 1
        else:
            if not tag.kept:
                tag.kept = True
            existing += 1
    db.flush()
    return created, existing

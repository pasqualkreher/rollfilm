"""Grouping photos for the canvas: which ones belong on the same page, and
which ones are the core of a set.

Both work on the CLIP vectors the library already keeps (services/embeddings)
and nothing else - a page that "goes together" is a page whose photos look
alike, and the time they were taken only nudges that. Pure numpy over a few
hundred vectors at most; the routes hand in the ids of one canvas.
"""

from __future__ import annotations

from datetime import datetime

import numpy as np

# Two groups merge while their photos are at least this alike on average
# (cosine). Below it, a page would hold strangers: a portrait next to a
# landscape that merely share a colour.
MERGE_THRESHOLD = 0.55
# Photos taken within this many seconds of each other count as a little more
# alike: a day's story stays on its pages even where the subject moves on.
TIME_BONUS_WINDOW_S = 3600
TIME_BONUS = 0.05


def _unit(vecs: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return vecs / norms


def similarity_matrix(vecs: np.ndarray, taken_at: list[datetime | None]) -> np.ndarray:
    """Pairwise cosine similarity, plus the time bonus for close shots."""
    v = _unit(vecs.astype(np.float32))
    s = v @ v.T
    stamps = [t.timestamp() if t is not None else None for t in taken_at]
    for i, a in enumerate(stamps):
        if a is None:
            continue
        for j in range(i + 1, len(stamps)):
            b = stamps[j]
            if b is not None and abs(a - b) <= TIME_BONUS_WINDOW_S:
                s[i, j] += TIME_BONUS
                s[j, i] += TIME_BONUS
    np.fill_diagonal(s, 1.0)
    return s


def group_for_pages(
    ids: list[str],
    vecs: np.ndarray,
    taken_at: list[datetime | None],
    *,
    min_size: int = 2,
    max_size: int = 6,
) -> list[list[str]]:
    """Split the photos into pages of ``min_size``..``max_size`` photos that
    look alike. Average-link agglomerative clustering with a size cap: the
    two most alike groups merge while their combined size fits and their
    link is above MERGE_THRESHOLD. Groups left under ``min_size`` then join
    the most alike group with room; what still has no home shares a last
    page. Pages are ordered by their earliest photo, and so are the photos
    on each."""
    n = len(ids)
    if n == 0:
        return []
    max_size = max(1, max_size)
    min_size = max(1, min(min_size, max_size))
    s = similarity_matrix(vecs, taken_at)

    groups: list[list[int]] = [[i] for i in range(n)]

    def link(a: list[int], b: list[int]) -> float:
        return float(s[np.ix_(a, b)].mean())

    # Pass 1: merge the best-linked pair that still fits, until nothing does.
    while len(groups) > 1:
        best = (-1.0, -1, -1)
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                if len(groups[i]) + len(groups[j]) > max_size:
                    continue
                value = link(groups[i], groups[j])
                if value > best[0]:
                    best = (value, i, j)
        if best[1] < 0 or best[0] < MERGE_THRESHOLD:
            break
        _, i, j = best
        groups[i] = groups[i] + groups[j]
        del groups[j]

    # Pass 2: the small ones join the most alike group that has room, even
    # below the threshold - a page of one is worse than a slightly mixed
    # page. Largest small groups first, so pairs stay pairs where they can.
    small = sorted((g for g in groups if len(g) < min_size), key=len, reverse=True)
    kept = [g for g in groups if len(g) >= min_size]
    homeless: list[int] = []
    for g in small:
        best = (-1.0, -1)
        for k, target in enumerate(kept):
            if len(target) + len(g) > max_size:
                continue
            value = link(g, target)
            if value > best[0]:
                best = (value, k)
        if best[1] >= 0:
            kept[best[1]] = kept[best[1]] + g
        else:
            homeless.extend(g)
    # What found no page with room fills pages of its own, by time.
    homeless.sort(key=lambda i: _sort_key(taken_at[i], i))
    for at in range(0, len(homeless), max_size):
        kept.append(homeless[at : at + max_size])

    for g in kept:
        g.sort(key=lambda i: _sort_key(taken_at[i], i))
    kept.sort(key=lambda g: _sort_key(taken_at[g[0]], g[0]))
    return [[ids[i] for i in g] for g in kept]


def _sort_key(t: datetime | None, index: int) -> tuple[int, float, int]:
    # Undated photos go last, in the order they came.
    return (1, 0.0, index) if t is None else (0, t.timestamp(), index)


def reference_vector(ref_vecs: np.ndarray) -> np.ndarray:
    """One unit vector for one or more reference photos: their mean, so a
    pair of references asks for what the two have in common."""
    mean = _unit(ref_vecs.astype(np.float32)).mean(axis=0)
    return (mean / (np.linalg.norm(mean) or 1.0)).astype(np.float32)


def pick_by_reference(
    ref_vecs: np.ndarray, ids: list[str], vecs: np.ndarray, count: int
) -> list[tuple[str, float]]:
    """The ``count`` candidates nearest the reference, nearest first, with
    the L2 distance on unit vectors the similar-photos search reports. The
    filtered path of Auto pick: the candidates are whatever the tags or the
    place left over."""
    if len(ids) == 0 or count <= 0:
        return []
    ref = reference_vector(ref_vecs)
    v = _unit(vecs.astype(np.float32))
    distances = np.linalg.norm(v - ref, axis=1)
    order = np.argsort(distances, kind="stable")[:count]
    return [(ids[int(i)], float(distances[int(i)])) for i in order]


def pick_core(ids: list[str], vecs: np.ndarray, count: int) -> list[tuple[str, float]]:
    """The ``count`` photos closest to the set's centre, nearest first, each
    with its L2 distance to the centre (the same measure the similar-photos
    search reports). What a set is "about", for a canvas with no reference
    photo."""
    if len(ids) == 0 or count <= 0:
        return []
    v = _unit(vecs.astype(np.float32))
    centre = v.mean(axis=0)
    centre = centre / (np.linalg.norm(centre) or 1.0)
    distances = np.linalg.norm(v - centre, axis=1)
    order = np.argsort(distances, kind="stable")[:count]
    return [(ids[int(i)], float(distances[int(i)])) for i in order]

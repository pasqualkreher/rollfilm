"""The canvas's Auto-arrange and Auto pick (services/arrange): photos that
look alike share a page, pages hold min..max photos, the core of a set is
what sits nearest its centre."""

from datetime import datetime, timedelta

import numpy as np

from app.services.arrange import group_for_pages, pick_core


def _cluster_vectors(centres: int, per: int, dim: int = 16, spread: float = 0.08, seed: int = 1):
    """Unit vectors in `centres` tight clusters of `per` each, labelled by
    cluster; the clusters sit on distinct axes so they are far apart."""
    rng = np.random.default_rng(seed)
    ids, vecs, labels = [], [], []
    for c in range(centres):
        centre = np.zeros(dim)
        centre[c] = 1.0
        for k in range(per):
            v = centre + rng.normal(0, spread, dim)
            v /= np.linalg.norm(v)
            ids.append(f"c{c}-{k}")
            vecs.append(v)
            labels.append(c)
    return ids, np.stack(vecs), labels


def test_alike_photos_share_a_page_and_pages_respect_the_cap():
    ids, vecs, labels = _cluster_vectors(3, 4)
    groups = group_for_pages(ids, vecs, [None] * len(ids), min_size=2, max_size=6)
    assert sorted(i for g in groups for i in g) == sorted(ids)
    assert all(2 <= len(g) <= 6 for g in groups)
    # Every page holds one cluster only.
    by_id = dict(zip(ids, labels))
    for g in groups:
        assert len({by_id[i] for i in g}) == 1
    assert len(groups) == 3


def test_a_cluster_larger_than_a_page_is_split_not_dropped():
    ids, vecs, _ = _cluster_vectors(1, 9)
    groups = group_for_pages(ids, vecs, [None] * 9, min_size=2, max_size=4)
    assert sorted(i for g in groups for i in g) == sorted(ids)
    assert all(len(g) <= 4 for g in groups)
    assert len(groups) == 3


def test_an_outlier_joins_the_nearest_page_with_room():
    ids, vecs, _ = _cluster_vectors(2, 3)
    rng = np.random.default_rng(7)
    # Far from both clusters, a little nearer the second.
    lone = rng.normal(0, 1, 16)
    lone[1] += 2.0
    lone /= np.linalg.norm(lone)
    ids.append("lone")
    vecs = np.vstack([vecs, lone])
    groups = group_for_pages(ids, vecs, [None] * len(ids), min_size=2, max_size=6)
    assert sorted(i for g in groups for i in g) == sorted(ids)
    # No page of one: the outlier was taken in somewhere.
    assert all(len(g) >= 2 for g in groups)
    assert any("lone" in g for g in groups)


def test_pages_and_photos_are_in_time_order():
    ids, vecs, _ = _cluster_vectors(2, 2)
    t0 = datetime(2026, 7, 1, 10, 0)
    # Cluster 1 was shot first; inside cluster 0 the second photo came first.
    taken = [t0 + timedelta(days=1, hours=1), t0 + timedelta(days=1), t0, t0 + timedelta(minutes=5)]
    groups = group_for_pages(ids, vecs, taken, min_size=2, max_size=6)
    assert groups == [["c1-0", "c1-1"], ["c0-1", "c0-0"]]


def test_empty_and_single():
    assert group_for_pages([], np.zeros((0, 16)), [], min_size=2, max_size=6) == []
    v = np.zeros((1, 16))
    v[0, 0] = 1
    assert group_for_pages(["only"], v, [None], min_size=2, max_size=6) == [["only"]]


def test_pick_core_is_the_centre_of_the_set():
    ids, vecs, labels = _cluster_vectors(2, 5)
    # Nine of one cluster, one of the other: the core is the big cluster.
    keep = [i for i, l in enumerate(labels) if l == 0] + [5]
    ids = [ids[i] for i in keep]
    vecs = vecs[keep]
    picked = pick_core(ids, vecs, 3)
    assert len(picked) == 3
    assert all(i.startswith("c0-") for i, _ in picked)
    assert [d for _, d in picked] == sorted(d for _, d in picked)
    assert pick_core(ids, vecs, 0) == []
    assert len(pick_core(ids, vecs, 99)) == len(ids)


def test_pick_by_reference_prefers_the_references_cluster_and_keeps_order():
    from app.services.arrange import pick_by_reference, reference_vector

    ids, vecs, labels = _cluster_vectors(2, 4)
    refs = vecs[[0, 1]]  # two photos of cluster 0
    assert np.isclose(np.linalg.norm(reference_vector(refs)), 1.0)
    picked = pick_by_reference(refs, ids, vecs, 3)
    assert [i for i, _ in picked] and all(i.startswith("c0-") for i, _ in picked)
    assert [d for _, d in picked] == sorted(d for _, d in picked)
    assert pick_by_reference(refs, [], np.zeros((0, 16)), 3) == []


def test_one_per_page_when_asked():
    ids, vecs, _ = _cluster_vectors(1, 5)
    groups = group_for_pages(ids, vecs, [None] * 5, min_size=1, max_size=1)
    assert groups == [[i] for i in ids]

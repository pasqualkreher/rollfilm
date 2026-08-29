"""How a moment gets its name.

The vocabulary is deliberately coarse ("Nature", "City") with specific CLIP
prompts behind each title: zero-shot CLIP is good at "is this outdoors in the
woods" and bad at "is this a waterfall or a river", and the old one-title-per-
prompt vocabulary published every one of those near-misses as an album name.
"""

import numpy as np
import pytest

from app.services import smart_albums


def test_every_bucket_has_a_title_and_prompts():
    titles = [title for title, _ in smart_albums._BUCKETS]
    assert len(titles) == len(set(titles)), "duplicate bucket titles"
    for title, prompts in smart_albums._BUCKETS:
        assert prompts, f"{title} has no prompts"
        assert len(prompts) == len(set(prompts)), f"{title} repeats a prompt"
        # Enough prompts to average the top _BUCKET_TOP_K over.
        assert len(prompts) >= smart_albums._BUCKET_TOP_K, title


def test_prompts_are_unique_across_buckets():
    """A prompt in two buckets would let one subject win the other's slot."""
    seen: dict[str, str] = {}
    for title, prompts in smart_albums._BUCKETS:
        for prompt in prompts:
            assert prompt not in seen, f"{prompt!r} in both {seen.get(prompt)} and {title}"
            seen[prompt] = title


def test_bucket_score_is_the_mean_of_its_best_prompts(monkeypatch):
    monkeypatch.setattr(
        smart_albums,
        "_BUCKETS",
        [("Alpha", ["a", "b", "c"]), ("Beta", ["d", "e"])],
    )
    sims = np.array([[0.1, 0.9, 0.5, 0.4, 0.2]], dtype=np.float32)

    scores = smart_albums._bucket_scores(sims)

    # Alpha: mean of its two best (0.9, 0.5). Beta: mean of both (0.4, 0.2).
    assert scores.shape == (1, 2)
    assert scores[0][0] == pytest.approx(0.7)
    assert scores[0][1] == pytest.approx(0.3)


def test_one_strong_prompt_does_not_carry_a_bucket(monkeypatch):
    """The regression the top-k mean exists for: a big bucket used to win on
    its single luckiest prompt, which is how a park bench became "Gardens"."""
    monkeypatch.setattr(
        smart_albums,
        "_BUCKETS",
        [("Big", ["a", "b", "c", "d"]), ("Small", ["e", "f"])],
    )
    # Big has the single highest prompt; Small is consistently close behind.
    sims = np.array([[0.9, 0.1, 0.1, 0.1, 0.6, 0.6]], dtype=np.float32)

    scores = smart_albums._bucket_scores(sims)[0]

    assert scores[0] == pytest.approx(0.5)  # (0.9 + 0.1) / 2
    assert scores[1] == pytest.approx(0.6)
    assert scores.argmax() == 1


def test_bucket_scores_reject_a_mismatched_matrix(monkeypatch):
    monkeypatch.setattr(smart_albums, "_BUCKETS", [("Alpha", ["a", "b"])])
    with pytest.raises(ValueError):
        smart_albums._bucket_scores(np.zeros((1, 5), dtype=np.float32))


def test_a_weak_match_stays_unnamed(monkeypatch):
    """Below the threshold the cluster keeps the neutral "Moments" title
    instead of borrowing a subject the photos are not about."""
    dims = 4
    monkeypatch.setattr(smart_albums, "_BUCKETS", [("Alpha", ["a", "b"])])
    # Label rows orthogonal to the photos: nothing scores above the floor.
    monkeypatch.setattr(
        smart_albums,
        "_get_label_matrix",
        lambda: np.stack([np.eye(dims, dtype=np.float32)[2]] * 2),
    )
    monkeypatch.setattr(
        smart_albums,
        "_get_qualifier_matrix",
        lambda: np.zeros((len(smart_albums._QUALIFIERS), dims), dtype=np.float32),
    )
    size = smart_albums.MIN_CLUSTER_SIZE
    ids = [f"p{i}" for i in range(size)]
    vecs = np.stack([np.eye(dims, dtype=np.float32)[0]] * size)

    clusters = smart_albums._build_clusters(ids, vecs, {})

    assert [c.group for c in clusters] == ["Moments"]


def test_a_qualifier_never_repeats_the_base(monkeypatch):
    """"Winter · Winter" is not a distinguishing name - the next qualifier
    down gets the sibling instead."""
    dims = 3
    monkeypatch.setattr(
        smart_albums,
        "_QUALIFIERS",
        [("Winter", "a cold photo"), ("Sunny", "a bright photo")],
    )
    # Both qualifier rows match every centroid, so only the base guard can
    # keep "Winter" out of the name.
    monkeypatch.setattr(
        smart_albums,
        "_get_qualifier_matrix",
        lambda: np.stack([np.ones(dims, dtype=np.float32)] * 2),
    )
    group = [{"members": [0], "centroid": np.ones(dims, dtype=np.float32)}]

    names = smart_albums._sibling_names("Winter", group, ["p0"], {})

    assert names == ["Winter · Sunny"]

"""Smart albums: automatic, virtual collections shown above the manual albums.

Two kinds, neither ever stored as an Album row - they are recomputed from the
library itself, so they track imports and deletions on their own:

* Similarity clusters ("Moments"): the CLIP image embeddings that already
  power semantic search are grouped by cosine similarity, and each cluster is
  named by comparing its centroid against a small vocabulary of broad English
  subjects ("Nature", "City", "Sports") encoded with the same CLIP model
  (zero-shot, no extra model needed) - see _BUCKETS.
* Time albums: one album per year and per month, plus "big days" - single
  days with unusually many photos (a trip, a party), found by comparing each
  day's count against the library's median shooting day.
* Places: GPS fixes clustered by distance, each named offline via the bundled
  reverse-geocoding cities database ("Munich, Germany").
* Countries: one album per gps_country, optionally also split by year
  ("Italy 2024").

Which sections are computed at all, and the place radius, are user settings -
see settings_store.get_smart_album_config().

Clustering touches every embedding and may need to load the CLIP model, so it
runs on a background thread and its result is cached in memory; the API serves
the previous result (or "building" on first run) while a refresh runs. The
result is also persisted to a small JSON file in the data dir together with
the library signature it was computed from, so a restart serves the previous
moments immediately - and skips the rebuild entirely when the library has not
changed since.
"""

import calendar
import json
import logging
import threading
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import FileType, Image, ImageTag, Tag
from app.db.session import SessionLocal, engine
from app.services import embeddings, geocode
from app.services import sources as sources_service

# Cosine similarity two photos need to land in the same cluster. ViT-B-32
# image/image similarities run roughly: near-duplicates 0.9+, same subject or
# scene 0.75-0.85, loosely related 0.6-0.7. 0.76 sits in the "same subject or
# scene" band: moments hold photos that really belong together (one trip, one
# kind of scene) instead of a loose theme - 0.72 pulled in merely related
# shots and made mixed-bag moments.
SIMILARITY_THRESHOLD = 0.76
# Below this a "cluster" is just a handful of stragglers, not an album. Five is
# already a set of photos of one thing - the old floor of eight quietly threw
# away plenty of perfectly good moments (an afternoon with one subject rarely
# runs to eight keepers) without making the surviving ones any better.
MIN_CLUSTER_SIZE = 5
# How many moments the section may show. This is a display budget, not a
# quality bar: everything past it was dropped purely for being smaller than the
# rest, so a library with many distinct subjects was cut back to the same
# fifteen cards as a library with few. The naming pass costs one small matrix
# product per cluster, so the higher cap is not what the build spends its time
# on - the clustering passes over every embedding are, and those are unchanged.
MAX_CLUSTERS = 40
# Minimum centroid/bucket score to trust a name; below it a cluster is called
# "Moments" rather than something the photos may not be about. CLIP image/text
# similarities are much lower than image/image ones - measured over a real
# 8.8k-photo library the surviving clusters score 0.20-0.32 against their
# bucket, so this sits below anything that clustered cleanly and only catches
# the genuinely unrecognisable.
LABEL_MIN_SIMILARITY = 0.17

# A day must have at least this many photos to count as a "big day", and also
# beat 3x the library's median shooting day (so a casual-snapshot library and
# a burst-happy one both get sensible picks).
BIG_DAY_MIN_PHOTOS = 10
BIG_DAY_MEDIAN_FACTOR = 3.0
MAX_BIG_DAYS = 30
MIN_MONTH_PHOTOS = 5

# The place radius (km) is user-configurable - see
# settings_store.get_smart_album_config(); callers pass it in.
MIN_PLACE_PHOTOS = 5
MAX_PLACES = 30
# A country/year combo with fewer photos is noise, not an album.
MIN_COUNTRY_YEAR_PHOTOS = 3
MAX_COUNTRY_YEARS = 60

# The album titles a moment can be named after, and the CLIP prompts each one
# is scored with. The titles are deliberately BROAD - "Nature", "City",
# "Sports" - while the prompts behind them stay specific.
#
# The vocabulary used to be one specific title per prompt ("Waterfalls",
# "Bridges", "Museums & Art", ~85 of them), which asked zero-shot CLIP for a
# precision it does not have: a cluster is named from one centroid, so a lake
# with a footbridge became "Bridges" and a park bench became "Gardens & Parks",
# and every such near-miss reads to the user as a wrong album. Broad titles
# make those misses invisible, because the neighbouring prompts that compete
# for a cluster now nearly all sit in the SAME bucket - mistaking a waterfall
# for a river no longer changes the name.
#
# Prompts stay specific because that is what CLIP was trained on: a full
# caption ("a photo of a waterfall") matches far better than the bare bucket
# noun ("a photo of nature"), which is vague enough to score middlingly on
# everything. So each bucket is scored through its own concrete examples - see
# _bucket_scores.
_BUCKETS: list[tuple[str, list[str]]] = [
    (
        "People",
        [
            "a portrait photo of a person",
            "a group photo of several people posing together",
            "a photo of children playing",
            "a photo of a baby",
            "a selfie photo taken at arm's length",
            "a candid photo of someone's face up close",
        ],
    ),
    (
        "Celebrations",
        [
            "a photo of a wedding",
            "a photo of a party celebration",
            "a photo of a birthday cake with candles",
            "a photo of christmas decorations",
            "a photo of a concert with stage lights",
            "a photo of fireworks in the sky",
        ],
    ),
    (
        "Beach & Sea",
        [
            "a photo of a beach and the sea",
            "a photo of a rocky coastline with steep cliffs",
            "a photo of an island surrounded by sea",
            "a photo of a surfer riding a wave",
            "a photo of boats on the water",
            "a photo of a harbour with docked boats",
            "an underwater photo of fish and coral",
            "a photo of a swimming pool",
        ],
    ),
    (
        "Mountains",
        [
            "a photo of mountains",
            "a photo of an alpine valley below rocky peaks",
            "a photo of people hiking on a mountain trail",
            "a photo of a climber on a rock wall",
            "a photo of skiing on a snowy slope",
        ],
    ),
    (
        "Nature",
        [
            "a photo of a forest",
            "a photo of a single tree in a field",
            "a close-up photo of flowers",
            "a photo of a waterfall",
            "a photo of a lake or a river",
            "a photo of farmland and fields in the countryside",
            "a photo of a garden or a park",
            "a photo of a desert with sand dunes",
            "a macro close-up photo of a plant or an insect",
            "a photo of colorful autumn foliage",
        ],
    ),
    (
        "Winter",
        [
            "a photo of a snowy winter landscape",
            "a photo of snow covered trees",
            "a photo of a frozen lake in winter",
            "a photo of a village under fresh snow",
        ],
    ),
    (
        "City",
        [
            "a photo of a city skyline",
            "a street photography shot of people in a city",
            "a photo of a building facade",
            "a photo of a narrow street in an old historic town",
            "a photo of a bridge",
            "a photo of glowing neon signs at night",
            "a photo of graffiti or a mural painted on a wall",
            "a photo of a street market with stalls",
            "an aerial photo of city rooftops",
        ],
    ),
    (
        "Landmarks",
        [
            "a photo of a church or a temple",
            "a photo of a castle",
            "a photo of ancient stone ruins",
            "a photo of a statue or a monument",
            "a photo of a lighthouse on the coast",
            "a photo of a famous tourist landmark",
        ],
    ),
    (
        "Animals",
        [
            "a photo of a dog",
            "a photo of a cat",
            "a photo of a bird",
            "a photo of wild animals in nature",
            "a photo of horses",
            "a photo of cows and sheep in a pasture",
        ],
    ),
    (
        "Food & Drink",
        [
            "a photo of a plate of food",
            "a photo of drinks in a café or a bar",
            "a photo of a picnic on a blanket outdoors",
            "a photo of a cup of coffee on a table",
        ],
    ),
    (
        "Sports",
        [
            "a photo of people doing sports",
            "a photo of people running a race",
            "a photo of bicycles or people cycling",
            "a photo of a person fishing at the water",
            "a photo of a sports match in a stadium",
        ],
    ),
    (
        "Travel",
        [
            "a photo inside an airport terminal",
            "a photo of a train or a railway station",
            "a photo of an airplane",
            "a photo of an empty road stretching into the distance",
            "a photo of a campsite with tents",
            "a photo taken through an airplane window",
        ],
    ),
    (
        "Vehicles",
        [
            "a photo of a car",
            "a photo of a motorcycle",
            "a photo of a classic vintage car",
        ],
    ),
    (
        "Indoors",
        [
            "a photo of a room interior",
            "a photo of artwork on a museum wall",
            "a photo of a stack of books",
            "a photo of objects on a table indoors",
        ],
    ),
    (
        "Sky & Weather",
        [
            "a photo of a sunset sky",
            "a photo of a sunrise at dawn",
            "a photo of the night sky with stars",
            "a photo of dark storm clouds over a landscape",
            "a photo of a landscape covered in fog and mist",
            "a photo of clouds in a blue sky",
        ],
    ),
    (
        "Screenshots & Documents",
        [
            "a screenshot of a computer or phone screen",
            "a photo of a document or a receipt",
            "a scan of a printed page",
        ],
    ),
]

# How many of a bucket's prompts decide its score. One alone made the score a
# lottery between near-synonymous prompts and let a bucket with many prompts
# win on sheer number of tickets; averaging the two best asks for a bucket to
# be right about a cluster twice, which is exactly the "is this really what
# the album is about" question the single best prompt cannot answer.
_BUCKET_TOP_K = 2

# Qualifiers used to tell same-label clusters apart ("Mountains · Sunny" vs
# "Mountains · Snow") instead of numbering them. Scored zero-shot against the
# cluster centroid exactly like the base labels. Deliberately generic visual
# attributes - weather, light, season, terrain, composition - so any of them
# reads naturally behind any base label; region/style words ("Alpine",
# "Mediterranean") sounded off on the wrong subject.
_QUALIFIERS: list[tuple[str, str]] = [
    ("Sunny", "a photo taken on a bright sunny day"),
    ("Rainy", "a photo taken in rainy weather"),
    ("Cloudy", "a photo under an overcast cloudy sky"),
    ("Foggy", "a photo in fog or mist"),
    ("Snow", "a photo with snow"),
    ("Winter", "a photo of a cold winter scene"),
    ("Autumn", "a photo with colorful autumn foliage"),
    ("Spring", "a photo with fresh spring blossoms"),
    ("Summer", "a photo of a warm summer day"),
    ("Sunset", "a photo of a sunset"),
    ("Golden light", "a photo in warm golden evening light"),
    ("Night", "a photo taken at night"),
    ("Cliffs", "a photo of steep cliffs and rock faces"),
    ("Rocky", "a photo of rocky rugged terrain"),
    ("Green", "a photo of lush green scenery"),
    ("By the water", "a photo taken next to the water"),
    ("Forest", "a photo among the trees of a forest"),
    ("Wide views", "a wide panoramic view photo"),
    ("Close-ups", "a close-up photo of a subject"),
    ("Colorful", "a very colorful vibrant photo"),
    ("People", "a photo with people in it"),
    ("Indoors", "a photo taken indoors"),
]
# Same idea as LABEL_MIN_SIMILARITY: below this a qualifier is a guess, not a
# description - fall through to country/year instead.
QUALIFIER_MIN_SIMILARITY = 0.17


@dataclass
class SmartCluster:
    name: str
    image_ids: list[str]
    cover_image_id: str
    # Base label shared by sibling clusters ("Mountains" for "Mountains ·
    # Alpine" and "Mountains · Mediterranean") - the UI stacks a group's
    # moments under one expandable card. Equal to name for lone clusters.
    group: str = ""


@dataclass
class _ClusterState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    computing: bool = False
    # Whether the on-disk cache has been consulted yet (once per process).
    loaded: bool = False
    # Library fingerprint the cached clusters were computed from; None until
    # the first build finishes.
    signature: tuple | None = None
    clusters: list[SmartCluster] = field(default_factory=list)


_state = _ClusterState()
_CACHE_PATH = settings.pm_data_dir / "smart_albums_cache.json"
_label_matrix: np.ndarray | None = None
_qualifier_matrix: np.ndarray | None = None
_label_lock = threading.Lock()


# Part of the cache signature: bumping it makes every stored cache stale, so
# an algorithm/naming change reaches users on their next visit instead of
# waiting for the library to change.
# 8: 0.1.49 shipped a build that clustered nothing (the live-id set was
#    shadowed by a query object), and it cached that empty result under a
#    signature that still looked current - the bump threw those caches away.
# 9: the label vocabulary went coarse (see _BUCKETS), so every moment is
#    named differently from the same photos. A naming change needs its own
#    bump even when it ships alongside another one: a build that ran in
#    between wrote a version-8 cache full of the OLD names, and without this
#    the signature still matched and those names would never be recomputed.
_ALGO_VERSION = 9


def _library_signature(db: Session) -> tuple:
    """Cheap fingerprint of everything the clusters depend on: set of photos
    (imports/trash) and how many of them have an embedding yet (the embed
    workers trickle in after an import)."""
    emb_count = db.execute(text("SELECT count(*) FROM image_embeddings")).scalar() or 0
    img_count = (
        db.query(func.count(Image.id)).filter(Image.deleted_at.is_(None)).scalar() or 0
    )
    last_import = db.query(func.max(Image.imported_at)).scalar()
    return (_ALGO_VERSION, emb_count, img_count, str(last_import))


def get_clusters(db: Session) -> tuple[str, list[SmartCluster]]:
    """Serve the cached clusters, kicking off a background rebuild when the
    library changed. Returns (status, clusters): "building" while the very
    first build has nothing to serve yet, "refreshing" while served clusters
    are stale and a rebuild is running (the search embeddings trickle in AFTER
    an import now, so the first build after one can legitimately see few or no
    vectors - without this state the UI stopped polling at "ready" and the
    rebuilt clusters never appeared until some later visit), "ready" otherwise."""
    sig = _library_signature(db)
    with _state.lock:
        if not _state.loaded:
            _state.loaded = True
            _load_cache_locked(db)
        stale = sig != _state.signature
        if stale and not _state.computing:
            _state.computing = True
            threading.Thread(
                target=_compute_clusters, args=(sig,), daemon=True, name="smart-albums"
            ).start()
        if _state.signature is None:
            status = "building"
        elif stale or _state.computing:
            status = "refreshing"
        else:
            status = "ready"
        return status, list(_state.clusters)


def _load_cache_locked(db: Session) -> None:
    """Seed the in-memory state from the on-disk cache (called once, under the
    state lock). Image ids that have since left the library are dropped so a
    stale cache never surfaces deleted photos; any such change also shows up in
    the signature, which makes get_clusters schedule a rebuild right after."""
    try:
        data = json.loads(_CACHE_PATH.read_text())
    except FileNotFoundError:
        return
    except Exception:
        logging.getLogger(__name__).warning(
            "ignoring unreadable smart album cache at %s", _CACHE_PATH
        )
        return
    try:
        signature = tuple(data["signature"])
        live_ids = {
            row[0]
            for row in db.query(Image.id).filter(Image.deleted_at.is_(None)).all()
        }
        clusters: list[SmartCluster] = []
        for entry in data["clusters"]:
            image_ids = [i for i in entry["image_ids"] if i in live_ids]
            if len(image_ids) < MIN_CLUSTER_SIZE:
                continue
            cover = entry["cover_image_id"]
            if cover not in live_ids:
                cover = image_ids[0]
            clusters.append(
                SmartCluster(
                    name=entry["name"],
                    image_ids=image_ids,
                    cover_image_id=cover,
                    group=entry.get("group") or entry["name"],
                )
            )
    except (KeyError, TypeError):
        logging.getLogger(__name__).warning(
            "ignoring malformed smart album cache at %s", _CACHE_PATH
        )
        return
    _state.signature = signature
    _state.clusters = clusters


def _save_cache(sig: tuple, clusters: list[SmartCluster]) -> None:
    """Write signature + clusters atomically; a failed write only costs the
    next process start a rebuild, so it is logged and swallowed."""
    try:
        payload = json.dumps(
            {
                "signature": list(sig),
                "clusters": [
                    {
                        "name": c.name,
                        "group": c.group,
                        "image_ids": c.image_ids,
                        "cover_image_id": c.cover_image_id,
                    }
                    for c in clusters
                ],
            }
        )
        tmp = _CACHE_PATH.with_suffix(".json.tmp")
        tmp.write_text(payload)
        tmp.replace(_CACHE_PATH)
    except Exception:
        logging.getLogger(__name__).warning(
            "could not persist smart album cache to %s", _CACHE_PATH, exc_info=True
        )


def _get_label_matrix() -> np.ndarray:
    """One row per bucket PROMPT (all buckets flattened, in order) - see
    _bucket_scores for how the rows are folded back into per-bucket scores."""
    global _label_matrix
    if _label_matrix is None:
        with _label_lock:
            if _label_matrix is None:
                _label_matrix = embeddings.encode_texts(
                    [prompt for _, prompts in _BUCKETS for prompt in prompts]
                )
    return _label_matrix


def _bucket_scores(prompt_sims: np.ndarray) -> np.ndarray:
    """Fold per-prompt similarities (n_clusters x n_prompts, prompts in
    _BUCKETS order) into per-bucket scores (n_clusters x n_buckets).

    A bucket scores as the mean of its _BUCKET_TOP_K best prompts, which keeps
    buckets comparable no matter how many prompts they carry: taking the best
    prompt alone would hand "Nature" (ten prompts) an advantage over
    "Vehicles" (three) that has nothing to do with the photos."""
    n_prompts = sum(len(prompts) for _, prompts in _BUCKETS)
    if prompt_sims.shape[1] != n_prompts:
        # Would otherwise slice past the end and average nothing into a NaN.
        raise ValueError(
            f"label matrix has {prompt_sims.shape[1]} rows, _BUCKETS wants {n_prompts}"
        )
    scores = np.empty((prompt_sims.shape[0], len(_BUCKETS)), dtype=prompt_sims.dtype)
    start = 0
    for b, (_, prompts) in enumerate(_BUCKETS):
        block = prompt_sims[:, start : start + len(prompts)]
        k = min(_BUCKET_TOP_K, block.shape[1])
        # -k partition puts the k largest last; their mean is the score.
        top = np.partition(block, -k, axis=1)[:, -k:] if block.shape[1] > k else block
        scores[:, b] = top.mean(axis=1)
        start += len(prompts)
    return scores


def _get_qualifier_matrix() -> np.ndarray:
    global _qualifier_matrix
    if _qualifier_matrix is None:
        with _label_lock:
            if _qualifier_matrix is None:
                _qualifier_matrix = embeddings.encode_texts(
                    [phrase for _, phrase in _QUALIFIERS]
                )
    return _qualifier_matrix


def _cluster_inputs(
    db: Session,
) -> tuple[set[str], set[str], dict[str, tuple[int | None, str | None]]]:
    """Everything the build needs from the database: which photos are live,
    which of them are the RAW half of a pair (excluded from clustering), and
    the per-photo year/country used for fallback qualifiers."""
    live_ids = {
        row[0] for row in db.query(Image.id).filter(Image.deleted_at.is_(None)).all()
    }
    # A RAW+JPEG pair carries two near-identical embeddings. Cluster on
    # the JPEG alone (what we display) and drop the RAW half, so a moment
    # never shows the same shot twice - or, worse, renders the dark RAW
    # when only the RAW landed in the cluster. Lone RAWs (no JPEG
    # sibling) keep their embedding and still cluster.
    # The partner has to still be in the library: with the JPEG in the
    # Trash the RAW is the only file left of that shot, and dropping it
    # as "the RAW half of a pair" made the shot vanish from smart
    # albums entirely.
    paired_raw_ids = {
        row[0]
        for row in db.query(Image.id, Image.paired_image_id).filter(
            Image.deleted_at.is_(None),
            Image.file_type == FileType.raw,
            Image.paired_image_id.isnot(None),
        )
        if row[1] in live_ids
    }
    # Capture year + country per photo: fallback qualifiers when two
    # same-label clusters can't be told apart by scene alone.
    meta = {
        row[0]: (row[1].year if row[1] else None, row[2])
        for row in db.query(Image.id, Image.taken_at, Image.gps_country).filter(
            Image.deleted_at.is_(None)
        )
    }
    return live_ids, paired_raw_ids, meta


def _compute_clusters(sig: tuple) -> None:
    try:
        db = SessionLocal()
        try:
            live_ids, paired_raw_ids, meta = _cluster_inputs(db)
        finally:
            db.close()

        ids: list[str] = []
        vecs: list[np.ndarray] = []
        with engine.connect() as conn:
            for image_id, blob in conn.execute(
                text("SELECT id, embedding FROM image_embeddings")
            ):
                if image_id in live_ids and image_id not in paired_raw_ids:
                    ids.append(image_id)
                    vecs.append(np.frombuffer(blob, dtype=np.float32))

        clusters: list[SmartCluster] = []
        if len(ids) >= MIN_CLUSTER_SIZE:
            clusters = _build_clusters(ids, np.stack(vecs), meta)

        with _state.lock:
            _state.clusters = clusters
            _state.signature = sig
        _save_cache(sig, clusters)
    except Exception:
        # A failed build (e.g. model download offline) must not wedge the
        # endpoint in "building" forever; the next request retries.
        logging.getLogger(__name__).exception("smart album clustering failed")
    finally:
        with _state.lock:
            _state.computing = False


def _build_clusters(
    ids: list[str],
    vecs: np.ndarray,
    meta: dict[str, tuple[int | None, str | None]] | None = None,
) -> list[SmartCluster]:
    # Vectors come out of encode_image normalized, but renormalize defensively:
    # cosine math below assumes unit length.
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    vecs = vecs / norms

    # Pass 1: greedy leader clustering. Each photo joins the nearest existing
    # centroid above the threshold or founds a new one. Order-dependent, but
    # pass 2 below reassigns everything against the final centroids, which
    # smooths most of that out.
    sums: list[np.ndarray] = []
    counts: list[int] = []
    means: list[np.ndarray] = []
    for v in vecs:
        if means:
            m = np.stack(means)
            sims = m @ v
            j = int(np.argmax(sims))
            if sims[j] >= SIMILARITY_THRESHOLD:
                sums[j] += v
                counts[j] += 1
                mean = sums[j] / counts[j]
                means[j] = mean / (np.linalg.norm(mean) or 1.0)
                continue
        sums.append(v.copy())
        counts.append(1)
        means.append(v.copy())

    centroids = np.stack(means)

    # Pass 2: final assignment of every photo to its best centroid.
    sims = vecs @ centroids.T
    best = np.argmax(sims, axis=1)
    best_sim = sims[np.arange(len(ids)), best]
    members: dict[int, list[int]] = {}
    for i, (c, s) in enumerate(zip(best, best_sim)):
        if s >= SIMILARITY_THRESHOLD:
            members.setdefault(int(c), []).append(i)

    # Largest first, so the biggest cluster of a subject claims the plain label
    # name and its smaller siblings get the qualifier; the final list is sorted
    # by name. NOT cut to MAX_CLUSTERS here - the cut is made per subject
    # further down, and needs to know what each cluster is about first.
    kept = sorted(
        (m for m in members.values() if len(m) >= MIN_CLUSTER_SIZE),
        key=len,
        reverse=True,
    )
    if not kept:
        return []

    # Name each cluster zero-shot: its (renormalized) centroid against the
    # label prompts, encoded with the same CLIP model as the images. Scored for
    # every cluster in one matrix product rather than one at a time - there can
    # now be hundreds of candidates, and only the selection below decides which
    # of them the user ever sees.
    label_matrix = _get_label_matrix()
    titles = [title for title, _ in _BUCKETS]
    cluster_centroids = []
    for member_idx in kept:
        centroid = vecs[member_idx].mean(axis=0)
        cluster_centroids.append(centroid / (np.linalg.norm(centroid) or 1.0))
    cluster_centroids = np.stack(cluster_centroids)
    all_label_sims = _bucket_scores(cluster_centroids @ label_matrix.T)

    candidates: list[dict] = []  # still in size order
    for pos, member_idx in enumerate(kept):
        centroid = cluster_centroids[pos]
        best_label = int(np.argmax(all_label_sims[pos]))
        if all_label_sims[pos][best_label] >= LABEL_MIN_SIMILARITY:
            base = titles[best_label]
        else:
            base = "Moments"
        # Cover: the most central photo, i.e. the best single example.
        cover = member_idx[int(np.argmax(vecs[member_idx] @ centroid))]
        candidates.append(
            {"members": member_idx, "centroid": centroid, "base": base, "cover": cover}
        )

    # Which candidates make the section, and this is the part that decides
    # whether the moments describe the LIBRARY or just its busiest weekend.
    #
    # Taking the N biggest clusters spent every slot on whatever there is most
    # of: three days at one bike race are three big, tight clusters, and a
    # library's entire forest, food and street output - hundreds of photos, but
    # in smaller, more varied clusters - could miss the cut completely. So the
    # slots go round-robin over the subjects instead: every subject the library
    # actually contains gets its first moment before any subject gets a second,
    # and only then a third. Within a subject it is still biggest-first.
    by_subject: dict[str, list[int]] = {}
    for i, info in enumerate(candidates):
        by_subject.setdefault(info["base"], []).append(i)

    picked: list[int] = []
    for rank in range(max(len(idxs) for idxs in by_subject.values())):
        if len(picked) >= MAX_CLUSTERS:
            break
        for idxs in by_subject.values():
            if rank < len(idxs):
                picked.append(idxs[rank])
                if len(picked) >= MAX_CLUSTERS:
                    break
    # Back into size order, so the "biggest claims the plain name" rule below
    # still holds for the clusters that were actually selected.
    picked.sort()
    named = [candidates[i] for i in picked]

    # Two clusters can score the same label (e.g. two distinct trips both
    # reading as "Mountains"). They stay one family: every sibling shares the
    # base label as its group and gets a distinguishing qualifier instead of
    # the old "Mountains II" numbering - scene flavor via CLIP ("Alpine",
    # "Mediterranean"), else country, else year, numerals only as last resort.
    by_base: dict[str, list[int]] = {}
    for i, info in enumerate(named):
        by_base.setdefault(info["base"], []).append(i)
    for base, idxs in by_base.items():
        if len(idxs) == 1:
            named[idxs[0]]["name"] = base
            continue
        for i, sibling_name in zip(
            idxs, _sibling_names(base, [named[i] for i in idxs], ids, meta or {})
        ):
            named[i]["name"] = sibling_name

    clusters = [
        SmartCluster(
            name=info["name"],
            image_ids=[ids[i] for i in info["members"]],
            cover_image_id=ids[info["cover"]],
            group=info["base"],
        )
        for info in named
    ]
    clusters.sort(key=lambda c: (c.group.lower(), c.name.lower()))
    return clusters


def _majority(values: list) -> object | None:
    """Most common non-None value, or None when there is none."""
    counts = Counter(v for v in values if v is not None)
    return counts.most_common(1)[0][0] if counts else None


def _sibling_names(
    base: str,
    group: list[dict],
    ids: list[str],
    meta: dict[str, tuple[int | None, str | None]],
) -> list[str]:
    """Distinct display names for same-label clusters, biggest first. Each
    sibling tries, in order: its best free CLIP scene qualifier ("Mountains ·
    Alpine"), its majority country ("Mountains · Austria"), its majority year
    ("Mountains · 2023"), and finally the old numbering ("Mountains II")."""
    names: list[str | None] = [None] * len(group)
    used: set[str] = set()

    qualifier_matrix = _get_qualifier_matrix()
    qualifier_titles = [title for title, _ in _QUALIFIERS]
    for k, info in enumerate(group):
        sims = qualifier_matrix @ info["centroid"]
        for j in np.argsort(-sims):
            if sims[int(j)] < QUALIFIER_MIN_SIMILARITY:
                break
            title = qualifier_titles[int(j)]
            # The broad bucket titles overlap the qualifier words ("Winter",
            # "People"), and "Winter · Winter" says nothing - let the next
            # qualifier down have it.
            if title.lower() in base.lower():
                continue
            if title not in used:
                used.add(title)
                names[k] = f"{base} · {title}"
                break

    for k, info in enumerate(group):
        if names[k] is not None:
            continue
        member_meta = [meta.get(ids[i]) for i in info["members"]]
        country = _majority([m[1] for m in member_meta if m])
        if country and country not in used:
            used.add(country)
            names[k] = f"{base} · {country}"
            continue
        year = _majority([m[0] for m in member_meta if m])
        if year is not None and str(year) not in used:
            used.add(str(year))
            names[k] = f"{base} · {year}"

    counter = 0
    for k in range(len(group)):
        if names[k] is None:
            counter += 1
            names[k] = base if counter == 1 else f"{base} {_roman(counter)}"
    return [name for name in names if name is not None]


def _roman(n: int) -> str:
    numerals = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]
    return numerals[n] if n < len(numerals) else str(n)


# ---------------------------------------------------------------------------
# Time albums


@dataclass
class GroupAlbum:
    id: str
    name: str
    image_count: int
    cover_image_id: str
    # Up to COVER_COUNT member ids (newest first) for the card's mini mosaic.
    cover_image_ids: list[str] = field(default_factory=list)


# How many covers each album card carries for its mosaic preview.
COVER_COUNT = 4


def _push_cover(tops: list, wall, image_id: str) -> None:
    """Keep the newest COVER_COUNT (wall_time, id) pairs, newest first.
    Undated photos sort last, so they only fill in when nothing dated can."""
    tops.append((wall, image_id))
    tops.sort(key=lambda t: (t[0] is not None, t[0] or datetime.min), reverse=True)
    del tops[COVER_COUNT:]


def _cover_ids(jpeg_tops: list, other_tops: list) -> list[str]:
    """Covers for a card's mosaic: JPEGs only - RAWs (which render dark and
    often double a JPEG of the same shot) only when the group has no JPEG."""
    return [i for _, i in (jpeg_tops or other_tops)]


def get_time_albums(db: Session, owner_id: int) -> dict[str, list[GroupAlbum]]:
    """Years, months and "big days", grouped in Python rather than with SQL
    strftime: taken_at strings mix timezone formats (EXIF vs UTC), which
    SQLite's date parsing handles less predictably than the ORM's datetimes."""
    unavailable = sources_service.unavailable_source_ids(db, owner_id)
    query = db.query(Image.id, Image.taken_at, Image.file_type).filter(
        Image.owner_id == owner_id,
        Image.deleted_at.is_(None),
        Image.taken_at.isnot(None),
    )
    query = sources_service.exclude_unavailable(query, unavailable)
    rows = query.all()

    # group key -> [count, jpeg covers, non-jpeg covers], each a newest-first
    # (wall, id) list; the mosaic uses JPEGs and falls back to RAWs only when
    # a group has none (_cover_ids). Comparisons strip tzinfo: EXIF dates are
    # naive, UTC-written ones aware, and Python refuses to compare the two.
    def collect(rows, key_fn):
        groups: dict = {}
        for image_id, taken_at, file_type in rows:
            key = key_fn(taken_at)
            wall = taken_at.replace(tzinfo=None)
            entry = groups.get(key)
            if entry is None:
                entry = groups[key] = [0, [], []]
            entry[0] += 1
            _push_cover(entry[1] if file_type == FileType.jpeg else entry[2], wall, image_id)
        return groups

    def group_album(id: str, name: str, count: int, jpegs: list, others: list) -> GroupAlbum:
        covers = _cover_ids(jpegs, others)
        return GroupAlbum(
            id=id,
            name=name,
            image_count=count,
            cover_image_id=covers[0],
            cover_image_ids=covers,
        )

    years = collect(rows, lambda t: t.year)
    months = collect(rows, lambda t: (t.year, t.month))
    days = collect(rows, lambda t: (t.year, t.month, t.day))

    year_albums = [
        group_album(f"year:{y}", str(y), c, jpegs, others)
        for y, (c, jpegs, others) in sorted(years.items(), reverse=True)
    ]
    month_albums = [
        group_album(f"month:{y:04d}-{m:02d}", f"{calendar.month_name[m]} {y}", c, jpegs, others)
        for (y, m), (c, jpegs, others) in sorted(months.items(), reverse=True)
        if c >= MIN_MONTH_PHOTOS
    ]

    day_counts = [c for c, _, _ in days.values()]
    big_day_albums: list[GroupAlbum] = []
    if day_counts:
        median = float(np.median(day_counts))
        threshold = max(BIG_DAY_MIN_PHOTOS, BIG_DAY_MEDIAN_FACTOR * median)
        big_days = sorted(
            ((k, v) for k, v in days.items() if v[0] >= threshold),
            key=lambda kv: kv[0],
            reverse=True,
        )[:MAX_BIG_DAYS]
        big_day_albums = [
            group_album(
                f"day:{y:04d}-{m:02d}-{d:02d}", f"{calendar.month_name[m]} {d}, {y}", c, jpegs, others
            )
            for (y, m, d), (c, jpegs, others) in big_days
        ]

    return {"years": year_albums, "months": month_albums, "days": big_day_albums}


# ---------------------------------------------------------------------------
# Place albums


def get_place_albums(db: Session, owner_id: int, radius_km: float) -> list[GroupAlbum]:
    """Spatial clusters of the geotagged photos, named via the offline
    reverse-geocoding cities database. Greedy leader clustering on distance
    finds the centers; final membership is simply "within radius_km of
    the center" - the same rule the images endpoint applies to the center
    encoded in the album id, so the count always matches what opening the
    album shows (a photo between two nearby centers may appear in both)."""
    unavailable = sources_service.unavailable_source_ids(db, owner_id)
    query = db.query(
        Image.id, Image.taken_at, Image.gps_lat, Image.gps_lon, Image.file_type
    ).filter(
        Image.owner_id == owner_id,
        Image.deleted_at.is_(None),
        Image.gps_lat.isnot(None),
        Image.gps_lon.isnot(None),
    )
    rows = sources_service.exclude_unavailable(query, unavailable).all()
    if len(rows) < MIN_PLACE_PHOTOS:
        return []

    lats = np.array([r[2] for r in rows], dtype=np.float64)
    lons = np.array([r[3] for r in rows], dtype=np.float64)

    # Greedy leader pass: join the nearest existing center within the radius
    # (tracked as a running mean) or found a new one. The distance to every
    # center is vectorized, so this stays cheap even for big travel libraries.
    center_lats: list[float] = []
    center_lons: list[float] = []
    sums: list[tuple[float, float, int]] = []
    for lat, lon in zip(lats, lons):
        if center_lats:
            dists = _haversine_km_vec(
                np.array(center_lats), np.array(center_lons), lat, lon
            )
            i = int(np.argmin(dists))
            if dists[i] <= radius_km:
                s_lat, s_lon, n = sums[i]
                sums[i] = (s_lat + lat, s_lon + lon, n + 1)
                center_lats[i] = sums[i][0] / (n + 1)
                center_lons[i] = sums[i][1] / (n + 1)
                continue
        center_lats.append(float(lat))
        center_lons.append(float(lon))
        sums.append((float(lat), float(lon), 1))

    # Final membership by radius around the settled centers.
    places: list[tuple[tuple[float, float], int, list]] = []  # (center, count, covers)
    for c_lat, c_lon in zip(center_lats, center_lons):
        member_idx = np.nonzero(
            _haversine_km_vec(lats, lons, c_lat, c_lon) <= radius_km
        )[0]
        if len(member_idx) < MIN_PLACE_PHOTOS:
            continue
        jpeg_tops: list = []
        other_tops: list = []
        for i in member_idx:
            image_id, taken_at, file_type = rows[i][0], rows[i][1], rows[i][4]
            wall = taken_at.replace(tzinfo=None) if taken_at else None
            _push_cover(jpeg_tops if file_type == FileType.jpeg else other_tops, wall, image_id)
        places.append(((c_lat, c_lon), len(member_idx), _cover_ids(jpeg_tops, other_tops)))

    places.sort(key=lambda p: p[1], reverse=True)
    places = places[:MAX_PLACES]
    if not places:
        return []

    labels = geocode.place_labels_for([center for center, _, _ in places])
    albums: list[GroupAlbum] = []
    used_names: dict[str, int] = {}
    for (center, count, covers), label in zip(places, labels):
        name = label or f"{center[0]:.3f}, {center[1]:.3f}"
        used_names[name] = used_names.get(name, 0) + 1
        if used_names[name] > 1:
            name = f"{name} {_roman(used_names[name])}"
        albums.append(
            GroupAlbum(
                id=f"place:{center[0]:.4f},{center[1]:.4f}",
                name=name,
                image_count=count,
                cover_image_id=covers[0],
                cover_image_ids=covers,
            )
        )
    return albums


def get_country_albums(db: Session, owner_id: int) -> dict[str, list[GroupAlbum]]:
    """One album per country (from the gps_country annotated at import), plus
    the country x year split ("Italy 2024"). Returned together - both come out
    of the same single-pass grouping."""
    unavailable = sources_service.unavailable_source_ids(db, owner_id)
    query = db.query(Image.id, Image.taken_at, Image.gps_country, Image.file_type).filter(
        Image.owner_id == owner_id,
        Image.deleted_at.is_(None),
        Image.gps_country.isnot(None),
    )
    rows = sources_service.exclude_unavailable(query, unavailable).all()

    # key -> [count, jpeg covers, non-jpeg covers] (newest-first (wall, id))
    countries: dict[str, list] = {}
    country_years: dict[tuple[str, int], list] = {}

    def bump(groups: dict, key, image_id, wall, file_type) -> None:
        entry = groups.get(key)
        if entry is None:
            entry = groups[key] = [0, [], []]
        entry[0] += 1
        _push_cover(entry[1] if file_type == FileType.jpeg else entry[2], wall, image_id)

    for image_id, taken_at, country, file_type in rows:
        wall = taken_at.replace(tzinfo=None) if taken_at else None
        bump(countries, country, image_id, wall, file_type)
        if taken_at is not None:
            bump(country_years, (country, taken_at.year), image_id, wall, file_type)

    def country_album(id: str, name: str, count: int, jpegs: list, others: list) -> GroupAlbum:
        covers = _cover_ids(jpegs, others)
        return GroupAlbum(
            id=id,
            name=name,
            image_count=count,
            cover_image_id=covers[0],
            cover_image_ids=covers,
        )

    country_albums = [
        country_album(f"country:{name}", name, c, jpegs, others)
        for name, (c, jpegs, others) in sorted(
            countries.items(), key=lambda kv: kv[1][0], reverse=True
        )
    ]
    year_split = sorted(
        (kv for kv in country_years.items() if kv[1][0] >= MIN_COUNTRY_YEAR_PHOTOS),
        # Newest year first, biggest first within a year.
        key=lambda kv: (kv[0][1], kv[1][0]),
        reverse=True,
    )[:MAX_COUNTRY_YEARS]
    country_year_albums = [
        country_album(f"country-year:{name}:{year}", f"{name} {year}", c, jpegs, others)
        for (name, year), (c, jpegs, others) in year_split
    ]
    return {"countries": country_albums, "country_years": country_year_albums}


def get_tag_albums(db: Session, owner_id: int) -> list[GroupAlbum]:
    """One virtual album per tag ("albums by tag"): every live photo carrying
    the tag, biggest tags first. Same cover rules as the other sections."""
    unavailable = sources_service.unavailable_source_ids(db, owner_id)
    query = (
        db.query(Image.id, Image.taken_at, Tag.name, Image.file_type)
        .join(ImageTag, ImageTag.image_id == Image.id)
        .join(Tag, Tag.id == ImageTag.tag_id)
        .filter(
            Image.owner_id == owner_id,
            Image.deleted_at.is_(None),
            Tag.owner_id == owner_id,
        )
    )
    rows = sources_service.exclude_unavailable(query, unavailable).all()

    # tag -> [count, jpeg covers, non-jpeg covers] (newest-first (wall, id))
    groups: dict[str, list] = {}
    for image_id, taken_at, tag_name, file_type in rows:
        wall = taken_at.replace(tzinfo=None) if taken_at else None
        entry = groups.get(tag_name)
        if entry is None:
            entry = groups[tag_name] = [0, [], []]
        entry[0] += 1
        _push_cover(entry[1] if file_type == FileType.jpeg else entry[2], wall, image_id)

    albums = []
    for name, (count, jpegs, others) in sorted(
        groups.items(), key=lambda kv: (-kv[1][0], kv[0].lower())
    ):
        covers = _cover_ids(jpegs, others)
        albums.append(
            GroupAlbum(
                id=f"tag:{name}",
                name=name,
                image_count=count,
                cover_image_id=covers[0],
                cover_image_ids=covers,
            )
        )
    return albums


def edited_filter():
    """The membership rule for the "Edited" smart album: photos edited in
    place (edit_rev bumps on every develop save) plus saved edit copies
    (applied_adjustments records the look that was baked into the copy)."""
    return or_(Image.edit_rev > 0, Image.applied_adjustments.isnot(None))


def get_edits_album(db: Session, owner_id: int) -> list[GroupAlbum]:
    """A single virtual album collecting every edited photo and edit copy.
    Empty list when nothing has been edited yet, so the row hides itself."""
    unavailable = sources_service.unavailable_source_ids(db, owner_id)
    query = db.query(Image.id).filter(
        Image.owner_id == owner_id,
        Image.deleted_at.is_(None),
        edited_filter(),
    )
    query = sources_service.exclude_unavailable(query, unavailable)
    count = query.count()
    if not count:
        return []
    ordered = query.order_by(
        Image.taken_at.desc(), Image.original_filename.desc(), Image.id.desc()
    )
    # JPEGs only in the mosaic; RAWs only when no edited JPEG exists.
    covers = ordered.filter(Image.file_type == FileType.jpeg).limit(COVER_COUNT).all()
    if not covers:
        covers = ordered.limit(COVER_COUNT).all()
    cover_ids = [row[0] for row in covers]
    return [
        GroupAlbum(
            id="edits:all",
            name="Edited photos",
            image_count=count,
            cover_image_id=cover_ids[0],
            cover_image_ids=cover_ids,
        )
    ]


def place_image_ids(
    db: Session, owner_id: int, lat: float, lon: float, radius_km: float, unavailable: list[str]
) -> list[str]:
    """Ids of the photos belonging to the place centered at (lat, lon) - the
    membership rule shared by the list above and the images endpoint."""
    query = db.query(Image.id, Image.gps_lat, Image.gps_lon).filter(
        Image.owner_id == owner_id,
        Image.deleted_at.is_(None),
        Image.gps_lat.isnot(None),
        Image.gps_lon.isnot(None),
    )
    rows = sources_service.exclude_unavailable(query, unavailable).all()
    if not rows:
        return []
    r_lats = np.array([r[1] for r in rows], dtype=np.float64)
    r_lons = np.array([r[2] for r in rows], dtype=np.float64)
    inside = _haversine_km_vec(r_lats, r_lons, lat, lon) <= radius_km
    return [rows[i][0] for i in np.nonzero(inside)[0]]


def _haversine_km_vec(
    lats: np.ndarray, lons: np.ndarray, lat: float, lon: float
) -> np.ndarray:
    """Great-circle distance (km) from one point to arrays of points."""
    lat1, lon1 = np.radians(lats), np.radians(lons)
    lat2, lon2 = np.radians(lat), np.radians(lon)
    a = (
        np.sin((lat2 - lat1) / 2) ** 2
        + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    )
    return 6371.0 * 2 * np.arcsin(np.sqrt(a))

"""Offline geo lookups, no network calls:

- reverse: a photo's GPS fix -> country name, for the region filter.
- forward: a place name typed in the search bar -> coordinates, so results can
  be sorted by distance to that place.

Both reuse `reverse_geocoder`'s bundled cities database; `pycountry` maps the
ISO country code to a display name. The datasets load into memory on first use.
"""

from __future__ import annotations

import csv
import logging
import math
import os
import threading
from dataclasses import dataclass

import pycountry

logger = logging.getLogger(__name__)

_warm_started = False


def warm_in_background() -> None:
    """Load the reverse-geocoding dataset on a daemon thread. reverse_geocoder
    parses a ~25MB cities CSV and builds its k-d tree on first use ("Loading
    formatted geocoded file..."), which otherwise happens *inside* the first
    import commit after every backend start - a noticeable stall in the
    desktop app, where the backend is relaunched with the app. rg.search()
    memoises the loaded tree module-globally, so one throwaway query here
    makes every later commit's lookup instant."""
    global _warm_started
    if _warm_started:
        return
    _warm_started = True

    def _warm() -> None:
        try:
            import reverse_geocoder as rg

            rg.search([(0.0, 0.0)], mode=1)
        except Exception:  # pragma: no cover - missing dataset already handled per-lookup
            logger.exception("Reverse-geocoder warm-up failed")

    threading.Thread(target=_warm, name="geocode-warm", daemon=True).start()

# Sentinel region value meaning "photos with no location at all", so the region
# filter can offer an explicit "no location" bucket alongside real countries.
NO_LOCATION = "__none__"


def _country_name(cc: str | None) -> str | None:
    if not cc:
        return None
    match = pycountry.countries.get(alpha_2=cc)
    # Fall back to the raw code for entries pycountry doesn't carry (e.g. "XK").
    return match.name if match else cc


def country_for(lat: float, lon: float) -> str | None:
    """Country name for a single coordinate, or None if it can't be resolved."""
    results = countries_for([(lat, lon)])
    return results[0] if results else None


def countries_for(coords: list[tuple[float, float]]) -> list[str | None]:
    """Country name for each (lat, lon), in order. Batched into one k-d tree
    query. Returns a list the same length as `coords` (None where a point can't
    be resolved or the lookup fails)."""
    if not coords:
        return []
    try:
        # Imported lazily so merely importing this module doesn't pull the
        # dataset into memory (and so environments without it still start).
        import reverse_geocoder as rg

        # mode=1 is single-threaded: safe under the API's worker threads and
        # plenty fast for the batch sizes we hand it.
        hits = rg.search(coords, mode=1)
    except Exception:  # pragma: no cover - dataset/load failures shouldn't break import
        logger.exception("Reverse geocoding failed for %d point(s)", len(coords))
        return [None] * len(coords)
    return [_country_name(hit.get("cc")) for hit in hits]


def annotate_images(images) -> int:
    """Fill in `gps_country` for any of `images` that have a GPS fix but no
    region yet, batched into a single lookup. Duck-typed on the Image ORM object
    (gps_lat / gps_lon / gps_country) so this module stays model-free. Returns
    how many were newly resolved; the caller commits."""
    pending = [
        im
        for im in images
        if im.gps_lat is not None and im.gps_lon is not None and not im.gps_country
    ]
    if not pending:
        return 0
    names = countries_for([(im.gps_lat, im.gps_lon) for im in pending])
    resolved = 0
    for im, name in zip(pending, names):
        if name:
            im.gps_country = name
            resolved += 1
    return resolved


# --- Forward geocoding (place name -> coordinates) -------------------------


@dataclass(frozen=True)
class Place:
    name: str
    lat: float
    lon: float
    country: str | None

    @property
    def label(self) -> str:
        return f"{self.name}, {self.country}" if self.country else self.name


# Lowercased city name -> list of candidate rows. Built once from the same
# cities file reverse_geocoder ships (columns: lat, lon, name, admin1, admin2, cc).
_city_index: dict[str, list[dict]] | None = None


def _load_city_index() -> dict[str, list[dict]]:
    global _city_index
    if _city_index is not None:
        return _city_index
    index: dict[str, list[dict]] = {}
    try:
        import reverse_geocoder

        path = os.path.join(os.path.dirname(reverse_geocoder.__file__), "rg_cities1000.csv")
        with open(path, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                try:
                    lat, lon = float(row["lat"]), float(row["lon"])
                except (TypeError, ValueError, KeyError):
                    continue
                index.setdefault(row["name"].strip().lower(), []).append(
                    {"name": row["name"], "lat": lat, "lon": lon, "admin1": row["admin1"], "cc": row["cc"]}
                )
    except Exception:  # pragma: no cover - a missing/broken dataset just disables place search
        logger.exception("Could not load the cities dataset for forward geocoding")
    _city_index = index
    return index


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance between two (lat, lon) points, in kilometres."""
    lat1, lon1 = a
    lat2, lon2 = b
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def place_candidates(query: str) -> list[Place]:
    """Cities whose name matches `query`. Accepts a bare name ("rome") or a
    qualified one ("rome, italy" / "rome, it" / "rome, latium"); the qualifier,
    when present, narrows by country code, country name, or admin region. Cheap:
    a dict lookup, so callers can gate the (heavier) proximity work on a match."""
    q = (query or "").strip().lower()
    if not q:
        return []
    parts = [p.strip() for p in q.split(",")]
    # Exact name match only: predictable, and it still disambiguates same-named
    # places by proximity below. (A photo-less noun that happens to be a city
    # name will switch to location mode - the accepted trade-off of auto-detect.
    # A city stored under a longer official name, e.g. "New York City", needs to
    # be typed in full; a partial like "new york" falls through to text search.)
    rows = _load_city_index().get(parts[0])
    if not rows:
        return []
    qualifier = parts[1] if len(parts) > 1 and parts[1] else None
    out: list[Place] = []
    for r in rows:
        country = _country_name(r["cc"])
        if qualifier and qualifier not in {
            r["cc"].lower(),
            (country or "").lower(),
            r["admin1"].lower(),
        }:
            continue
        out.append(Place(name=r["name"], lat=r["lat"], lon=r["lon"], country=country))
    return out


def resolve_place(query: str, near: tuple[float, float] | None = None) -> Place | None:
    """Best single place for `query`. When the name is ambiguous (e.g. Rome, IT
    vs Rome, GA) and `near` is given, pick the candidate closest to it - so a
    library shot mostly in Europe resolves "rome" to Rome, Italy."""
    candidates = place_candidates(query)
    if not candidates:
        return None
    if near is None or len(candidates) == 1:
        return candidates[0]
    return min(candidates, key=lambda p: haversine_km(near, (p.lat, p.lon)))

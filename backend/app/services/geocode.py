"""Offline geo lookups, no network calls:

- reverse: a photo's GPS fix -> country name, for the region filter.
- forward: a place name typed in the search bar -> coordinates, so results can
  be sorted by distance to that place.

Both reuse `reverse_geocoder`'s bundled cities database; `pycountry` maps the
ISO country code to a display name. The datasets load into memory on first use.
"""

from __future__ import annotations

import csv
import gettext
import logging
import math
import os
import threading
import unicodedata
from dataclasses import dataclass
from functools import lru_cache

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


def place_labels_for(coords: list[tuple[float, float]]) -> list[str | None]:
    """"City, Country" display label for each (lat, lon) - e.g.
    "Munich, Germany" - from the nearest entry in the bundled cities database.
    Batched into one k-d tree query; None where a point can't be resolved."""
    if not coords:
        return []
    try:
        import reverse_geocoder as rg

        hits = rg.search(coords, mode=1)
    except Exception:  # pragma: no cover - dataset/load failures shouldn't break callers
        logger.exception("Reverse geocoding failed for %d point(s)", len(coords))
        return [None] * len(coords)
    labels: list[str | None] = []
    for hit in hits:
        city = hit.get("name")
        country = _country_name(hit.get("cc"))
        labels.append(", ".join(p for p in (city, country) if p) or None)
    return labels


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


# --- Query-language helpers -------------------------------------------------


def _norm(s: str) -> str:
    """Normalise a name for matching: lowercase, strip diacritics, and read
    punctuation as word breaks - so "Zürich"/"zurich" meet on one key, and
    "Halle (Saale)" / "halle saale" or "Corsanico-Bargecchia" /
    "corsanico bargecchia" do too."""
    folded = unicodedata.normalize("NFKD", (s or "").lower())
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    return " ".join("".join(c if c.isalnum() else " " for c in folded).split())

# pycountry ships gettext translations for country names (ISO 3166-1); build a
# reverse lookup "translated name -> alpha-2" per UI language, so a German
# user's "Italien" finds the photos stored under gps_country "Italy".
@lru_cache(maxsize=8)
def _country_translations(lang: str) -> dict[str, str]:
    try:
        tr = gettext.translation("iso3166-1", pycountry.LOCALES_DIR, languages=[lang])
    except (FileNotFoundError, OSError):
        return {}
    return {_norm(tr.gettext(c.name)): c.alpha_2 for c in pycountry.countries}


def country_from_query(query: str, lang: str | None = None) -> str | None:
    """The stored gps_country display name for a query that names a country -
    in English ("italy") or the caller's UI language ("italien"). Diacritics
    are optional ("osterreich" finds Österreich). None when the query isn't a
    country name."""
    qn = _norm(query or "")
    if not qn:
        return None
    for c in pycountry.countries:
        names = {c.name, getattr(c, "common_name", None), getattr(c, "official_name", None)}
        if qn in {_norm(n) for n in names if n}:
            return _country_name(c.alpha_2)
    if lang:
        cc = _country_translations(lang.split("-")[0].lower()).get(qn)
        if cc:
            return _country_name(cc)
    return None


# The cities dataset stores English exonyms ("Munich", "Cologne"); map the
# common German names onto them so a German-language user finds their photos.
# Small and curated on purpose - names identical in both languages (Berlin,
# Paris, Madrid) need no entry.
_CITY_EXONYMS_DE = {
    "münchen": "munich", "köln": "cologne", "nürnberg": "nuremberg", "wien": "vienna",
    "zürich": "zurich", "genf": "geneva", "brüssel": "brussels", "antwerpen": "antwerp",
    "den haag": "the hague", "rom": "rome", "mailand": "milan", "venedig": "venice",
    "florenz": "florence", "neapel": "naples", "genua": "genoa", "nizza": "nice",
    "prag": "prague", "warschau": "warsaw", "krakau": "krakow", "moskau": "moscow",
    "sankt petersburg": "saint petersburg", "kiew": "kyiv", "athen": "athens",
    "lissabon": "lisbon", "kopenhagen": "copenhagen", "bukarest": "bucharest",
    "belgrad": "belgrade", "tokio": "tokyo", "peking": "beijing", "kairo": "cairo",
    "havanna": "havana", "kapstadt": "cape town", "singapur": "singapore",
    "sevilla": "seville", "neu-delhi": "new delhi",
}


@lru_cache(maxsize=1)
def _city_exonyms_de_normalised() -> dict[str, str]:
    # Keyed by _norm so "münchen", "munchen" and (via the ue->u variant tried
    # by the caller) "muenchen" all reach the same entry.
    return {_norm(k): v for k, v in _CITY_EXONYMS_DE.items()}


def _localized_city_names(name: str, lang: str | None) -> list[str]:
    """The dataset lookup keys to try for a city name typed in the UI
    language: the name itself, plus its English exonym when known. For German
    also the umlaut-digraph reading, both against the dataset ("luebeck" ->
    "Lübeck") and the exonym map ("muenchen" -> "münchen" -> "munich")."""
    names = [name]
    if lang and lang.split("-")[0].lower() == "de":
        digraph = name.replace("ae", "ä").replace("oe", "ö").replace("ue", "ü")
        if digraph != name:
            names.append(digraph)
        exonyms = _city_exonyms_de_normalised()
        for key in (_norm(name), _norm(digraph)):
            exonym = exonyms.get(key)
            if exonym and exonym not in names:
                names.append(exonym)
    return names


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


# Normalised city name (see _norm) -> list of candidate rows. Built once from
# the same cities file reverse_geocoder ships (columns: lat, lon, name,
# admin1, admin2, cc).
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
                index.setdefault(_norm(row["name"]), []).append(
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


# Cap for the whole-word-prefix fallback below, so a very generic start of a
# name ("saint") can't flood the candidate list.
_MAX_PREFIX_ROWS = 20


def _rows_for_name(name: str, lang: str | None) -> list[dict] | None:
    """Dataset rows for a city name: exact (normalised) matches plus
    whole-word-prefix matches, via the UI language's exonyms where known. The
    prefix rows ride along even when an exact name exists - "halle" must offer
    "Halle (Saale)" and "Halle Neustadt" next to Belgium's "Halle", so the
    caller's proximity ranking can pick the one near the user's photos.
    Partial words never match ("florenc" won't hit "Florence"), keeping
    ordinary text searches out of location mode."""
    index = _load_city_index()
    keys = [_norm(n) for n in _localized_city_names(name, lang)]
    rows: list[dict] = []
    for key in keys:
        rows.extend(index.get(key, []))
    for key in keys:
        if len(key) < 4:
            continue
        prefix = key + " "
        extra = [r for k, rs in index.items() if k.startswith(prefix) for r in rs]
        rows.extend(extra[:_MAX_PREFIX_ROWS])
    # The same row can arrive via several keys (exonym + digraph variant).
    seen: set[tuple] = set()
    unique = []
    for r in rows:
        marker = (r["name"], r["lat"], r["lon"])
        if marker not in seen:
            seen.add(marker)
            unique.append(r)
    return unique or None


def _qualifier_matches(row: dict, qualifier_norm: str, lang: str | None) -> bool:
    """Whether "italy" / "it" / "latium" / the UI language's country name
    ("italien") describes this dataset row."""
    country = _country_name(row["cc"])
    if qualifier_norm in {_norm(row["cc"]), _norm(country or ""), _norm(row["admin1"] or "")}:
        return True
    if lang:
        cc = _country_translations(lang.split("-")[0].lower()).get(qualifier_norm)
        if cc and cc.lower() == row["cc"].lower():
            return True
    return False


def place_candidates(query: str, lang: str | None = None) -> list[Place]:
    """Cities whose name matches `query`. Accepts a bare name ("rome"), a
    comma-qualified one ("rome, italy" / "rome, it" / "rome, latium"), or the
    qualifier just appended ("rome italy") - the qualifier narrows by country
    code, country name (English or UI language), or admin region. Diacritics
    are optional on both sides, and a whole-word prefix still matches ("new
    york" finds "New York City"). Cheap dict work, so callers can gate the
    (heavier) proximity ranking on a match. (A photo-less noun that happens to
    be a city name will switch to location mode - the accepted trade-off of
    auto-detect.)"""
    q = (query or "").strip()
    if not q:
        return []
    parts = [p.strip() for p in q.split(",")]
    name = parts[0].lower()
    qualifier = _norm(parts[1]) if len(parts) > 1 and parts[1] else None

    rows = _rows_for_name(name, lang)
    if rows and qualifier:
        rows = [r for r in rows if _qualifier_matches(r, qualifier, lang)]
    if not rows and qualifier is None:
        # "florence italy" typed without the comma: peel trailing words off as
        # a qualifier - only accepted when they really name the row's country
        # or region, so multi-word city names themselves stay unaffected.
        tokens = name.split()
        for i in range(len(tokens) - 1, 0, -1):
            base_rows = _rows_for_name(" ".join(tokens[:i]), lang)
            if not base_rows:
                continue
            qual = _norm(" ".join(tokens[i:]))
            matching = [r for r in base_rows if _qualifier_matches(r, qual, lang)]
            if matching:
                rows = matching
                break
    if not rows:
        return []
    return [
        Place(name=r["name"], lat=r["lat"], lon=r["lon"], country=_country_name(r["cc"]))
        for r in rows
    ]


def resolve_place(
    query: str, near: tuple[float, float] | None = None, lang: str | None = None
) -> Place | None:
    """Best single place for `query`. When the name is ambiguous (e.g. Rome, IT
    vs Rome, GA) and `near` is given, pick the candidate closest to it - so a
    library shot mostly in Europe resolves "rome" to Rome, Italy."""
    candidates = place_candidates(query, lang=lang)
    if not candidates:
        return None
    if near is None or len(candidates) == 1:
        return candidates[0]
    return min(candidates, key=lambda p: haversine_km(near, (p.lat, p.lon)))

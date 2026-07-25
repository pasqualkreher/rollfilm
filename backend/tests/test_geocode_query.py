"""Forward geocoding of search-bar queries: city/place names must match with
optional diacritics, appended country qualifiers, and whole-word prefixes."""

import pytest

from app.services import geocode

# Loading the cities dataset needs the reverse_geocoder package data; skip the
# whole module gracefully where it's unavailable.
pytest.importorskip("reverse_geocoder")


def _names(places):
    return {p.name for p in places}


def test_exact_city_match():
    assert "Florence" in _names(geocode.place_candidates("florence"))


def test_diacritics_are_optional_both_ways():
    # Dataset name carries the accent, the query doesn't ...
    assert any(p.country == "Spain" for p in geocode.place_candidates("malaga"))
    # ... and the other way around: an accented query finds the plain name.
    assert "Zurich" in _names(geocode.place_candidates("zürich"))


def test_comma_qualifier_still_narrows():
    places = geocode.place_candidates("rome, italy")
    assert places and all(p.country == "Italy" for p in places)


def test_qualifier_without_comma():
    places = geocode.place_candidates("rome italy")
    assert places and all(p.country == "Italy" for p in places)


def test_translated_qualifier():
    places = geocode.place_candidates("rom italien", lang="de-DE")
    assert places and all(p.country == "Italy" for p in places)


def test_whole_word_prefix_matches_longer_official_name():
    assert "New York City" in _names(geocode.place_candidates("new york"))


def test_punctuation_in_dataset_names_is_optional():
    # Dataset stores "Halle (Saale)" - the query has no parentheses.
    assert "Halle (Saale)" in _names(geocode.place_candidates("halle saale"))


def test_prefix_matches_ride_along_with_exact_ones():
    # "halle" matches Belgium's "Halle" exactly, but must ALSO offer
    # "Halle (Saale)" / "Halle Neustadt" so proximity can pick the right one.
    names = _names(geocode.place_candidates("halle"))
    assert "Halle" in names
    assert "Halle (Saale)" in names
    assert "Halle Neustadt" in names


def test_partial_word_does_not_match():
    # "florenc" must NOT silently become Florence - partials fall through to
    # the normal text search instead of hijacking location mode.
    assert "Florence" not in _names(geocode.place_candidates("florenc"))


def test_german_exonym_and_digraph():
    assert "Munich" in _names(geocode.place_candidates("münchen", lang="de-DE"))
    assert "Munich" in _names(geocode.place_candidates("muenchen", lang="de-DE"))


def test_country_query_ignores_diacritics():
    assert geocode.country_from_query("osterreich", lang="de-DE") == "Austria"
    assert geocode.country_from_query("italien", lang="de-DE") == "Italy"
    assert geocode.country_from_query("italy") == "Italy"

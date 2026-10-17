"""A source root on a hung network mount must not hang every library request:
the availability probe is time-boxed and its answer cached for a moment."""

import time
from pathlib import Path

from app.services import sources


def test_a_hung_probe_answers_unavailable_within_the_limit(monkeypatch, tmp_path):
    sources.clear_availability_cache()
    monkeypatch.setattr(sources, "PROBE_TIMEOUT_S", 0.2)

    def slow_is_dir(self):
        time.sleep(2)
        return True

    monkeypatch.setattr(Path, "is_dir", slow_is_dir)
    started = time.monotonic()
    assert sources.is_path_available(str(tmp_path / "nas")) is False
    assert time.monotonic() - started < 1.0


def test_answers_are_cached_for_a_moment(monkeypatch, tmp_path):
    sources.clear_availability_cache()
    calls = []

    def counting_is_dir(self):
        calls.append(self)
        return True

    monkeypatch.setattr(Path, "is_dir", counting_is_dir)
    root = str(tmp_path)
    assert sources.is_path_available(root) is True
    assert sources.is_path_available(root) is True
    assert len(calls) == 1
    sources.clear_availability_cache()
    assert sources.is_path_available(root) is True
    assert len(calls) == 2


def test_a_real_folder_is_available_and_a_missing_one_is_not(tmp_path):
    sources.clear_availability_cache()
    assert sources.is_path_available(str(tmp_path)) is True
    assert sources.is_path_available(str(tmp_path / "gone")) is False

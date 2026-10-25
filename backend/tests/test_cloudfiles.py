"""Cloud placeholders are only looked for where they can exist: a folder
under a provider's root. An external drive is never walked for them."""

import threading

from app.services import cloudfiles


def test_only_folders_under_a_provider_root_count_as_cloud_synced(tmp_path, monkeypatch):
    cloud = tmp_path / "Library" / "CloudStorage"
    (cloud / "Nextcloud-me").mkdir(parents=True)
    monkeypatch.setattr(cloudfiles, "_cloud_roots", lambda: [cloud])
    assert cloudfiles.is_cloud_synced(cloud / "Nextcloud-me")
    assert cloudfiles.is_cloud_synced(cloud / "Nextcloud-me" / "deeper")
    assert not cloudfiles.is_cloud_synced(tmp_path / "Volumes" / "LaCie" / "thumbnails")
    assert not cloudfiles.is_cloud_synced(tmp_path)


def test_an_external_folder_is_never_walked(tmp_path, monkeypatch):
    cloud = tmp_path / "CloudStorage"
    synced = cloud / "iCloud" / "cache"
    synced.mkdir(parents=True)
    (synced / "a.jpg").write_bytes(b"x")
    outside = tmp_path / "LaCie" / "cache"
    outside.mkdir(parents=True)
    (outside / "b.jpg").write_bytes(b"x")
    monkeypatch.setattr(cloudfiles, "_cloud_roots", lambda: [cloud])
    monkeypatch.setattr(cloudfiles, "_PLACEHOLDERS_POSSIBLE", True)
    looked_at: list[str] = []
    monkeypatch.setattr(cloudfiles, "is_dataless", lambda p: looked_at.append(str(p)) or False)
    started: list[threading.Thread] = []
    real_thread = threading.Thread

    class _Recorded(real_thread):
        def start(self):
            started.append(self)
            super().start()

    monkeypatch.setattr(cloudfiles.threading, "Thread", _Recorded)
    cloudfiles.rehydrate_dirs_in_background(outside)
    assert started == [] and looked_at == []
    cloudfiles.rehydrate_dirs_in_background(outside, synced)
    assert len(started) == 1
    started[0].join(5.0)
    assert looked_at == [str(synced / "a.jpg")]

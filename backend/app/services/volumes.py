"""Which volume a folder sits on, and where that volume is mounted now.

An import session remembers the card it was started on. A path alone can't do
that: macOS mounts every unnamed card as /Volumes/Untitled (and the second one
as "Untitled 1"), so the same path can be a different card tomorrow and the
same card can come back under a different path. The volume's UUID (macOS) or
serial number (Windows) is what actually identifies it.

Best effort throughout: where the identity can't be read, callers fall back to
the path alone - which is exactly how the import behaved before sessions."""

from __future__ import annotations

import logging
import os
import plistlib
import string
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class VolumeInfo:
    mount: str
    uuid: str | None
    name: str | None


def _mount_point(path: Path) -> Path:
    p = path.resolve()
    while not os.path.ismount(p) and p.parent != p:
        p = p.parent
    return p


def _diskutil_info(path: str) -> dict | None:
    try:
        out = subprocess.run(
            ["diskutil", "info", "-plist", path],
            capture_output=True,
            timeout=5,
            check=True,
        ).stdout
        return plistlib.loads(out)
    except Exception:
        return None


def _windows_volume(path: str) -> VolumeInfo | None:
    import ctypes

    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    root_buf = ctypes.create_unicode_buffer(261)
    if not kernel32.GetVolumePathNameW(path, root_buf, len(root_buf)):
        return None
    name_buf = ctypes.create_unicode_buffer(261)
    serial = ctypes.c_uint32()
    if not kernel32.GetVolumeInformationW(
        root_buf.value, name_buf, len(name_buf), ctypes.byref(serial), None, None, None, 0
    ):
        return VolumeInfo(mount=root_buf.value, uuid=None, name=None)
    return VolumeInfo(
        mount=root_buf.value, uuid=f"{serial.value:08X}", name=name_buf.value or None
    )


def volume_of(path: str | Path) -> VolumeInfo | None:
    """The volume `path` lives on, or None when the path doesn't exist."""
    p = Path(path)
    if not p.exists():
        return None
    try:
        if sys.platform == "win32":
            return _windows_volume(str(p))
        mount = _mount_point(p)
        # The system disk is never "the card": its identity is the system
        # snapshot's UUID, which changes with every macOS update - a session on
        # a folder of the internal disk goes by its path, which is stable there.
        if sys.platform == "darwin" and str(mount) != "/":
            # diskutil only answers for a mount point, not a folder inside one.
            info = _diskutil_info(str(mount))
            if info:
                return VolumeInfo(
                    mount=info.get("MountPoint") or str(mount),
                    uuid=info.get("VolumeUUID") or info.get("DiskUUID") or None,
                    name=info.get("VolumeName") or None,
                )
        return VolumeInfo(mount=str(mount), uuid=None, name=mount.name or None)
    except Exception:
        logger.exception("Could not identify the volume of %s", p)
        return None


def _candidate_mounts() -> list[str]:
    if sys.platform == "darwin":
        try:
            return [str(Path("/Volumes") / n) for n in os.listdir("/Volumes")]
        except OSError:
            return []
    if sys.platform == "win32":
        return [f"{d}:\\" for d in string.ascii_uppercase if os.path.exists(f"{d}:\\")]
    return []


def find_mount(uuid: str) -> str | None:
    """Where the volume with this identity is mounted right now, if anywhere."""
    for mount in _candidate_mounts():
        info = volume_of(mount)
        if info is not None and info.uuid == uuid:
            return info.mount
    return None


def resolve_source_root(
    source_root: str | None, volume_mount: str | None, volume_uuid: str | None
) -> Path | None:
    """The folder a session was started on, as reachable right now - or None
    when its volume isn't connected.

    The recorded path wins when it exists and is on the recorded volume. When
    it isn't (card mounted under another name, or another card under this one),
    the volume is looked up by identity and the folder found at the same place
    on it."""
    if not source_root:
        return None
    root = Path(source_root)
    if not volume_uuid:
        return root if root.is_dir() else None
    if root.is_dir():
        info = volume_of(root)
        # Can't read the identity at all: trust the path, as before sessions.
        if info is None or info.uuid is None or info.uuid == volume_uuid:
            return root
    mount = find_mount(volume_uuid)
    if mount is None or not volume_mount:
        return None
    try:
        rel = root.relative_to(volume_mount)
    except ValueError:
        return None
    candidate = Path(mount) / rel
    return candidate if candidate.is_dir() else None

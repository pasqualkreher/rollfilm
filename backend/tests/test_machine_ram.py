"""RAM detection on every platform: sysconf where it exists, the kernel's
GlobalMemoryStatusEx on Windows.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import ctypes
import sys

from app.services import machine


class _FakeKernel32:
    def __init__(self, total: int, ok: bool = True) -> None:
        self.total = total
        self.ok = ok

    def GlobalMemoryStatusEx(self, ref) -> int:  # noqa: N802 - the Win32 name
        status = ref._obj
        assert status.dwLength == ctypes.sizeof(status)
        status.ullTotalPhys = self.total
        return 1 if self.ok else 0


class _FakeWindll:
    def __init__(self, kernel32) -> None:
        self.kernel32 = kernel32


def test_windows_reads_the_total_through_global_memory_status(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(ctypes, "windll", _FakeWindll(_FakeKernel32(8 * machine.GIB)), raising=False)
    # sysconf must not be consulted at all on this path.
    monkeypatch.setattr(machine.os, "sysconf", lambda name: (_ for _ in ()).throw(AssertionError), raising=False)
    assert machine.physical_ram_bytes() == 8 * machine.GIB


def test_a_failed_windows_call_counts_as_unknown(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(ctypes, "windll", _FakeWindll(_FakeKernel32(8 * machine.GIB, ok=False)), raising=False)
    assert machine.physical_ram_bytes() is None
    monkeypatch.delattr(ctypes, "windll", raising=False)
    assert machine.physical_ram_bytes() is None


def test_the_posix_path_still_uses_sysconf(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    values = {"SC_PHYS_PAGES": 1000, "SC_PAGE_SIZE": 4096}
    monkeypatch.setattr(machine.os, "sysconf", lambda name: values[name], raising=False)
    assert machine.physical_ram_bytes() == 4_096_000

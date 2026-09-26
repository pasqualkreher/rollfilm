"""What kind of machine this backend is running on - one place to ask.

Every pool and cache in the backend used to size itself from os.cpu_count()
alone, so an 8GB MacBook Air got the same worker counts and byte budgets as a
64GB workstation: three concurrent gigabyte renders, sixteen analysis threads,
a gigabyte of editor caches that never let go, CLIP resident from launch. On
8GB that added up to swap - the app "hakelt". The knobs read the flags here.

Deliberately tiny and import-free (no numpy, no torch): thumbnails.py imports
it at module load, before anything heavy exists."""

from __future__ import annotations

import os

GIB = 1024**3


def physical_ram_bytes() -> int | None:
    try:
        return os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (ValueError, OSError, AttributeError):
        return None


PHYSICAL_RAM_BYTES = physical_ram_bytes()

# Machines with 8GB or less. A little slack above 8GiB: some report the RAM
# minus what the firmware keeps. Unknown RAM (no sysconf) counts as roomy -
# that is the historic behaviour and the only Windows path today.
LOW_RAM_LIMIT_BYTES = int(8.5 * GIB)
LOW_RAM = PHYSICAL_RAM_BYTES is not None and PHYSICAL_RAM_BYTES <= LOW_RAM_LIMIT_BYTES

CPU_COUNT = os.cpu_count() or 4
# Apple Silicon reports efficiency cores as full cores (an 8-core M3 is 4+4),
# and a pool sized "every core but one" then runs seven threads of numpy
# against four cores that can actually carry them. Half the count is what the
# heavy pools (cv2, torch, BLAS) get.
PERF_CORES = max(2, CPU_COUNT // 2)


def scaled_budget(byte_budget: int, low_ram_factor: float = 0.5) -> int:
    """A cache's byte budget for this machine: the given one, or a fraction of
    it on a low-RAM machine."""
    return int(byte_budget * low_ram_factor) if LOW_RAM else byte_budget


def ram_gb() -> int | None:
    return round(PHYSICAL_RAM_BYTES / GIB) if PHYSICAL_RAM_BYTES else None

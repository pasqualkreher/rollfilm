import hashlib
import threading
from pathlib import Path

import imagehash
from PIL import Image as PILImage


def warm_phash() -> None:
    """Pay imagehash's hidden startup cost up front, off the critical path.

    imagehash.phash() lazily does `import scipy.fftpack` on its first call. That
    import means loading scipy's many small files from disk, which on a cold
    (or Nextcloud-throttled) filesystem can take tens of seconds - and it would
    happen in the middle of the first import request, looking like a hang.

    This used to run at module import, which put it on the path to the server
    answering /health at all - and the desktop shell holds the window behind a
    splash screen until it does. Measured at ~150ms of every single launch, for
    a cost only an import ever needs to have been paid. It runs on a background
    thread now (see main.on_startup), alongside the geocoder and CLIP warmups,
    which is the same trade those already make: nothing waits for it, and an
    import arriving first simply pays what it would have paid anyway.
    """
    import scipy.fftpack  # noqa: F401  (imported for its side effect, used by imagehash)

    imagehash.phash(PILImage.new("L", (32, 32)))


def warm_phash_in_background() -> None:
    threading.Thread(target=warm_phash, name="phash-warmup", daemon=True).start()


def sha1_file(path: Path) -> str | None:
    """SHA-1 hex digest, or None if the file can't be read. SHA-1 is Immich's
    checksum algorithm - used to match library photos to Immich assets that
    were uploaded before asset ids were recorded (see services/immich_sync)."""
    digest = hashlib.sha1()
    try:
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def perceptual_hash(preview: PILImage.Image) -> str:
    return str(imagehash.phash(preview))


def hamming_distance(hash_a: str, hash_b: str) -> int:
    return imagehash.hex_to_hash(hash_a) - imagehash.hex_to_hash(hash_b)


# phash strings are 64-bit values in hex; comparing them as ints with a XOR +
# popcount is ~100x faster than imagehash's hex_to_hash (which rebuilds a numpy
# bool array on every call). That matters in the import dedup loop, which does
# up to O(files x library) comparisons - re-parsing hex there is what made large
# imports crawl. Callers convert each hash to an int once via phash_to_int.
def phash_to_int(hash_hex: str) -> int:
    return int(hash_hex, 16)


def hamming_int(a: int, b: int) -> int:
    return (a ^ b).bit_count()

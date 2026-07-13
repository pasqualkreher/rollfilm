import hashlib
from pathlib import Path

import imagehash
from PIL import Image as PILImage


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

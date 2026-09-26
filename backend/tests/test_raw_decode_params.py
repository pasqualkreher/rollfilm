"""The full-size demosaic of an X-Trans raw uses Markesteijn's 1-pass variant.

LibRaw's default for Fuji's 6x6 layout is the 3-pass one - 13.8s for a 40MP RAF
against 6.8s for 1-pass, which on the same file is indistinguishable (76dB
PSNR). dcraw's quality ladder reaches 1-pass through PPG. Bayer keeps LibRaw's
default, and half-size decodes skip the demosaic entirely so they pass nothing.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import numpy as np
import rawpy

from app.services import raw as raw_service


class _FakeRaw:
    def __init__(self, pattern_shape):
        self.raw_pattern = np.zeros(pattern_shape, dtype=np.uint8)
        self.calls: list[dict] = []

    def postprocess(self, **kwargs):
        self.calls.append(kwargs)
        return np.zeros((4, 4, 3), dtype=np.uint16)


def test_a_full_xtrans_decode_asks_for_the_one_pass_demosaic():
    raw = _FakeRaw((6, 6))
    raw_service._demosaic_linear(raw, half_size=False)
    assert raw.calls[0]["demosaic_algorithm"] == rawpy.DemosaicAlgorithm.PPG
    assert raw.calls[0]["half_size"] is False


def test_a_half_size_decode_passes_no_algorithm():
    raw = _FakeRaw((6, 6))
    raw_service._demosaic_linear(raw, half_size=True)
    assert "demosaic_algorithm" not in raw.calls[0]


def test_bayer_keeps_librawls_default():
    raw = _FakeRaw((2, 2))
    raw_service._demosaic_linear(raw, half_size=False)
    assert "demosaic_algorithm" not in raw.calls[0]


def test_the_decode_survives_a_raw_without_a_pattern():
    class _NoPattern:
        calls: list[dict] = []

        @property
        def raw_pattern(self):
            raise RuntimeError("not available")

        def postprocess(self, **kwargs):
            self.calls.append(kwargs)
            return np.zeros((4, 4, 3), dtype=np.uint16)

    raw = _NoPattern()
    raw_service._demosaic_linear(raw, half_size=False)
    assert "demosaic_algorithm" not in raw.calls[0]

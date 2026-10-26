"""Measure Fujifilm's in-camera Grain Effect on the camera's own JPEGs.

Read-only. Walks a library for Fuji JPEGs whose EXIF carries the Grain Effect
tags (GrainEffectRoughness Weak/Strong, GrainEffectSize Small/Large) and the
shots with it Off (the noise floor), and measures on each:

    * the tone curve: the grain's standard deviation per luminance bin (12
      bins over display 0..1), in flat regions only, with the Off floor taken
      out in quadrature - the shape says where on the tone scale the camera
      puts its grain, the value at the peak how strong Weak and Strong are;
    * the particle size: the half-width of the grain's autocorrelation, in
      pixels and as a fraction of the long edge, for Small and Large;
    * the character: excess kurtosis and skew of the grain.

The same analysis runs on this pipeline's own grain (--ours) so the slider
can be fitted apples to apples: the high-pass and the flatness test are the
same on both sides, so whatever they take away they take away from both.

    .venv/bin/python -m tools.grain_reference --root ~/Desktop/DemoLib --out grain_table.txt
    .venv/bin/python -m tools.grain_reference --ours 33:25:50 --ours 66:75:50

Shots at ISO 2000 and above are left out (sensor noise). Duplicate files (the
same photo imported twice) count once, by name.
"""

from __future__ import annotations

import argparse
import math
import os
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

BINS = 12
# High-pass base: wide enough to leave Large grain (a handful of pixels on a
# 6240px frame) in the residual, narrow enough that a flat wall's falloff
# stays in the base.
HP_SIGMA = 4.0
# Flatness: the local spread of a heavily blurred copy over a window. Grain
# itself averages out of the blur; gradients, edges and texture do not.
FLAT_SIGMA = 8.0
FLAT_WIN = 25
FLAT_MAX_STD = 0.006
# The squares the plane is cut into (px), how many a luminance bin needs
# before it counts, and the quantile of their spreads read as the grain.
AC_PATCH = 64
MIN_SQUARES = 12
QUANTILE = 0.15
MAX_ISO = 2000

EXIFTOOL = Path(__file__).resolve().parents[2] / "electron" / "resources" / "exiftool" / "exiftool"


def _exif(path: Path) -> dict[str, str]:
    exe = str(EXIFTOOL) if EXIFTOOL.exists() else "exiftool"
    out = subprocess.run(
        [exe, "-s", "-GrainEffectRoughness", "-GrainEffectSize", "-FilmMode", "-ISO",
         "-ImageWidth", "-ImageHeight", "-Model", str(path)],
        capture_output=True, text=True, check=False,
    ).stdout
    tags = {}
    for line in out.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            tags[k.strip()] = v.strip()
    return tags


def _luma(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"cannot read {path}")
    img = img.astype(np.float32) * (1.0 / 255.0)
    # BT.709 luma of the sRGB-encoded values, as the pipeline's _LUMA reads it.
    return img[..., 2] * 0.2126 + img[..., 1] * 0.7152 + img[..., 0] * 0.0722


def analyze(luma: np.ndarray) -> dict:
    """Grain statistics of one display-referred luminance plane (float32 0..1).

    The plane is cut into PATCH x PATCH squares. A square counts when its
    low-frequency base is flat (no gradient, no edge) and it is clear of
    clipping; its high-pass spread, kurtosis and skew are measured. Per
    luminance bin the grain is the LOW QUANTILE of the squares' spreads: grain
    is the one thing every square of a tone carries alike, while fine texture
    (grass, fabric, gravel - which no flatness test on a blurred copy can
    tell from grain) only ever adds. Kurtosis, skew and the autocorrelation
    come from the squares at that quantile - the clean grain.

    Returns per-bin sigma (NaN where a bin has too few squares), the square
    counts, the autocorrelation half-width in pixels and its first lags,
    excess kurtosis and skew."""
    h, w = luma.shape
    base = cv2.GaussianBlur(luma, (0, 0), HP_SIGMA)
    hp = luma - base
    smooth = cv2.GaussianBlur(luma, (0, 0), FLAT_SIGMA)
    P = AC_PATCH
    m = int(4 * FLAT_SIGMA)
    ph, pw = (h - 2 * m) // P, (w - 2 * m) // P

    def squares(a: np.ndarray) -> np.ndarray:
        return a[m:m + ph * P, m:m + pw * P].reshape(ph, P, pw, P).transpose(0, 2, 1, 3).reshape(ph * pw, P, P)

    sq_hp = squares(hp)
    sq_smooth = squares(smooth)
    sq_base = squares(base)
    mean = sq_base.mean(axis=(1, 2))
    flat = sq_smooth.std(axis=(1, 2)) < FLAT_MAX_STD
    clear = (sq_base.min(axis=(1, 2)) > 0.004) & (sq_base.max(axis=(1, 2)) < 0.996)
    ok = flat & clear
    spread = sq_hp.std(axis=(1, 2))
    centred = sq_hp - sq_hp.mean(axis=(1, 2), keepdims=True)
    z = centred / (spread[:, None, None] + 1e-9)
    kurt_sq = (z ** 4).mean(axis=(1, 2)) - 3.0
    skew_sq = (z ** 3).mean(axis=(1, 2))

    sigma = np.full(BINS, np.nan)
    counts = np.zeros(BINS, dtype=np.int64)
    idx = np.minimum((mean * BINS).astype(np.int32), BINS - 1)
    clean = np.zeros(len(mean), dtype=bool)
    for b in range(BINS):
        sel = ok & (idx == b)
        n = int(sel.sum())
        counts[b] = n
        if n >= MIN_SQUARES:
            q = float(np.quantile(spread[sel], QUANTILE))
            sigma[b] = q
            clean |= sel & (spread <= q * 1.15)

    # Character and autocorrelation from the clean squares, mid-tones first
    # (the grain is strongest there, so what is measured is the grain).
    pick = clean & (mean > 0.2) & (mean < 0.8)
    if pick.sum() < 8:
        pick = clean
    n_used = int(pick.sum())
    if n_used:
        kurt = float(np.median(kurt_sq[pick]))
        skew = float(np.median(skew_sq[pick]))
        win = np.hanning(P)
        win2 = np.outer(win, win)
        f = np.fft.fft2(centred[pick] * win2, axes=(1, 2))
        acf = np.real(np.fft.ifft2((np.abs(f) ** 2).mean(axis=0)))
        acf = np.fft.fftshift(acf)
        c = P // 2
        radial = []
        for r in range(0, 16):
            ring = []
            for dy in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    if round(math.hypot(dx, dy)) == r:
                        ring.append(acf[c + dy, c + dx])
            radial.append(float(np.mean(ring)))
        radial = np.array(radial) / radial[0]
        # Half-width: the lag where the autocorrelation falls through 0.5,
        # interpolated between samples.
        hw = float("nan")
        for r in range(1, len(radial)):
            if radial[r] < 0.5:
                r0, r1 = radial[r - 1], radial[r]
                hw = (r - 1) + (r0 - 0.5) / (r0 - r1)
                break
    else:
        hw, kurt, skew = float("nan"), float("nan"), float("nan")
        radial = np.array([1.0])
    return {
        "sigma": sigma, "counts": counts, "acf_halfwidth_px": hw, "kurtosis": kurt,
        "skew": skew, "flat_frac": float(ok.mean()), "acf_patches": n_used,
        "acf_radial": radial,
    }


def _collect(root: Path) -> list[tuple[Path, dict]]:
    seen: set[str] = set()
    found = []
    for dirpath, _dirs, files in os.walk(root):
        for name in sorted(files):
            if not name.lower().endswith((".jpg", ".jpeg")) or "_edit" in name.lower():
                continue
            key = name.lower()
            if key in seen:
                continue
            path = Path(dirpath) / name
            tags = _exif(path)
            if "GrainEffectRoughness" not in tags:
                continue
            seen.add(key)
            found.append((path, tags))
    return found


def _combine(entries: list[dict]) -> tuple[np.ndarray, float, float, float, int]:
    """Pixel-weighted per-bin sigma (in quadrature), mean half-width, kurtosis
    and skew over several photos."""
    s2 = np.zeros(BINS)
    n = np.zeros(BINS)
    hws, ks, sks = [], [], []
    for e in entries:
        ok = ~np.isnan(e["sigma"])
        s2[ok] += e["sigma"][ok] ** 2 * e["counts"][ok]
        n[ok] += e["counts"][ok]
        if not math.isnan(e["acf_halfwidth_px"]):
            hws.append(e["acf_halfwidth_px"] / e["long_edge"])
            ks.append(e["kurtosis"])
            sks.append(e["skew"])
    sigma = np.sqrt(np.divide(s2, n, out=np.full(BINS, np.nan), where=n > 0))
    return (
        sigma,
        float(np.mean(hws)) if hws else float("nan"),
        float(np.mean(ks)) if ks else float("nan"),
        float(np.mean(sks)) if sks else float("nan"),
        len(entries),
    )


def _fmt_curve(c: np.ndarray) -> str:
    return " ".join("  nan " if math.isnan(v) else f"{v * 1000:5.2f}" for v in c)


def _ours(spec: str, long_edge: int, process_8: bool) -> dict:
    """Render a grey wedge through the pipeline's grain pass and analyse it
    the same way. spec = amount:size:roughness."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from app.services import thumbnails

    amount, size, rough = (int(v) for v in spec.split(":"))
    h, w = long_edge * 2 // 3, long_edge
    # A wedge of 24 flat steps across the frame, each wider than the flatness
    # window, so every luminance bin gets flat pixels.
    steps = 24
    col = np.linspace(0.0, 1.0, steps, dtype=np.float32)
    ramp = np.repeat(col, int(math.ceil(w / steps)))[:w]
    arr = np.repeat(np.repeat(ramp[None, :], h, axis=0)[..., None], 3, axis=-1)
    kw = {"fuji": True} if process_8 else {}
    out = thumbnails._apply_grain(arr, amount, size, rough, **kw)
    luma = out[..., 0] * 0.2126 + out[..., 1] * 0.7152 + out[..., 2] * 0.0722
    # Flat-wedge steps meet at hard edges; the flatness test drops those.
    return analyze(luma.astype(np.float32))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=str(Path.home() / "Desktop" / "DemoLib"))
    ap.add_argument("--out", default=None, help="write the table here as well")
    ap.add_argument("--ours", action="append", default=[], metavar="AMOUNT:SIZE:ROUGH",
                    help="also analyse the pipeline's own grain at these settings")
    ap.add_argument("--ours-edge", type=int, default=6240, help="long edge for --ours")
    ap.add_argument("--ours-process-7", action="store_true", help="--ours on the old grain path")
    ap.add_argument("--no-library", action="store_true", help="skip the library, only --ours")
    args = ap.parse_args()

    lines: list[str] = []

    def say(s: str = "") -> None:
        print(s)
        lines.append(s)

    bins = " ".join(f"{(b + 0.5) / BINS:5.2f}" for b in range(BINS))
    if not args.no_library:
        groups: dict[str, list[dict]] = {}
        say(f"# per photo (sigma x1000 per luma bin; bin centres {bins})")
        for path, tags in _collect(Path(args.root).expanduser()):
            iso = int(tags.get("ISO", "0") or 0)
            rough, size = tags.get("GrainEffectRoughness", "?"), tags.get("GrainEffectSize", "?")
            setting = "Off" if rough == "Off" else f"{rough}/{size}"
            luma = _luma(path)
            r = analyze(luma)
            r["long_edge"] = max(luma.shape)
            r["iso"] = iso
            r["name"] = path.name
            flag = "  (ISO >= 2000, left out)" if iso >= MAX_ISO else ""
            lags = " ".join(f"{v:.2f}" for v in r["acf_radial"][1:4])
            say(f"{path.name:14s} {setting:13s} ISO {iso:5d} {tags.get('Model', ''):8s} "
                f"flat {r['flat_frac'] * 100:4.1f}%  acf-hw {r['acf_halfwidth_px']:.2f}px (lags {lags}) "
                f"kurt {r['kurtosis']:.2f} skew {r['skew']:+.2f}{flag}")
            say(f"               {_fmt_curve(r['sigma'])}")
            if iso < MAX_ISO:
                groups.setdefault(setting, []).append(r)

        say()
        # The noise floor: the Off shots, as one number (too few bins for a
        # curve), scaled to each photo's ISO as sqrt(ISO/ISO_off) - the
        # camera's noise reduction leaves roughly that much at low ISO, and
        # the correction is a few percent of the grain wherever it matters.
        floor_sigma, floor_iso = 0.0, 1.0
        if "Off" in groups:
            floor_sigma = float(np.nanmean(_combine(groups["Off"])[0]))
            floor_iso = float(np.mean([e["iso"] for e in groups["Off"]]))
            for e in groups.values():
                for r in e:
                    f = floor_sigma * math.sqrt(r["iso"] / floor_iso)
                    r["sigma_raw"] = r["sigma"]
                    r["sigma"] = np.sqrt(np.maximum(r["sigma"] ** 2 - f * f, 0.0))
            say(f"# noise floor: Off sigma {floor_sigma * 1000:.2f}e-3 at ISO {floor_iso:.0f}, "
                f"scaled by sqrt(ISO/{floor_iso:.0f}) and removed in quadrature per photo")
        say("# per setting (square-weighted, floor removed)")
        say(f"# setting        {bins}   acf-hw/edge   kurt   skew  n")
        table: dict[str, tuple] = {}
        for setting in ("Off", "Weak/Small", "Weak/Large", "Strong/Small", "Strong/Large"):
            if setting not in groups:
                continue
            if setting == "Off":
                for r in groups[setting]:
                    r["sigma"] = r.get("sigma_raw", r["sigma"])
            sigma, hw, kurt, skew, n = _combine(groups[setting])
            table[setting] = (sigma, hw, kurt, skew, n)
            say(f"{setting:16s} {_fmt_curve(sigma)}   {hw * 1e4:6.2f}e-4  {kurt:5.2f}  {skew:+5.2f}  {n}")
        if "Weak/Small" in table and "Weak/Large" in table:
            ws, wl = table["Weak/Small"][0], table["Weak/Large"][0]
            both = np.sqrt(np.nanmean(np.stack([ws ** 2, wl ** 2]), axis=0))
            say(f"{'Weak (both)':16s} {_fmt_curve(both)}")
            peak = np.nanmax(both)
            say(f"{'Weak shape':16s} {_fmt_curve(both / peak)}   (peak {peak * 1000:.2f}e-3)")
        if "Strong/Small" in table:
            ss = table["Strong/Small"][0]
            peak = np.nanmax(ss)
            say(f"{'Strong shape':16s} {_fmt_curve(ss / peak)}   (peak {peak * 1000:.2f}e-3)")

    for spec in args.ours:
        r = _ours(spec, args.ours_edge, not args.ours_process_7)
        say(f"{'ours ' + spec:16s} {_fmt_curve(r['sigma'])}   "
            f"{r['acf_halfwidth_px'] / args.ours_edge * 1e4:6.2f}e-4  {r['kurtosis']:5.2f}  {r['skew']:+5.2f}  "
            f"(acf-hw {r['acf_halfwidth_px']:.2f}px, process {'7' if args.ours_process_7 else '8'})")

    if args.out:
        Path(args.out).write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()

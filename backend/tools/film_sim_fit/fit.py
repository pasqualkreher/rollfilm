"""Step 2: fit one 33x33x33 cube per film simulation to the camera's JPEGs.

The model is the app's own neutral render followed by the things the camera
did that the app's base does not:

    linear base x gain -> the app's highlight shoulder -> sRGB        (the app)
      -> the simulation's cube                                        (fitted)
      -> colour chrome, colour, highlight / shadow tone of the recipe (fitted,
         shared by every simulation, scaled by the recipe's settings)
      = the camera JPEG

A cube is a smooth global mapping - a 3x3 mix of the channels and one curve
per channel - plus a free residual per node. Where the photos have colours the
residual follows them; where they have none (a library holds few saturated
magentas) it falls back to zero and the global mapping carries on, so a colour
the fit never saw is still rendered in the simulation's manner instead of
being passed through untouched.

Almost every photo in a real library was shot with a recipe on top of the
simulation, so the recipe's settings are modelled alongside and taken back
out: what is left in the cube is the simulation at the camera's neutral
settings. The gain is one number per photo - the app normalises exposure, the
camera does not - tied so that on average a cube leaves the picture's
brightness alone.

    python -m tools.film_sim_fit.fit <cache dir> <out dir> [--steps N]

Writes <sim>.npy cubes (float16, [r][g][b][3], display sRGB in and out) for
every simulation with enough photos, and report.json with the colour
difference to the camera before and after, on photos held out of the fit.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import torch

from app.services import camera_matrix, film_sims

N = 33
LUMA = torch.tensor([0.2126, 0.7152, 0.0722])
MONO_SIMS = {s for s in film_sims.SIM_NAMES if s.startswith(("acros", "monochrome")) or s == "sepia"}
MIN_PHOTOS = 12  # fewer than this and a simulation keeps its hand-made recipe
RESIDUAL_WEIGHT = 20.0


# --- colour maths (torch) ------------------------------------------------------

def srgb_encode(x: torch.Tensor) -> torch.Tensor:
    x = x.clamp(min=0.0)
    return torch.where(x <= 0.0031308, x * 12.92, 1.055 * (x + 1e-8).pow(1 / 2.4) - 0.055)


def srgb_decode(v: torch.Tensor) -> torch.Tensor:
    v = v.clamp(min=0.0)
    return torch.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055).pow(2.4))


_OK_M1 = torch.tensor([[0.4122214708, 0.5363325363, 0.0514459929],
                       [0.2119034982, 0.6806995451, 0.1073969566],
                       [0.0883024619, 0.2817188376, 0.6299787005]])
_OK_M2 = torch.tensor([[0.2104542553, 0.7936177850, -0.0040720468],
                       [1.9779984951, -2.4285922050, 0.4505937099],
                       [0.0259040371, 0.7827717662, -0.8086757660]])


def oklab(lin: torch.Tensor) -> torch.Tensor:
    lms = (lin.clamp(min=0.0) @ _OK_M1.T + 1e-6).pow(1 / 3)
    return lms @ _OK_M2.T


def app_render(lin: torch.Tensor, gain: torch.Tensor) -> torch.Tensor:
    """thumbnails._linear_tone_block with nothing set: gain, Reinhard-extended
    shoulder on luminance with white point = gain, sRGB encode."""
    arr = lin * gain[:, None]
    y = (arr @ LUMA).clamp(min=0.0)
    w2 = gain.clamp(min=1.0) ** 2
    ratio = torch.where(y > 1e-6, (1.0 + y / w2) / (1.0 + y), torch.ones_like(y))
    return srgb_encode((arr * ratio[:, None]).clamp(0.0, 1.0))


def sample_cubes(cubes: torch.Tensor, sim: torch.Tensor, v: torch.Tensor) -> torch.Tensor:
    """Trilinear lookup of each row of v (display sRGB) in its own
    simulation's cube. cubes: (S, N^3, C) indexed (r*N + g)*N + b."""
    n = round(cubes.shape[1] ** (1 / 3))
    x = v.clamp(0.0, 1.0) * (n - 1)
    i0 = x.floor().long().clamp(max=n - 2)
    f = x - i0
    base = (i0[:, 0] * n + i0[:, 1]) * n + i0[:, 2]
    out = 0.0
    for dr in (0, 1):
        for dg in (0, 1):
            for db in (0, 1):
                w = ((f[:, 0] if dr else 1 - f[:, 0]) * (f[:, 1] if dg else 1 - f[:, 1])
                     * (f[:, 2] if db else 1 - f[:, 2]))
                out = out + cubes[sim, base + (dr * n + dg) * n + db] * w[:, None]
    return out


def curve(knots: torch.Tensor, v: torch.Tensor, pinned: bool = True) -> torch.Tensor:
    """Piecewise-linear 1-D function on 0..1 through `knots` (zero at both
    ends when pinned; the last axis of `knots` may be one curve per channel)."""
    k = torch.cat([knots.new_zeros(1), knots, knots.new_zeros(1)]) if pinned else knots
    if k.dim() == 2:  # (knots, channels): each column of v through its own curve
        x = v.clamp(0.0, 1.0) * (k.shape[0] - 1)
        i0 = x.floor().long().clamp(max=k.shape[0] - 2)
        f = x - i0
        cols = torch.arange(k.shape[1]).expand_as(i0)
        return k[i0, cols] * (1 - f) + k[i0 + 1, cols] * f
    x = v.clamp(0.0, 1.0) * (len(k) - 1)
    i0 = x.floor().long().clamp(max=len(k) - 2)
    f = x - i0
    return k[i0] * (1 - f) + k[i0 + 1] * f


BLACK_SHELL = 3  # nodes nearer to black than this are set by rule, not by the fit


def settle_black(cube: np.ndarray) -> np.ndarray:
    """The few nodes next to black, by rule: black is black, and from there the
    cube runs straight to its values three nodes out. Down there the photos
    give almost no usable samples (noise, the JPEG's own black clip), and what
    the fit makes of them is a bump - a tinted, lifted black."""
    n = cube.shape[0]
    out = cube.copy()
    flat = cube.reshape(-1, 3)

    def lookup(p: np.ndarray) -> np.ndarray:
        i0 = np.minimum(p.astype(int), n - 2)
        f = p - i0
        acc = np.zeros(3)
        for dr in (0, 1):
            for dg in (0, 1):
                for db in (0, 1):
                    w = ((f[0] if dr else 1 - f[0]) * (f[1] if dg else 1 - f[1]) * (f[2] if db else 1 - f[2]))
                    acc += w * flat[((i0[0] + dr) * n + i0[1] + dg) * n + i0[2] + db]
        return acc

    for r in range(BLACK_SHELL):
        for g in range(BLACK_SHELL):
            for b in range(BLACK_SHELL):
                m = max(r, g, b)
                p = np.array([r, g, b], dtype=np.float64)
                out[r, g, b] = 0.0 if m == 0 else lookup(p * BLACK_SHELL / m) * (m / BLACK_SHELL)
    return out


def identity_cube(n: int) -> torch.Tensor:
    axis = torch.linspace(0.0, 1.0, n)
    r, g, b = torch.meshgrid(axis, axis, axis, indexing="ij")
    return torch.stack([r, g, b], dim=-1).reshape(-1, 3)


class Model(torch.nn.Module):
    def __init__(self, sims: list[str], n_images: int, gain0: torch.Tensor):
        super().__init__()
        self.sims = sims
        self.residual = torch.nn.Parameter(torch.zeros(len(sims), N**3, 3))
        # The global part of each cube: channel mix, then a curve per channel
        # (stored as its offset from the identity).
        self.mix = torch.nn.Parameter(torch.eye(3).repeat(len(sims), 1, 1))
        self.tone = torch.nn.Parameter(torch.zeros(len(sims), 17, 3))
        self.log_gain = torch.nn.Parameter(gain0.log())
        self.register_buffer("log_gain0", gain0.log())
        self.register_buffer("ident", identity_cube(N))
        # The recipe's settings, shared by all simulations.
        self.d_high = torch.nn.Parameter(torch.zeros(15))
        self.d_shadow = torch.nn.Parameter(torch.zeros(15))
        self.k_color = torch.nn.Parameter(torch.zeros(2))  # per step, up / down
        self.chrome = torch.nn.Parameter(torch.zeros(1, 9**3, 1))
        self.chrome_blue = torch.nn.Parameter(torch.zeros(1, 9**3, 1))
        # DR100 and DR200 against DR400, the mode most of a Fuji library is
        # shot in (the cube is the simulation as DR400 renders it).
        self.d_dr = torch.nn.Parameter(torch.zeros(2, 15))

    def base(self) -> torch.Tensor:
        """The global mapping of every simulation, sampled on the cube's nodes."""
        out = []
        for i in range(len(self.sims)):
            u = self.ident @ self.mix[i].T
            out.append(u + curve(self.tone[i], u, pinned=False))
        return torch.stack(out)

    def cubes(self) -> torch.Tensor:
        return self.base() + self.residual

    def sim_only(self, lin, image, sim):
        return sample_cubes(self.cubes(), sim, app_render(lin, self.log_gain.exp()[image]))

    def recipe(self, v, meta):
        zero = torch.zeros_like(meta["sim"])
        v = v * (1.0 - meta["chrome"][:, None] * sample_cubes(self.chrome, zero, v)
                 - meta["chrome_blue"][:, None] * sample_cubes(self.chrome_blue, zero, v))
        c = meta["color"]
        scale = torch.exp(torch.where(c >= 0, c * self.k_color[0], c * self.k_color[1]))
        y = (v @ LUMA)[:, None]
        v = y + (v - y) * scale[:, None]
        dr = meta["dr"]
        tone = (meta["highlight"][:, None] * curve(self.d_high, v)
                + meta["shadow"][:, None] * curve(self.d_shadow, v)
                + (dr == 100)[:, None] * curve(self.d_dr[0], v)
                + (dr == 200)[:, None] * curve(self.d_dr[1], v))
        return v + tone

    def forward(self, lin, meta):
        return self.recipe(self.sim_only(lin, meta["image"], meta["sim"]), meta)

    def smoothness(self) -> torch.Tensor:
        r = self.residual.reshape(len(self.sims), N, N, N, 3)
        second = first = 0.0
        for axis in (1, 2, 3):
            d1 = r.diff(dim=axis)
            first = first + d1.pow(2).mean()
            second = second + d1.diff(dim=axis).pow(2).mean()
        mods = sum(p.diff().pow(2).mean() for p in (self.d_high, self.d_shadow, self.d_dr[0], self.d_dr[1]))
        for c in (self.chrome, self.chrome_blue):
            g = c.reshape(9, 9, 9)
            mods = mods + sum(g.diff(dim=a).pow(2).mean() for a in range(3))
        # The residual is smooth and, where no photo holds it up, zero.
        size = self.residual.pow(2).mean()
        base = self.tone.diff(dim=1).diff(dim=1).pow(2).mean()
        return 3000.0 * second + 30.0 * first + RESIDUAL_WEIGHT * size + 200.0 * base + 10.0 * mods


# --- data ----------------------------------------------------------------------

def load(cache: Path, use_matrix: bool = True):
    photos = []
    for f in sorted(cache.glob("*.npz")):
        d = np.load(f)
        lin = d["lin"].astype(np.float32).reshape(-1, 3)
        jpg = d["jpg"].astype(np.float32).reshape(-1, 3)
        model = str(d["model"])
        if use_matrix and model in camera_matrix._BORROWED:
            lin = np.clip(lin @ camera_matrix._to_srgb(model).T.astype(np.float32), 0.0, 1.0)
        # Cells on an edge, raw-clipped cells (their colour is gone) and the
        # deepest shadows (noise, and the JPEG's black clip) are poor samples.
        weight = 1.0 / (1.0 + (d["spread"].reshape(-1) / 0.08) ** 2)
        ok = (d["lin"].reshape(-1, 3).max(axis=1) < 0.97) & (jpg.max(axis=1) > 0.002)
        photos.append({
            "name": f.stem, "model": model, "sim": str(d["sim"]),
            "lin": lin[ok], "jpg": jpg[ok], "weight": weight[ok].astype(np.float32),
            "highlight": float(d["highlight"]), "shadow": float(d["shadow"]), "color": float(d["color"]),
            "chrome": float(d["chrome"]), "chrome_blue": float(d["chrome_blue"]), "dr": int(d["dr"]),
        })
    return photos


def held_out(name: str) -> bool:
    return int(hashlib.md5(name.encode()).hexdigest(), 16) % 5 == 0


def tensors(photos: list[dict], sims: list[str]):
    lin = torch.from_numpy(np.concatenate([p["lin"] for p in photos]))
    jpg = torch.from_numpy(np.concatenate([p["jpg"] for p in photos]))
    weight = torch.from_numpy(np.concatenate([p["weight"] for p in photos]))
    counts = [len(p["lin"]) for p in photos]

    def per_pixel(values, dtype=torch.float32):
        return torch.repeat_interleave(torch.tensor(values, dtype=dtype), torch.tensor(counts))

    mono = [p["sim"] in MONO_SIMS for p in photos]
    meta = {
        "image": per_pixel(range(len(photos)), torch.long),
        "sim": per_pixel([sims.index(p["sim"]) for p in photos], torch.long),
        "highlight": per_pixel([p["highlight"] for p in photos]),
        "shadow": per_pixel([p["shadow"] for p in photos]),
        "color": per_pixel([0.0 if m else p["color"] for p, m in zip(photos, mono)]),
        "chrome": per_pixel([0.0 if m else p["chrome"] for p, m in zip(photos, mono)]),
        "chrome_blue": per_pixel([0.0 if m else p["chrome_blue"] for p, m in zip(photos, mono)]),
        "dr": per_pixel([p["dr"] for p in photos], torch.long),
    }
    return lin, jpg, weight, meta


def initial_gain(photos: list[dict]) -> torch.Tensor:
    """Per photo: the gain at which the app's neutral render has the JPEG's
    median brightness."""
    gains = []
    for p in photos:
        target = float(np.median(p["jpg"] @ LUMA.numpy()))
        lin = torch.from_numpy(p["lin"])
        lo, hi = 0.05, 64.0
        for _ in range(30):
            mid = (lo * hi) ** 0.5
            med = float(srgb_decode(app_render(lin, torch.full((len(lin),), mid))).matmul(LUMA).median())
            lo, hi = (mid, hi) if med < target else (lo, mid)
        gains.append((lo * hi) ** 0.5)
    return torch.tensor(gains)


def colour_error(pred_srgb: torch.Tensor, jpg_lin: torch.Tensor) -> torch.Tensor:
    """Per sample: Oklab distance x100 (about one CIELAB dE unit)."""
    return (oklab(srgb_decode(pred_srgb.clamp(0.0, 1.0))) - oklab(jpg_lin)).norm(dim=1) * 100.0


def fit(model: Model, lin, jpg, weight, meta, steps: int, only_gain: bool = False, log: bool = True,
        with_residual: bool = True):
    """`with_residual=False` is the first pass: the global mappings, the
    recipe model and the gains alone. The residuals then start from a cube
    that already has the simulation's overall character, and only add what a
    channel mix and three curves cannot say - instead of taking the whole
    look on themselves and leaving the unseen colours at the identity."""
    if only_gain:
        params = [model.log_gain]
    else:
        params = [p for name, p in model.named_parameters() if with_residual or name != "residual"]
    opt = torch.optim.Adam(params, lr=0.02 if only_gain else 0.004)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, steps)
    n = len(lin)
    batch = min(n, 120_000)
    for step in range(steps):
        idx = torch.randint(0, n, (batch,)) if batch < n else torch.arange(n)
        m = {k: v[idx] for k, v in meta.items()}
        pred = model(lin[idx], m)
        err = oklab(srgb_decode(pred.clamp(1e-4, 1.0))) - oklab(jpg[idx])
        # Out-of-range predictions are pulled back by the clamp's dead zone,
        # so say it outright.
        over = (pred - pred.clamp(0.0, 1.0)).pow(2).sum(dim=1)
        d = err.pow(2).sum(dim=1)
        loss = (weight[idx] * (torch.sqrt(d + 1e-5) * 100.0 + 400.0 * over)).mean()
        if not only_gain:
            # On average a cube leaves the brightness alone (see module doc).
            drift = (model.log_gain - model.log_gain0).mean().pow(2)
            loss = loss + model.smoothness() + 50.0 * drift
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        if log and step % 250 == 0:
            print(f"  step {step}: {float(loss.detach()):.3f}", flush=True)


def summarise(err: torch.Tensor, weight: torch.Tensor) -> dict:
    order = err.argsort()
    cum = weight[order].cumsum(0) / weight.sum()
    return {
        "mean": round(float((err * weight).sum() / weight.sum()), 2),
        "p95": round(float(err[order][(cum >= 0.95).nonzero()[0, 0]]), 2),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cache", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--steps", type=int, default=4000)
    ap.add_argument("--no-matrix", action="store_true", help="leave borrowed camera matrices off (diagnosis)")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(0)

    photos = load(args.cache, use_matrix=not args.no_matrix)
    by_sim: dict[str, int] = {}
    for p in photos:
        by_sim[p["sim"]] = by_sim.get(p["sim"], 0) + 1
    sims = sorted(s for s, n in by_sim.items() if n >= MIN_PHOTOS)
    print("photos per simulation:", by_sim, "\nfitting:", sims, flush=True)
    photos = [p for p in photos if p["sim"] in sims]
    train = [p for p in photos if not held_out(p["name"])]
    test = [p for p in photos if held_out(p["name"])]

    model = Model(sims, len(train), initial_gain(train))
    lin, jpg, weight, meta = tensors(train, sims)
    print("global mappings", flush=True)
    fit(model, lin, jpg, weight, meta, args.steps // 2, with_residual=False)
    print("residuals", flush=True)
    fit(model, lin, jpg, weight, meta, args.steps)

    # Held-out photos: the cubes and the recipe model are fixed, only each
    # photo's own gain is found - for the fitted cubes, for the hand-made
    # recipes they replace, and for no simulation at all.
    report: dict = {"photos": by_sim, "train": len(train), "test": len(test), "sims": {}}
    old = torch.stack([
        torch.from_numpy(film_sims._sim_cube(s).reshape(-1, 3).astype(np.float32)) for s in sims
    ])
    lin_t, jpg_t, weight_t, meta_t = tensors(test, sims)
    errors = {}
    fitted = model.cubes().detach().clamp(0.0, 1.0)
    for i, s in enumerate(sims):
        if s in MONO_SIMS:
            fitted[i] = fitted[i].mean(dim=-1, keepdim=True)
    for label, cube in (("fitted", fitted), ("recipe", old), ("none", model.ident[None].expand_as(old))):
        probe = Model(sims, len(test), initial_gain(test))
        # The probe's cube is given outright: identity global part, the rest
        # in the residual.
        probe.load_state_dict({**model.state_dict(), "mix": probe.mix.detach(), "tone": probe.tone.detach(),
                               "residual": cube - model.ident[None],
                               "log_gain": probe.log_gain.detach(), "log_gain0": probe.log_gain0})
        fit(probe, lin_t, jpg_t, weight_t, meta_t, 300, only_gain=True, log=False)
        with torch.no_grad():
            errors[label] = colour_error(probe(lin_t, meta_t), jpg_t)
    for i, s in enumerate(sims):
        for cam in sorted({p["model"] for p in test}):
            cam_ids = torch.tensor([j for j, p in enumerate(test) if p["model"] == cam and p["sim"] == s])
            if len(cam_ids) == 0:
                continue
            sel = torch.isin(meta_t["image"], cam_ids)
            report["sims"].setdefault(s, {})[cam] = {
                "photos": len(cam_ids), **{k: summarise(e[sel], weight_t[sel]) for k, e in errors.items()}
            }
    report["recipe_model"] = {
        "color_per_step": [round(float(v), 4) for v in model.k_color],
        "highlight": [round(float(v), 4) for v in model.d_high],
        "shadow": [round(float(v), 4) for v in model.d_shadow],
        "dr100": [round(float(v), 4) for v in model.d_dr[0]],
        "dr200": [round(float(v), 4) for v in model.d_dr[1]],
    }
    cubes = model.cubes().detach().clamp(0.0, 1.0).reshape(len(sims), N, N, N, 3).numpy()
    for i, s in enumerate(sims):
        if s in MONO_SIMS:
            # Black and white is grey by construction, also where the photos
            # left a trace of colour in the fit.
            cubes[i] = cubes[i].mean(axis=-1, keepdims=True)
        cubes[i] = settle_black(cubes[i])
        np.save(args.out / f"{s}.npy", cubes[i].astype(np.float16))
    torch.save(model.state_dict(), args.out / "model.pt")
    (args.out / "report.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report["sims"], indent=1))


if __name__ == "__main__":
    main()

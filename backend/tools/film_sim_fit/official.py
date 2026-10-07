"""Step 2b: the simulations nobody shot, from published cubes.

The app ships nothing from this file today. The `--source sowerby` half made
the nine looks Fujifilm publishes no cube for, for process version 3; those
cubes were taken out (see Licences below), and on version 4 and up derive.py
builds the nine from other sources. Fujifilm's own ten are no longer
bent into the app's display space through the bridge below - the app applies
them where they are defined, on scene values (import_official.py,
film_sims.apply_official), with nothing fitted to a camera JPEG. The Fujifilm
half stays as the record of how the bridge was found and checked.

Fujifilm publishes 3D LUTs that turn F-Log2 footage into ten of its film
simulations (fujifilm-x.com/global/support/download/lut, the GFX ETERNA 55
pack: F-Log2 / F-Gamut in, BT.709 out). They are the simulations as Fujifilm
defines them - but for a log video signal, not for this app's picture. What is
missing is the way from one to the other:

    the app's neutral render -> [bridge] -> F-Log2 / F-Gamut -> Fujifilm's cube
      -> [output curve] -> the camera's JPEG

The bridge is a handful of numbers: the highlight shoulder the app put on is
taken back off (one white point), the result is scaled to F-Log2's exposure
(one gain), mixed by a 3x3 that stays near the identity, converted to F-Gamut
and log encoded. The output curve takes up what a stills JPEG does differently
from BT.709 video. Both are shared by all simulations and fitted on the
library's photos through the simulations that were shot - so they can be
checked: leave one simulation out of the fit, and see how well Fujifilm's cube
for it then predicts that simulation's JPEGs.

    python -m tools.film_sim_fit.official <cache dir> <lut dir> <fit dir> <out dir>

`fit dir` is fit.py's output (its recipe model is reused); `lut dir` holds the
FLog2_to_*_33grid cubes. Writes one cube per simulation Fujifilm publishes and
official.json with the errors, including the leave-one-out ones.

Fujifilm's pack has no Pro Neg. Hi, no Monochrome, no Sepia and none of the
yellow / red / green filter variants. For those, `--source sowerby` reads
Stuart Sowerby's "Fuji XTrans III" HaldCLUTs instead (blog.sowerby.me/
fuji-film-simulation-profiles: made from Fujifilm's RAW FILE CONVERTER on an
X100F, to be applied to a neutral sRGB render of the RAW). Same bridge, with
the plain sRGB encoding in place of F-Log2 / F-Gamut.

Licences. Fujifilm offers its cubes as a free download and states no terms.
Sowerby's page says "All Rights Reserved" and grants nothing beyond use. The
cubes written here are derived from those files (run through the bridge, not
copies), which does not make them free to pass on, so the app does not ship
them: pro_neg_hi, monochrome(+_ye/_r/_g), sepia, acros_ye/_r/_g render from
the hand-made recipes on process version 3.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from tools.film_sim_fit import fit as F

# The app's film_sim name -> the name in Fujifilm's file names.
OFFICIAL = {
    "provia": "PROVIA", "velvia": "Velvia", "astia": "ASTIA", "classic_chrome": "CLASSIC-CHROME",
    "reala_ace": "REALA-ACE", "pro_neg_std": "PRO-Neg.Std", "classic_neg": "CLASSIC-Neg.",
    "eterna": "ETERNA", "eterna_bleach_bypass": "ETERNA-BB", "acros": "ACROS",
}

# Linear BT.709 -> F-Gamut (BT.2020 primaries, D65).
_FGAMUT_FROM_709 = torch.tensor([[0.627404, 0.329283, 0.043313],
                                 [0.069097, 0.919540, 0.011362],
                                 [0.016391, 0.088013, 0.895595]])


def flog2(x: torch.Tensor) -> torch.Tensor:
    """F-Log2 OETF (Fujifilm's data sheet): scene reflectance -> code value 0..1."""
    a, b, c, d, e, f, cut = 5.555556, 0.064829, 0.245281, 0.384316, 8.799461, 0.092864, 0.000889
    return torch.where(x >= cut, c * torch.log10((a * x + b).clamp(min=1e-6)) + d, e * x + f)


# The same for Stuart Sowerby's HaldCLUT set ("Fuji XTrans III - <name>.png").
SOWERBY = {
    "provia": "Provia", "velvia": "Velvia", "astia": "Astia", "classic_chrome": "Classic Chrome",
    "pro_neg_hi": "Pro Neg Hi", "pro_neg_std": "Pro Neg Std", "sepia": "Sepia",
    "acros": "Acros", "acros_ye": "Acros+Ye", "acros_r": "Acros+R", "acros_g": "Acros+G",
    "monochrome": "Mono", "monochrome_ye": "Mono+Ye", "monochrome_r": "Mono+R", "monochrome_g": "Mono+G",
}
HALD_N = 36  # nodes kept of a HaldCLUT's 144 per axis (every 4th, plus the last)


def read_hald(path: Path, nodes: int = HALD_N) -> torch.Tensor:
    """A level-12 HaldCLUT image as (n^3, 3) indexed (r*n + g)*n + b, thinned
    to `nodes` per axis. In the image red runs fastest, then green."""
    from PIL import Image

    arr = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255.0
    n = round(arr.shape[0] ** (2 / 3))
    cube = arr.reshape(n, n, n, 3)  # [b][g][r]
    keep = np.unique(np.round(np.linspace(0, n - 1, nodes)).astype(int))
    # Trilinear lookup assumes evenly spaced nodes: resample exactly onto them.
    pos = np.linspace(0, n - 1, nodes)
    lo = np.floor(pos).astype(int).clip(max=n - 2)
    f = (pos - lo).astype(np.float32)
    for axis in range(3):
        a = np.take(cube, lo, axis=axis)
        b = np.take(cube, lo + 1, axis=axis)
        shape = [1, 1, 1, 1]
        shape[axis] = -1
        cube = a * (1 - f.reshape(shape)) + b * f.reshape(shape)
    del keep
    return torch.from_numpy(np.ascontiguousarray(cube.transpose(2, 1, 0, 3))).reshape(-1, 3)


def read_cube(path: Path) -> torch.Tensor:
    """A .cube file as (N^3, 3) indexed (r*N + g)*N + b (the file runs red fastest)."""
    rows, n = [], 0
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.startswith("LUT_3D_SIZE"):
            n = int(line.split()[1])
        elif line and (line[0].isdigit() or line[0] == "-"):
            rows.append([float(v) for v in line.split()])
    cube = torch.tensor(rows, dtype=torch.float32).reshape(n, n, n, 3)  # [b][g][r]
    return cube.permute(2, 1, 0, 3).reshape(-1, 3)


def load_official(lut_dir: Path, sims: list[str], source: str = "fujifilm") -> torch.Tensor:
    cubes = []
    for s in sims:
        if source == "sowerby":
            cubes.append(read_hald(lut_dir / f"Fuji XTrans III - {SOWERBY[s]}.png"))
        else:
            (path,) = sorted(lut_dir.glob(f"FLog2_to_{OFFICIAL[s]}_33grid_*.cube"))
            cubes.append(read_cube(path))
    return torch.stack(cubes)


class Bridge(torch.nn.Module):
    def __init__(self, sims: list[str], cubes: torch.Tensor, gain0: torch.Tensor, recipe_from: dict,
                 source: str = "fujifilm"):
        super().__init__()
        self.sims = sims
        self.source = source
        self.register_buffer("official", cubes)
        self.log_gain = torch.nn.Parameter(gain0.log())
        self.register_buffer("log_gain0", gain0.log())
        self.log_white = torch.nn.Parameter(torch.tensor(1.0))  # the shoulder taken back off
        self.log_scale = torch.nn.Parameter(torch.tensor(0.0))  # app exposure -> F-Log2 exposure
        self.mix = torch.nn.Parameter(torch.eye(3))
        self.out_curve = torch.nn.Parameter(torch.zeros(15, 3))
        # The recipe's settings, as fit.py found them; free to settle again.
        self.d_high = torch.nn.Parameter(recipe_from["d_high"].clone())
        self.d_shadow = torch.nn.Parameter(recipe_from["d_shadow"].clone())
        self.k_color = torch.nn.Parameter(recipe_from["k_color"].clone())
        self.chrome = torch.nn.Parameter(recipe_from["chrome"].clone())
        self.chrome_blue = torch.nn.Parameter(recipe_from["chrome_blue"].clone())
        self.d_dr = torch.nn.Parameter(recipe_from["d_dr"].clone())

    recipe = F.Model.recipe

    def to_flog2(self, v: torch.Tensor) -> torch.Tensor:
        """The app's display sRGB -> F-Log2 / F-Gamut code values."""
        lin = F.srgb_decode(v)
        # Undo y_out = y (1 + y/W^2) / (1 + y) on luminance.
        w2 = torch.exp(self.log_white) ** 2
        y = (lin @ F.LUMA).clamp(1e-6, 0.9999)
        b = 1.0 - y
        scene_y = (-b + torch.sqrt(b * b + 4.0 * y / w2)) * w2 / 2.0
        scene = lin * (scene_y / y)[:, None] * torch.exp(self.log_scale)
        scene = (scene @ self.mix.T).clamp(min=0.0)
        if self.source == "sowerby":
            # A neutral render of the RAW: the plain sRGB encoding, clipped.
            return F.srgb_encode(scene).clamp(0.0, 1.0)
        return flog2(scene @ _FGAMUT_FROM_709.T).clamp(0.0, 1.0)

    def sim_only_display(self, v: torch.Tensor, sim: torch.Tensor) -> torch.Tensor:
        out = F.sample_cubes(self.official, sim, self.to_flog2(v))
        pinned = torch.cat([out.new_zeros(1, 3), self.out_curve, out.new_zeros(1, 3)])
        return out + F.curve(pinned, out, pinned=False)

    def forward(self, lin, meta):
        v = F.app_render(lin, self.log_gain.exp()[meta["image"]])
        return self.recipe(self.sim_only_display(v, meta["sim"]), meta)

    def penalty(self) -> torch.Tensor:
        drift = (self.log_gain - self.log_gain0).mean().pow(2)
        return (50.0 * drift + 5.0 * (self.mix - torch.eye(3)).pow(2).sum()
                + 20.0 * self.out_curve.diff(dim=0).pow(2).mean())


def train(model: Bridge, lin, jpg, weight, meta, steps: int, only_gain: bool = False) -> None:
    params = [model.log_gain] if only_gain else list(model.parameters())
    opt = torch.optim.Adam(params, lr=0.02 if only_gain else 0.01)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, steps)
    n = len(lin)
    batch = min(n, 120_000)
    for _ in range(steps):
        idx = torch.randint(0, n, (batch,))
        pred = model(lin[idx], {k: v[idx] for k, v in meta.items()})
        err = F.oklab(F.srgb_decode(pred.clamp(1e-4, 1.0))) - F.oklab(jpg[idx])
        over = (pred - pred.clamp(0.0, 1.0)).pow(2).sum(dim=1)
        loss = (weight[idx] * (torch.sqrt(err.pow(2).sum(dim=1) + 1e-5) * 100.0 + 400.0 * over)).mean()
        if not only_gain:
            loss = loss + model.penalty()
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()


def evaluate(model: Bridge, photos: list[dict], sims: list[str]) -> dict:
    """Per simulation: the error on these photos with only their gains fitted."""
    if not photos:
        return {}
    lin, jpg, weight, meta = F.tensors(photos, sims)
    probe = Bridge(sims, model.official, F.initial_gain(photos), {
        "d_high": model.d_high.detach(), "d_shadow": model.d_shadow.detach(), "k_color": model.k_color.detach(),
        "chrome": model.chrome.detach(), "chrome_blue": model.chrome_blue.detach(), "d_dr": model.d_dr.detach(),
    }, model.source)
    with torch.no_grad():
        for name in ("log_white", "log_scale", "mix", "out_curve"):
            getattr(probe, name).copy_(getattr(model, name))
    train(probe, lin, jpg, weight, meta, 300, only_gain=True)
    with torch.no_grad():
        err = F.colour_error(probe(lin, meta), jpg)
    return {s: F.summarise(err[meta["sim"] == i], weight[meta["sim"] == i])
            for i, s in enumerate(sims) if (meta["sim"] == i).any()}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cache", type=Path)
    ap.add_argument("luts", type=Path)
    ap.add_argument("fit", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--steps", type=int, default=1200)
    ap.add_argument("--source", choices=("fujifilm", "sowerby"), default="fujifilm")
    ap.add_argument("--export-only", action="store_true", help="skip the leave-one-out runs")
    args = ap.parse_args()
    names = SOWERBY if args.source == "sowerby" else OFFICIAL
    args.out.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(0)

    state = torch.load(args.fit / "model.pt")
    recipe = {k: state[k] for k in ("d_high", "d_shadow", "k_color", "chrome", "chrome_blue", "d_dr")}
    known = [p for p in F.load(args.cache) if p["sim"] in names]
    shot = sorted({p["sim"] for p in known if sum(q["sim"] == p["sim"] for q in known) >= F.MIN_PHOTOS})
    photos = [p for p in known if p["sim"] in shot]
    # Simulations with a handful of photos: too few to fit on, enough to check.
    few = [p for p in known if p["sim"] not in shot]
    train_photos = [p for p in photos if not F.held_out(p["name"])]
    test_photos = [p for p in photos if F.held_out(p["name"])]
    cubes = load_official(args.luts, shot, args.source)
    report: dict = {"source": args.source, "shot": shot}

    def fitted(on: list[dict]) -> Bridge:
        model = Bridge(shot, cubes, F.initial_gain(on), recipe, args.source)
        train(model, *F.tensors(on, shot), args.steps)
        return model

    model = fitted(train_photos)
    report["held_out_photos"] = evaluate(model, test_photos, shot)
    print("held-out photos:", report["held_out_photos"], flush=True)
    # Leave one simulation out: the honest number for a simulation nobody shot.
    report["left_out_simulation"] = {}
    for s in [] if args.export_only else shot:
        without = fitted([p for p in train_photos if p["sim"] != s])
        report["left_out_simulation"][s] = evaluate(without, [p for p in test_photos if p["sim"] == s], shot)[s]
        print("left out", s, report["left_out_simulation"][s], flush=True)
    report["bridge"] = {
        "white": round(float(model.log_white.detach().exp()), 3),
        "scale": round(float(model.log_scale.detach().exp()), 3),
        "mix": [[round(float(v), 4) for v in row] for row in model.mix],
    }

    every = sorted(names)
    all_cubes = load_official(args.luts, every, args.source)
    grid = F.identity_cube(F.N)
    with torch.no_grad():
        full = Bridge(every, all_cubes, torch.ones(1), recipe, args.source)
        for name in ("log_white", "log_scale", "mix", "out_curve"):
            getattr(full, name).copy_(getattr(model, name))
        for name in ("d_high", "d_shadow", "k_color", "chrome", "chrome_blue", "d_dr"):
            getattr(full, name).copy_(getattr(model, name))
    if few:
        # Never part of any fit: the bridge applied to simulations it has not seen.
        report["few_photos"] = evaluate(full, few, every)
        print("few photos:", report["few_photos"], flush=True)
    with torch.no_grad():
        for i, s in enumerate(every):
            cube = full.sim_only_display(grid, torch.full((len(grid),), i)).clamp(0.0, 1.0)
            cube = cube.reshape(F.N, F.N, F.N, 3).numpy()
            # Video white sits a little under full scale; a still's paper
            # white is white.
            cube = np.clip(cube / cube[-1, -1, -1], 0.0, 1.0)
            if s in F.MONO_SIMS and s != "sepia":  # sepia is one tone, but not grey
                cube = np.repeat(cube.mean(axis=-1, keepdims=True), 3, axis=-1)
            np.save(args.out / f"{s}.npy", F.settle_black(cube).astype(np.float16))
    torch.save(model.state_dict(), args.out / "bridge.pt")
    (args.out / "official.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report["bridge"]))


if __name__ == "__main__":
    main()

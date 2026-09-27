"""Rebuild the venv's rawpy on macOS with a multi-threaded (OpenMP) LibRaw.

The full-resolution decode of a raw is the slowest thing the app does, and on
a Fuji X-Trans file almost all of it is LibRaw's demosaic. LibRaw runs that
demosaic tile-parallel under OpenMP - rawpy's Linux and Windows wheels are
built that way - but its macOS wheels are not (Apple's clang ships without
OpenMP), so on a Mac the 100% zoom of a 40MP RAF sat on one core for 5-7s
while the others idled. Measured on an M3 (DSCF0263.RAF, 7752x5178): 20.1s
single-core vs 4.4s OpenMP under the same load.

What this does, for the rawpy version already installed in this venv:
  1. download its sdist from PyPI (sha256-checked),
  2. build LibRaw with OpenMP + the same codecs the PyPI wheel carries
     (libjpeg for lossy DNGs, LCMS, Jasper) from Homebrew,
  3. delocate the wheel (the codec dylibs go into rawpy/.dylibs, like the
     official wheel) - everything except libomp,
  4. install it and point LibRaw at torch's own libomp.

Step 4 is the important one. torch loads LLVM's libomp too, and two OpenMP
runtimes in one process abort it ("OMP: Error #15 ... already initialized").
LibRaw therefore links @rpath/libomp.dylib with an rpath to ../torch/lib: one
runtime, torch's, whichever of the two is imported first. The bundle keeps
that layout (PyInstaller's collect_all puts rawpy/ and torch/ side by side).

Idempotent: a venv whose rawpy already runs on torch's libomp is left alone.
Not a macOS host -> nothing to do. Needs Homebrew (libomp, jpeg-turbo,
little-cms2, jasper are installed on demand) and network access to PyPI.

Usage: .venv/bin/python build_rawpy_openmp.py
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

BREW_DEPS = ("libomp", "jpeg-turbo", "little-cms2", "jasper")
OMP_REF = "@rpath/libomp.dylib"
TORCH_RPATH = "@loader_path/../torch/lib"


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=True, **kw)


def site_dir(pkg: str) -> Path:
    out = subprocess.run(
        [sys.executable, "-c", f"import {pkg}, os; print(os.path.dirname({pkg}.__file__))"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return Path(out)


def libraw_dylibs(rawpy_dir: Path) -> list[Path]:
    return sorted(p for p in rawpy_dir.glob("libraw_r*.dylib") if not p.is_symlink())


def linked_libs(lib: Path) -> list[str]:
    out = subprocess.run(["otool", "-L", str(lib)], check=True, capture_output=True, text=True).stdout
    return [line.split(" (")[0].strip() for line in out.splitlines()[1:]]


def already_done(rawpy_dir: Path) -> bool:
    libs = libraw_dylibs(rawpy_dir)
    return bool(libs) and all(OMP_REF in linked_libs(lib) for lib in libs)


def brew_prefix(formula: str) -> Path:
    out = subprocess.run(["brew", "--prefix", formula], capture_output=True, text=True)
    return Path(out.stdout.strip())


def ensure_brew_deps() -> dict[str, Path]:
    if shutil.which("brew") is None:
        sys.exit("error: Homebrew is required to build rawpy with OpenMP (https://brew.sh)")
    missing = [f for f in BREW_DEPS if not (brew_prefix(f) / "lib").is_dir()]
    if missing:
        run(["brew", "install", *missing])
    return {f: brew_prefix(f) for f in BREW_DEPS}


def fetch_sdist(version: str, dest: Path) -> Path:
    with urllib.request.urlopen(f"https://pypi.org/pypi/rawpy/{version}/json", timeout=60) as r:
        meta = json.load(r)
    sdist = next(u for u in meta["urls"] if u["packagetype"] == "sdist")
    archive = dest / sdist["filename"]
    with urllib.request.urlopen(sdist["url"], timeout=300) as r, open(archive, "wb") as f:
        shutil.copyfileobj(r, f)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != sdist["digests"]["sha256"]:
        sys.exit(f"error: sha256 mismatch for {sdist['filename']}")
    with tarfile.open(archive) as tar:
        tar.extractall(dest, filter="data")
    return dest / f"rawpy-{version}"


def patch_setup(src: Path) -> None:
    """Turn OpenMP on for the macOS LibRaw build and tell CMake where libomp
    lives. Fails loudly when upstream's setup.py no longer has the lines, so
    a rawpy upgrade can't silently ship single-threaded again."""
    setup = src / "setup.py"
    text = setup.read_text()
    old_flag = 'enable_openmp = "ON" if isLinux else "OFF"'
    old_args = '        "-DCMAKE_INSTALL_NAME_DIR=" + install_name_dir,\n    ]'
    if old_flag not in text or old_args not in text:
        sys.exit("error: rawpy's setup.py changed; update build_rawpy_openmp.py's patch")
    text = text.replace(old_flag, 'enable_openmp = "ON"')
    text = text.replace(
        old_args,
        old_args + '\n    cmake_args.append("-DOpenMP_ROOT=" + os.environ["RAWPY_OPENMP_ROOT"])',
    )
    setup.write_text(text)


def main() -> None:
    if sys.platform != "darwin":
        print("rawpy OpenMP rebuild: not macOS, nothing to do")
        return
    import rawpy

    rawpy_dir = site_dir("rawpy")
    torch_lib = site_dir("torch") / "lib"
    if not (torch_lib / "libomp.dylib").exists():
        sys.exit(f"error: {torch_lib}/libomp.dylib not found - LibRaw must share torch's OpenMP runtime")
    if already_done(rawpy_dir):
        print(f"rawpy {rawpy.__version__}: LibRaw already runs on torch's OpenMP, nothing to do")
        return
    version = rawpy.__version__
    prefixes = ensure_brew_deps()

    with tempfile.TemporaryDirectory(prefix="rawpy-omp-") as tmp:
        tmp_path = Path(tmp)
        src = fetch_sdist(version, tmp_path)
        patch_setup(src)
        env = dict(os.environ)
        include = f"-I{prefixes['libomp']}/include"
        env["CFLAGS"] = f"{include} {env.get('CFLAGS', '')}".strip()
        env["CXXFLAGS"] = f"{include} {env.get('CXXFLAGS', '')}".strip()
        env["CMAKE_PREFIX_PATH"] = ";".join(str(p) for p in prefixes.values())
        env["RAWPY_OPENMP_ROOT"] = str(prefixes["libomp"])
        wheels = tmp_path / "wheels"
        run([sys.executable, "-m", "pip", "wheel", str(src), "--no-deps", "-w", str(wheels)], env=env)
        # delocate in a throwaway venv, so the app's venv gains no build tools.
        tools = tmp_path / "tools"
        run([sys.executable, "-m", "venv", str(tools)])
        run([str(tools / "bin" / "python"), "-m", "pip", "install", "-q", "delocate"])
        fixed = tmp_path / "fixed"
        wheel = next(wheels.glob("rawpy-*.whl"))
        run([str(tools / "bin" / "delocate-wheel"), "--exclude", "libomp", "-w", str(fixed), str(wheel)])
        run([sys.executable, "-m", "pip", "install", "--no-deps", "--force-reinstall",
             str(next(fixed.glob("rawpy-*.whl")))])

    for lib in libraw_dylibs(rawpy_dir):
        refs = [ref for ref in linked_libs(lib) if ref.endswith("/libomp.dylib")]
        for ref in refs:
            if ref != OMP_REF:
                run(["install_name_tool", "-change", ref, OMP_REF, str(lib)])
        run(["install_name_tool", "-add_rpath", TORCH_RPATH, str(lib)])
        run(["codesign", "--force", "--sign", "-", str(lib)])

    # Verify in a fresh interpreter: OpenMP on, the codecs of the PyPI wheel
    # present, and torch + rawpy loaded side by side on ONE libomp.
    check = (
        "import rawpy, torch, os, subprocess\n"
        "f = rawpy.flags\n"
        "assert f['OPENMP'] and f['DNGLOSSYCODEC'] and f['LCMS'], f\n"
        "torch.set_num_threads(2); x = torch.randn(512, 512); float((x @ x).sum())\n"
        "out = subprocess.run(['vmmap', str(os.getpid())], capture_output=True, text=True).stdout\n"
        "omps = {l.split('/', 1)[-1] for l in out.splitlines() if l.rstrip().endswith('libomp.dylib')}\n"
        "assert len(omps) == 1, omps\n"
        "print('rawpy', rawpy.__version__, 'flags', f)\n"
    )
    run([sys.executable, "-c", check])
    if not already_done(rawpy_dir):
        sys.exit("error: LibRaw is not linked against @rpath/libomp.dylib after the rebuild")
    print(f"rawpy {version}: LibRaw rebuilt with OpenMP on torch's runtime")


if __name__ == "__main__":
    main()

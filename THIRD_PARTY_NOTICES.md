# Third-party notices

Rollfilm itself is MIT-licensed (see `LICENSE`). Some of what ships inside the
app is not. This file lists the parts that come from elsewhere, under which
licence, and where their full licence text is. It is copied into every
installer next to the app's resources (`electron/package.json`,
`build.extraResources`).

## Film look tables (`backend/app/services/film_luts/`)

The film simulations are 3D lookup tables stored as numpy arrays (`.npy`).
Each folder has a `SOURCES.txt` that names the source of every file, the
upstream commit it came from, and what was changed.

| Folder / files | Source | Licence | Licence text |
| --- | --- | --- | --- |
| `analog/`: all 21 `.npy` | [spektrafilm](https://github.com/andreavolpato/spektrafilm) by Andrea Volpato, rendered into 3D LUTs | CC BY-SA 4.0 | `analog/SPEKTRAFILM_LICENSE.txt` |
| `clut/`: 74 of the 79 `.npy` | RawTherapee Film Simulation Collection (2015-09-20) by Pat David, Pavlov Dmitry and Michael Ezra, thinned to 33 nodes | CC BY-SA 4.0 | <https://creativecommons.org/licenses/by-sa/4.0/> (named in `clut/SOURCES.txt`) |
| `clut/`: `kodak_colorplus_200.npy`, `agfa_vista_100.npy`, `agfa_vista_400.npy`, `fuji_fortia_sp_50.npy`, `kodak_ektachrome_100_g.npy` | [t3mujinpack](https://github.com/t3mujin/t3mujinpack) by João Almeida | MIT | `clut/T3MUJINPACK_LICENSE.txt` |
| `spectral/`: all 12 `.npy` | [spectral_film_lut](https://github.com/JanLohse/spectral_film_lut) by Jan Lohse | MIT | `spectral/SPECTRAL_FILM_LUT_LICENSE.txt` |
| `derived/`: `acros_ye.npy`, `acros_r.npy`, `acros_g.npy`, `monochrome.npy`, `monochrome_ye.npy`, `monochrome_r.npy`, `monochrome_g.npy`, `sepia.npy`, `pro_neg_hi.npy` | [Fujifilm Auto Settings for Darktable](https://github.com/bastibe/Fujifilm-Auto-Settings-for-Darktable) by Bastian Bechtold ("Fuji XTrans V8" LUTs), laid over Fujifilm's cubes | GPL v3 | `derived/GPL_LICENSE.txt` |
| `derived/nostalgic_neg.npy`, `nostalgic_neg.npy` | Measured by Rollfilm from camera JPEGs (`backend/tools/film_sim_fit/fit.py`) | MIT (Rollfilm's own) | `LICENSE` |
| `official/`: `acros.npy`, `astia.npy`, `classic_chrome.npy`, `classic_neg.npy`, `eterna.npy`, `eterna_bleach_bypass.npy`, `pro_neg_std.npy`, `provia.npy`, `reala_ace.npy`, `velvia.npy` | Fujifilm's F-Log2 film simulation LUTs (free download at fujifilm-x.com/global/support/download/lut), values copied unchanged (`backend/tools/film_sim_fit/import_official.py`) | **No licence file.** Redistributed as Fujifilm published them. | none |

**Open question:** Fujifilm offers the `official/` cubes as a free download
and states no terms of use. Nothing grants or forbids redistribution. Until
Fujifilm states terms, treat these ten files as the one part of the bundle
without a clear licence.

The CC BY-SA 4.0 and GPL v3 files stay under those licences in their modified
form. They are data files that the app loads at run time. Rollfilm's own code
remains MIT.

Film stock and camera names appear in file names only to say which look a
table is made to approximate. Neither the authors above nor Rollfilm are
affiliated with or endorsed by the companies that own those names.

## Other bundled components

- **ExifTool** by Phil Harvey (<https://exiftool.org>). It is bundled
  unmodified under `exiftool/` in the app's resources. The version is pinned
  in `backend/build_backend.sh`. Free software under the same terms as Perl
  itself (Artistic License or GPL).
- **The frozen Python backend** bundles the packages pinned in
  `backend/requirements.lock` (among them PyTorch, OpenCV, NumPy, rawpy with
  LibRaw, lensfunpy with the Lensfun database, and open_clip). Each package
  is under its own licence, as published on its project page and in its
  distribution.
- **Model weights** (CLIP, SegFormer) are not bundled. They are downloaded
  into the model cache on first use, under the licences of their publishers.

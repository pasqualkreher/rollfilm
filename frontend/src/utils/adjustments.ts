import type { CropBox, ImageOut } from "../api/types";

// Non-destructive tonal/color slider edits, each -100..100 (0 = neutral).
// This mirrors the backend pipeline in services/thumbnails.py exactly, so the
// live canvas preview matches the saved render. Keep the two in sync.
export interface Adjustments {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  dehaze: number;
  saturation: number;
  temperature: number;
  tint: number;
}

export const NEUTRAL: Adjustments = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  dehaze: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
};

// UI order + labels for the editor sliders.
export const ADJUSTMENT_DEFS: { key: keyof Adjustments; label: string }[] = [
  { key: "exposure", label: "Exposure" },
  { key: "contrast", label: "Contrast" },
  { key: "highlights", label: "Highlights" },
  { key: "shadows", label: "Shadows" },
  { key: "whites", label: "Whites" },
  { key: "blacks", label: "Blacks" },
  { key: "dehaze", label: "Dehaze" },
  { key: "saturation", label: "Saturation" },
  { key: "temperature", label: "Temperature" },
  { key: "tint", label: "Tint" },
];

export function adjustmentsFromImage(image: ImageOut): Adjustments {
  return {
    exposure: image.edit_exposure,
    contrast: image.edit_contrast,
    highlights: image.edit_highlights,
    shadows: image.edit_shadows,
    whites: image.edit_whites,
    blacks: image.edit_blacks,
    dehaze: image.edit_dehaze,
    saturation: image.edit_saturation,
    temperature: image.edit_temperature,
    tint: image.edit_tint,
  };
}

export function isNeutral(a: Adjustments): boolean {
  return (Object.keys(NEUTRAL) as (keyof Adjustments)[]).every((k) => a[k] === 0);
}

// Per-hue colour mixer. Each band carries [hueShift, saturation, luminance],
// each -100..100. Band centres split the hue circle; a pixel blends between the
// two bands bounding its segment. Order + edges MUST match the backend.
export const COLOR_BANDS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"] as const;
export type ColorBand = (typeof COLOR_BANDS)[number];
export type ColorMix = Record<ColorBand, [number, number, number]>;
const BAND_EDGES = [0, 30, 60, 120, 180, 240, 280, 320, 360];
// A dot colour per band for the UI selector.
export const BAND_SWATCH: Record<ColorBand, string> = {
  red: "#e5484d",
  orange: "#e8912a",
  yellow: "#e5c022",
  green: "#46a758",
  aqua: "#2ac4c4",
  blue: "#3a6df0",
  purple: "#8e5ce6",
  magenta: "#d64ba8",
};

export function neutralMix(): ColorMix {
  return Object.fromEntries(COLOR_BANDS.map((b) => [b, [0, 0, 0]])) as ColorMix;
}

export function mixIsNeutral(mix: ColorMix): boolean {
  return COLOR_BANDS.every((b) => mix[b].every((v) => v === 0));
}

// The full non-destructive edit: tonal sliders, geometry (rotation + crop),
// the colour mixer and a vignette.
export interface ImageEdits extends Adjustments {
  rotation: number; // absolute, multiple of 90
  crop: CropBox | null;
  colorMix: ColorMix;
  vignette: number;
  distortion: number;
  grain: number; // 0..100
  grainSize: number; // 0..100 (coarseness)
  denoise: number; // 0..100
  clarity: number; // -100..100
  sharpness: number; // -100..100 (negative softens)
  colorTint: number; // global hue rotation, -100..100
  chromeEffect: number; // Fuji Color Chrome Effect, 0..100
  chromeBlue: number; // Fuji Color Chrome FX Blue, 0..100
  mist: number; // Pro-Mist diffusion (highlight bloom), 0..100
}

export function editsFromImage(image: ImageOut): ImageEdits {
  const mix = neutralMix();
  if (image.edit_color_mix) {
    try {
      const parsed = JSON.parse(image.edit_color_mix) as Partial<Record<ColorBand, number[]>>;
      for (const b of COLOR_BANDS) {
        const v = parsed[b];
        if (v) mix[b] = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
      }
    } catch {
      /* ignore malformed */
    }
  }
  return {
    ...adjustmentsFromImage(image),
    rotation: image.edit_rotation,
    crop:
      image.edit_crop_x !== null
        ? {
            x: image.edit_crop_x,
            y: image.edit_crop_y as number,
            width: image.edit_crop_width as number,
            height: image.edit_crop_height as number,
          }
        : null,
    colorMix: mix,
    vignette: image.edit_vignette,
    distortion: image.edit_distortion,
    grain: image.edit_grain,
    grainSize: image.edit_grain_size,
    denoise: image.edit_denoise,
    clarity: image.edit_clarity,
    sharpness: image.edit_sharpness,
    colorTint: image.edit_color_tint,
    chromeEffect: image.edit_chrome_effect,
    chromeBlue: image.edit_chrome_blue,
    mist: image.edit_mist,
  };
}

const LR = 0.2126;
const LG = 0.7152;
const LB = 0.0722;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// RGB<->HSL, matching the backend's numpy versions exactly (h in [0,360)).
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  const l = (mx + mn) / 2;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1) + 1e-9);
  let h: number;
  if (mx === r) h = ((((g - b) / d) % 6) + 6) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (((h * 60) % 360) + 360) % 360;
  return [h, clamp01(s), l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((((h % 360) + 360) % 360) / 60);
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let bl = 0;
  if (hp < 1) [r, g, bl] = [c, x, 0];
  else if (hp < 2) [r, g, bl] = [x, c, 0];
  else if (hp < 3) [r, g, bl] = [0, c, x];
  else if (hp < 4) [r, g, bl] = [0, x, c];
  else if (hp < 5) [r, g, bl] = [x, 0, c];
  else [r, g, bl] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, bl + m];
}

export interface PixelEdits extends Adjustments {
  colorMix?: ColorMix;
  vignette?: number;
  colorTint?: number;
  chromeEffect?: number;
  chromeBlue?: number;
}

// Apply the edits to `src` (RGBA bytes) into `dst`, both length width*height*4.
// A single tight per-pixel pass so it runs live on each slider move. The maths
// and order mirror the backend (services/thumbnails) so preview == saved render.
// Note: dehaze and denoise are *spatial* passes (see dehaze()/denoise() below),
// run before this per-pixel pass - `adj.dehaze` is ignored here.
export function applyAdjustments(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  adj: PixelEdits,
  width: number,
  height: number
): void {
  const e = adj.exposure / 100;
  const c = adj.contrast / 100;
  const hi = adj.highlights / 100;
  const sh = adj.shadows / 100;
  const wh = adj.whites / 100;
  const bl = adj.blacks / 100;
  const s = adj.saturation / 100;
  const t = adj.temperature / 100;
  const n = adj.tint / 100;
  const vig = (adj.vignette ?? 0) / 100;
  const tintRot = (adj.colorTint ?? 0) / 100;
  const chrome = (adj.chromeEffect ?? 0) / 100;
  const chromeB = (adj.chromeBlue ?? 0) / 100;
  const mix = adj.colorMix;
  const useMix = (!!mix && !mixIsNeutral(mix)) || tintRot !== 0;

  const gain = e ? Math.pow(2, 2 * e) : 1; // +/- two stops at the extremes
  const rWb = 1 + 0.3 * t;
  const bWb = 1 - 0.3 * t;
  const gWb = 1 - 0.3 * n;
  // Contrast as a filmic S-curve blend (see the backend comment) - soft
  // highlight shoulder/black toe instead of the old clipping linear stretch.
  const cs = Math.min(1, Math.max(-1, 1.6 * c));
  const sat = 1 + s;

  for (let i = 0; i < src.length; i += 4) {
    let r = src[i] / 255;
    let g = src[i + 1] / 255;
    let b = src[i + 2] / 255;

    if (e) {
      r *= gain;
      g *= gain;
      b *= gain;
    }
    if (t) {
      r *= rWb;
      b *= bWb;
    }
    if (n) g *= gWb;
    r = clamp01(r);
    g = clamp01(g);
    b = clamp01(b);

    if (hi || sh) {
      // Fuji-style tone masks (see the backend comment): the shadows lift fades
      // to zero at pure black (film toe stays dense) and highlights fade to
      // zero at pure white (Whites owns the top end).
      const luma = r * LR + g * LG + b * LB;
      if (sh) {
        const m = sh * 0.7 * (1 - luma) * (1 - luma) * Math.pow(luma, 0.4);
        r += m;
        g += m;
        b += m;
      }
      if (hi) {
        const m = hi * 0.6 * luma * luma * Math.pow(1 - luma, 0.4);
        r += m;
        g += m;
        b += m;
      }
      r = clamp01(r);
      g = clamp01(g);
      b = clamp01(b);
    }

    if (wh || bl) {
      const luma = r * LR + g * LG + b * LB;
      if (wh) {
        const m = wh * 0.5 * luma * luma * luma;
        r += m;
        g += m;
        b += m;
      }
      if (bl) {
        const d = 1 - luma;
        const m = bl * 0.5 * d * d * d;
        r += m;
        g += m;
        b += m;
      }
      r = clamp01(r);
      g = clamp01(g);
      b = clamp01(b);
    }

    if (c) {
      r = clamp01(r + cs * (r * r * (3 - 2 * r) - r));
      g = clamp01(g + cs * (g * g * (3 - 2 * g) - g));
      b = clamp01(b + cs * (b * b * (3 - 2 * b) - b));
    }

    if (useMix) {
      const [h0, s0, l0] = rgbToHsl(r, g, b);
      let hueShift = 0;
      let satAdj = 0;
      let lumAdj = 0;
      if (mix) {
        for (let j = 0; j < 8; j++) {
          const lo = BAND_EDGES[j];
          const hiEdge = BAND_EDGES[j + 1];
          if (h0 >= lo && h0 < hiEdge) {
            const tt = (h0 - lo) / (hiEdge - lo);
            const b0 = mix[COLOR_BANDS[j]];
            const b1 = mix[COLOR_BANDS[(j + 1) % 8]];
            hueShift = (1 - tt) * b0[0] + tt * b1[0];
            satAdj = (1 - tt) * b0[1] + tt * b1[1];
            lumAdj = (1 - tt) * b0[2] + tt * b1[2];
            break;
          }
        }
      }
      const nh = (((h0 + hueShift * 1.8 + tintRot * 180) % 360) + 360) % 360;
      const ns = clamp01(s0 * (1 + satAdj / 100));
      [r, g, b] = hslToRgb(nh, ns, l0);
      if (lumAdj) {
        // Brightness scale (preserves colour) rather than moving HSL lightness.
        // Gated by a ramp on the pixel's original saturation (s0) so near-neutral
        // tones stay put while genuinely-coloured pixels get the full, visible
        // response - matches the backend (was a flat `0.5 * s0`, which made the
        // slider nearly a no-op on ordinary photos).
        const satWeight = Math.min(1, Math.max(0, (s0 - 0.08) * 2.2));
        const f = 1 + (lumAdj / 100) * 0.9 * satWeight;
        r = clamp01(r * f);
        g = clamp01(g * f);
        b = clamp01(b * f);
      }
    }

    // Fuji Color Chrome Effect / FX Blue (see backend _apply_chrome): darken
    // colourful pixels (all hues / a window around blue) so they deepen and
    // gain gradation. Weighted by *chroma*, not HSL saturation - HSL sat blows
    // up to ~1 near white/black, which turned bright cloud pixels into blotchy
    // dark artifacts; chroma fades to zero at the tonal extremes.
    if (chrome || chromeB) {
      const [hc, sc, lc] = rgbToHsl(r, g, b);
      const chromaW = Math.min(1, sc * (1 - Math.abs(2 * lc - 1)) * 1.4);
      let factor = 1;
      if (chrome) factor *= 1 - 0.32 * chrome * Math.pow(chromaW, 1.5);
      if (chromeB) {
        let angDist = Math.abs(hc - 250);
        angDist = Math.min(angDist, 360 - angDist);
        const window = angDist < 90 ? 0.5 + 0.5 * Math.cos((Math.PI * angDist) / 90) : 0;
        factor *= 1 - 0.35 * chromeB * chromaW * window;
      }
      if (factor !== 1) {
        r = clamp01(r * factor);
        g = clamp01(g * factor);
        b = clamp01(b * factor);
      }
    }

    if (s) {
      const luma = r * LR + g * LG + b * LB;
      r = luma + (r - luma) * sat;
      g = luma + (g - luma) * sat;
      b = luma + (b - luma) * sat;
    }
    r = clamp01(r);
    g = clamp01(g);
    b = clamp01(b);

    if (vig) {
      const p = i >> 2;
      const nx = width > 1 ? (((p % width) / (width - 1)) * 2 - 1) : 0;
      const ny = height > 1 ? ((((p / width) | 0) / (height - 1)) * 2 - 1) : 0;
      const r2 = Math.min(Math.max((nx * nx + ny * ny) / 2, 0), 1);
      const vf = 1 + vig * r2;
      r = clamp01(r * vf);
      g = clamp01(g * vf);
      b = clamp01(b * vf);
    }

    dst[i] = r * 255 + 0.5;
    dst[i + 1] = g * 255 + 0.5;
    dst[i + 2] = b * 255 + 0.5;
    dst[i + 3] = src[i + 3];
  }
}

// Radial lens-distortion correction (geometric), mirroring the backend's numpy
// version exactly (nearest sampling). Returns a new ImageData; input untouched.
export function applyDistortion(src: ImageData, amount: number): ImageData {
  const w = src.width;
  const h = src.height;
  const out = new ImageData(w, h);
  const k = (amount / 100) * 0.25;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const half = Math.max(w, h) / 2; // common scale -> circular, aspect-correct
  const s = src.data;
  const d = out.data;
  for (let y = 0; y < h; y++) {
    const dy = (y - cy) / half;
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / half;
      const factor = 1 + k * (dx * dx + dy * dy);
      let sx = Math.round(cx + (x - cx) * factor);
      let sy = Math.round(cy + (y - cy) * factor);
      if (sx < 0) sx = 0;
      else if (sx > w - 1) sx = w - 1;
      if (sy < 0) sy = 0;
      else if (sy > h - 1) sy = h - 1;
      const di = (y * w + x) * 4;
      const si = (sy * w + sx) * 4;
      d[di] = s[si];
      d[di + 1] = s[si + 1];
      d[di + 2] = s[si + 2];
      d[di + 3] = s[si + 3];
    }
  }
  return out;
}

// Real dehaze, mirroring the backend's dark-channel prior (approximate at
// preview scale - canvas blur stands in for the Gaussian, like clarity).
// Positive: estimate atmospheric light A (per-channel 99.5th percentile),
// build a transmission map from the patch-eroded dark channel of I/A at
// quarter scale, smooth + upsample it, then recover J = (I - A)/t + A.
// Negative: physically add a neutral veil. Returns a new ImageData.
export function dehaze(img: ImageData, amount: number): ImageData {
  const w = img.width;
  const h = img.height;
  const s = img.data;
  const out = new ImageData(w, h);
  const d = out.data;
  const dh = amount / 100;

  if (dh < 0) {
    const t = 1 + 0.45 * dh;
    const veil = 0.93 * (1 - t) * 255;
    for (let i = 0; i < s.length; i += 4) {
      d[i] = s[i] * t + veil;
      d[i + 1] = s[i + 1] * t + veil;
      d[i + 2] = s[i + 2] * t + veil;
      d[i + 3] = s[i + 3];
    }
    return out;
  }

  // Atmospheric light per channel via histogram percentiles.
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const total = w * h;
  for (let i = 0; i < s.length; i += 4) {
    hist[0][s[i]]++;
    hist[1][s[i + 1]]++;
    hist[2][s[i + 2]]++;
  }
  const A = [0.5, 0.5, 0.5];
  for (let ch = 0; ch < 3; ch++) {
    let cum = 0;
    const target = total * 0.995;
    for (let v = 0; v < 256; v++) {
      cum += hist[ch][v];
      if (cum >= target) {
        A[ch] = Math.min(1, Math.max(0.5, v / 255));
        break;
      }
    }
  }

  // Dark channel of I/A at quarter scale (block-min over each 4x4 tile).
  const sw = Math.ceil(w / 4);
  const sh = Math.ceil(h / 4);
  let dark = new Float32Array(sw * sh).fill(1);
  for (let y = 0; y < h; y++) {
    const row = (y >> 2) * sw;
    const off = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = off + x * 4;
      const v = Math.min(s[i] / 255 / A[0], s[i + 1] / 255 / A[1], s[i + 2] / 255 / A[2], 1);
      const di = row + (x >> 2);
      if (v < dark[di]) dark[di] = v;
    }
  }

  // Separable min-filter (patch erosion) on the small dark channel.
  const radius = Math.max(2, Math.round(Math.max(sw, sh) / 50));
  for (let pass = 0; pass < 2; pass++) {
    const eroded = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        let m = 1;
        if (pass === 0) {
          const lo = Math.max(0, x - radius);
          const hiX = Math.min(sw - 1, x + radius);
          for (let k = lo; k <= hiX; k++) m = Math.min(m, dark[y * sw + k]);
        } else {
          const lo = Math.max(0, y - radius);
          const hiY = Math.min(sh - 1, y + radius);
          for (let k = lo; k <= hiY; k++) m = Math.min(m, dark[k * sw + x]);
        }
        eroded[y * sw + x] = m;
      }
    }
    dark = eroded;
  }

  // Smooth (canvas blur) + upsample the transmission back to full size.
  const smallC = document.createElement("canvas");
  smallC.width = sw;
  smallC.height = sh;
  const sctx = smallC.getContext("2d")!;
  const smallImg = sctx.createImageData(sw, sh);
  for (let i = 0; i < dark.length; i++) {
    const v = dark[i] * 255;
    smallImg.data[i * 4] = v;
    smallImg.data[i * 4 + 1] = v;
    smallImg.data[i * 4 + 2] = v;
    smallImg.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(smallImg, 0, 0);
  // Blur at the *small* scale first, then upscale (backend match). Blurring
  // during the scaled drawImage would apply the radius in destination space -
  // ~4x less smoothing - leaving hard blocky transmission edges that showed up
  // as white blocky artifacts in bright skies.
  const blurC = document.createElement("canvas");
  blurC.width = sw;
  blurC.height = sh;
  const blurCtx = blurC.getContext("2d")!;
  blurCtx.filter = `blur(${radius}px)`;
  blurCtx.drawImage(smallC, 0, 0);
  blurCtx.filter = "none";
  const fullC = document.createElement("canvas");
  fullC.width = w;
  fullC.height = h;
  const fctx = fullC.getContext("2d")!;
  fctx.imageSmoothingEnabled = true;
  fctx.drawImage(blurC, 0, 0, sw, sh, 0, 0, w, h);
  const darkFull = fctx.getImageData(0, 0, w, h).data;

  // Floor t at 0.4 (max ~2.5x amplification) and fade the effect out in the
  // highlights: bright clouds/sky sit at the atmospheric colour itself, where
  // the 1/t recovery blows tiny variations into clipped-white blobs (backend
  // match - see _dehaze).
  const strength = 0.85 * dh;
  for (let i = 0; i < s.length; i += 4) {
    const t = Math.max(0.4, 1 - strength * (darkFull[i] / 255));
    const r0 = s[i] / 255;
    const g0 = s[i + 1] / 255;
    const b0 = s[i + 2] / 255;
    const luma = Math.min(1, Math.max(0, r0 * LR + g0 * LG + b0 * LB));
    const keep = 1 - Math.min(1, Math.max(0, (luma - 0.75) / 0.2)) * 0.85;
    d[i] = Math.min(255, Math.max(0, r0 + ((r0 - A[0]) / t + A[0] - r0) * keep) * 255);
    d[i + 1] = Math.min(255, Math.max(0, g0 + ((g0 - A[1]) / t + A[1] - g0) * keep) * 255);
    d[i + 2] = Math.min(255, Math.max(0, b0 + ((b0 - A[2]) / t + A[2] - b0) * keep) * 255);
    d[i + 3] = s[i + 3];
  }
  return out;
}

// Real(istic) denoise, mirroring the backend: chroma noise is smoothed hard in
// YCbCr space (a canvas Gaussian on the whole image supplies the blurred
// chroma - blurring RGB then converting is the same as blurring the chroma
// planes, since the transform is linear), while luminance gets a gentle
// edge-keeping 3x3 median blend so texture survives. Returns a new ImageData.
export function denoise(img: ImageData, amount: number): ImageData {
  const w = img.width;
  const h = img.height;
  const f = Math.min(100, Math.max(0, amount)) / 100;
  if (f <= 0) return img;
  const s = img.data;

  // Blurred copy (for chroma), radius matching the backend.
  const rad = 0.5 + f * (Math.max(w, h) / 400);
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  src.getContext("2d")!.putImageData(img, 0, 0);
  const bc = document.createElement("canvas");
  bc.width = w;
  bc.height = h;
  const bctx = bc.getContext("2d")!;
  bctx.filter = `blur(${rad}px)`;
  bctx.drawImage(src, 0, 0);
  bctx.filter = "none";
  const blur = bctx.getImageData(0, 0, w, h).data;

  // Luma plane (BT.601, matching PIL's YCbCr) + 3x3 median.
  const y0 = new Float32Array(w * h);
  for (let i = 0, p = 0; i < s.length; i += 4, p++) {
    y0[p] = 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];
  }
  const lumaBlend = Math.min(1, f * 1.2);
  const med = new Float32Array(w * h);
  const win = new Float32Array(9);
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1);
    const yp = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(w - 1, x + 1);
      win[0] = y0[ym * w + xm];
      win[1] = y0[ym * w + x];
      win[2] = y0[ym * w + xp];
      win[3] = y0[y * w + xm];
      win[4] = y0[y * w + x];
      win[5] = y0[y * w + xp];
      win[6] = y0[yp * w + xm];
      win[7] = y0[yp * w + x];
      win[8] = y0[yp * w + xp];
      // Median of 9 via partial selection sort (5 passes).
      for (let a = 0; a < 5; a++) {
        let mi = a;
        for (let b = a + 1; b < 9; b++) if (win[b] < win[mi]) mi = b;
        const tmp = win[a];
        win[a] = win[mi];
        win[mi] = tmp;
      }
      med[y * w + x] = win[4];
    }
  }

  // Recompose: cleaned luma + blurred chroma.
  const out = new ImageData(w, h);
  const d = out.data;
  for (let i = 0, p = 0; i < s.length; i += 4, p++) {
    const cb = -0.168736 * blur[i] - 0.331264 * blur[i + 1] + 0.5 * blur[i + 2];
    const cr = 0.5 * blur[i] - 0.418688 * blur[i + 1] - 0.081312 * blur[i + 2];
    const yy = y0[p] + lumaBlend * (med[p] - y0[p]);
    d[i] = yy + 1.402 * cr;
    d[i + 1] = yy - 0.344136 * cb - 0.714136 * cr;
    d[i + 2] = yy + 1.772 * cb;
    d[i + 3] = s[i + 3];
  }
  return out;
}

// Pro-Mist-style diffusion (mirrors the backend _mist): screen-blend a
// large-radius blur of the image, weighted toward its highlights, over the
// sharp original - bright areas bloom and halate softly while shadows and
// midtone detail stay intact. Runs on the toned image. Returns a new ImageData.
export function mist(img: ImageData, amount: number): ImageData {
  const w = img.width;
  const h = img.height;
  const f = Math.min(100, Math.max(0, amount)) / 100;
  if (f <= 0) return img;
  const radius = Math.max(8, Math.max(w, h) / 25);
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  src.getContext("2d")!.putImageData(img, 0, 0);
  const bc = document.createElement("canvas");
  bc.width = w;
  bc.height = h;
  const bctx = bc.getContext("2d")!;
  bctx.filter = `blur(${radius}px)`;
  bctx.drawImage(src, 0, 0);
  bctx.filter = "none";
  const blur = bctx.getImageData(0, 0, w, h).data;
  const out = new ImageData(w, h);
  const s = img.data;
  const d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    const lb = Math.min(1, Math.max(0, (blur[i] * LR + blur[i + 1] * LG + blur[i + 2] * LB) / 255));
    const gw = Math.pow(lb, 1.2) * 0.85 * f;
    for (let c = 0; c < 3; c++) {
      const v = s[i + c] / 255;
      const glow = Math.min(1, (blur[i + c] / 255) * gw);
      d[i + c] = (1 - (1 - v) * (1 - glow)) * 255 + 0.5;
    }
    d[i + 3] = s[i + 3];
  }
  return out;
}

// Unsharp mask (clarity / sharpness): out = in + amount*(in - blur(in)). Uses a
// canvas Gaussian blur; mirrors the backend but is approximate at preview scale.
export function unsharp(input: ImageData, radius: number, amount: number): ImageData {
  const w = input.width;
  const h = input.height;
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  src.getContext("2d")!.putImageData(input, 0, 0);
  const bc = document.createElement("canvas");
  bc.width = w;
  bc.height = h;
  const bctx = bc.getContext("2d")!;
  bctx.filter = `blur(${radius}px)`;
  bctx.drawImage(src, 0, 0);
  bctx.filter = "none";
  const blur = bctx.getImageData(0, 0, w, h).data;
  const out = new ImageData(w, h);
  const s = input.data;
  const d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    d[i] = clamp01((s[i] + amount * (s[i] - blur[i])) / 255) * 255 + 0.5;
    d[i + 1] = clamp01((s[i + 1] + amount * (s[i + 1] - blur[i + 1])) / 255) * 255 + 0.5;
    d[i + 2] = clamp01((s[i + 2] + amount * (s[i + 2] - blur[i + 2])) / 255) * 255 + 0.5;
    d[i + 3] = s[i + 3];
  }
  return out;
}

// Fujifilm-style clarity: large-radius local contrast weighted to the midtones.
export function clarity(input: ImageData, radius: number, amount: number): ImageData {
  const w = input.width;
  const h = input.height;
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  src.getContext("2d")!.putImageData(input, 0, 0);
  const bc = document.createElement("canvas");
  bc.width = w;
  bc.height = h;
  const bctx = bc.getContext("2d")!;
  bctx.filter = `blur(${radius}px)`;
  bctx.drawImage(src, 0, 0);
  bctx.filter = "none";
  const blur = bctx.getImageData(0, 0, w, h).data;
  const out = new ImageData(w, h);
  const s = input.data;
  const d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    const rr = s[i] / 255;
    const gg = s[i + 1] / 255;
    const bb = s[i + 2] / 255;
    const luma = rr * LR + gg * LG + bb * LB;
    // Raised tent (^1.5) mask - eases out toward the tonal extremes (backend match).
    const mask = Math.pow(1 - Math.abs(2 * luma - 1), 1.5);
    d[i] = clamp01(rr + amount * ((s[i] - blur[i]) / 255) * mask) * 255 + 0.5;
    d[i + 1] = clamp01(gg + amount * ((s[i + 1] - blur[i + 1]) / 255) * mask) * 255 + 0.5;
    d[i + 2] = clamp01(bb + amount * ((s[i + 2] - blur[i + 2]) / 255) * mask) * 255 + 0.5;
    d[i + 3] = s[i + 3];
  }
  return out;
}

// Sum of 3 uniforms, centred and scaled to roughly [-1,1] with a bell-shaped
// (Irwin-Hall) distribution - much closer to how photographic grain amplitude
// is actually distributed than flat Math.random() noise, without the cost of
// a true Gaussian (Box-Muller) transform.
function grainNoise(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
}

// A film-grain noise field with a given particle size in pixels: noise at
// particle resolution, nearest-upscaled (hard speckle edges), then lightly
// blurred so particles read as soft irregular blobs rather than square
// pixels. Returns the field's red-channel bytes (grey field).
function grainField(w: number, h: number, particlePx: number): Uint8ClampedArray {
  const nw = Math.min(w, Math.max(1, Math.round(w / particlePx)));
  const nh = Math.min(h, Math.max(1, Math.round(h / particlePx)));
  const small = document.createElement("canvas");
  small.width = nw;
  small.height = nh;
  const sctx = small.getContext("2d")!;
  const nd = sctx.createImageData(nw, nh);
  for (let i = 0; i < nd.data.length; i += 4) {
    const v = Math.min(255, Math.max(0, 128 + grainNoise() * 90));
    nd.data[i] = v;
    nd.data[i + 1] = v;
    nd.data[i + 2] = v;
    nd.data[i + 3] = 255;
  }
  sctx.putImageData(nd, 0, 0);
  const full = document.createElement("canvas");
  full.width = w;
  full.height = h;
  const fctx = full.getContext("2d")!;
  fctx.imageSmoothingEnabled = false;
  fctx.drawImage(small, 0, 0, w, h);
  const soft = document.createElement("canvas");
  soft.width = w;
  soft.height = h;
  const softCtx = soft.getContext("2d")!;
  softCtx.filter = `blur(${Math.max(0.35, particlePx * 0.4)}px)`;
  softCtx.drawImage(full, 0, 0);
  softCtx.filter = "none";
  return softCtx.getImageData(0, 0, w, h).data;
}

// Fuji-style analog film grain (mirrors the backend _apply_grain): a fine base
// texture plus a coarser silver-halide "clump" layer, both with particle sizes
// scaled to the image resolution so preview grain == saved grain. Intensity
// follows a midtone bell like real film - strongest in the mids, fading into
// deep shadows and highlights. Monochromatic, like silver grain. Mutates
// `img`. Stochastic (pattern differs from the saved render).
export function applyGrain(img: ImageData, amount: number, size: number): void {
  const w = img.width;
  const h = img.height;
  const sizeF = size / 100;
  const longEdge = Math.max(w, h);

  // Low end is near-pixel salt (crisp fine-ISO texture); top end is chunky.
  const pFine = Math.max(0.7, (longEdge / 1500) * (0.35 + 1.25 * sizeF));
  const pClump = pFine * (2.2 + sizeF * 2.8);
  const fine = grainField(w, h, pFine);
  const clump = grainField(w, h, pClump);

  const fineWeight = 1 - 0.45 * sizeF;
  // Barely any clump layer at the fine end - its blobs read as "big grain".
  const clumpWeight = 0.15 + 0.6 * sizeF;
  const amt = (amount / 100) * 0.14 * 255;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const luma = Math.min(1, Math.max(0, (d[i] * LR + d[i + 1] * LG + d[i + 2] * LB) / 255));
    const midtone = Math.pow(4 * luma * (1 - luma), 0.75);
    const fineN = ((fine[i] - 128) / 90) * fineWeight;
    const clumpN = ((clump[i] - 128) / 90) * clumpWeight;
    const n = (fineN + clumpN) * amt * midtone;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
}

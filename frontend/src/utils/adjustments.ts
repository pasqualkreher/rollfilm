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
  denoise: number; // 0..100
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
    denoise: image.edit_denoise,
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
  grain?: number;
}

// Apply the edits to `src` (RGBA bytes) into `dst`, both length width*height*4.
// A single tight per-pixel pass so it runs live on each slider move. The maths
// and order mirror the backend (services/thumbnails) so preview == saved render.
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
  const dh = adj.dehaze / 100;
  const s = adj.saturation / 100;
  const t = adj.temperature / 100;
  const n = adj.tint / 100;
  const vig = (adj.vignette ?? 0) / 100;
  const grain = (adj.grain ?? 0) / 100;
  const mix = adj.colorMix;
  const useMix = !!mix && !mixIsNeutral(mix);

  const gain = e ? Math.pow(2, e) : 1;
  const rWb = 1 + 0.2 * t;
  const bWb = 1 - 0.2 * t;
  const gWb = 1 - 0.2 * n;
  const contrast = 1 + c;
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
      const luma = r * LR + g * LG + b * LB;
      if (sh) {
        const m = sh * 0.5 * (1 - luma) * (1 - luma);
        r += m;
        g += m;
        b += m;
      }
      if (hi) {
        const m = hi * 0.5 * luma * luma;
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
      r = clamp01((r - 0.5) * contrast + 0.5);
      g = clamp01((g - 0.5) * contrast + 0.5);
      b = clamp01((b - 0.5) * contrast + 0.5);
    }

    if (dh) {
      r = clamp01((r - dh * 0.05 - 0.5) * (1 + dh * 0.4) + 0.5);
      g = clamp01((g - dh * 0.05 - 0.5) * (1 + dh * 0.4) + 0.5);
      b = clamp01((b - dh * 0.05 - 0.5) * (1 + dh * 0.4) + 0.5);
      const luma = r * LR + g * LG + b * LB;
      r = clamp01(luma + (r - luma) * (1 + dh * 0.4));
      g = clamp01(luma + (g - luma) * (1 + dh * 0.4));
      b = clamp01(luma + (b - luma) * (1 + dh * 0.4));
    }

    if (useMix) {
      const [h0, s0, l0] = rgbToHsl(r, g, b);
      let hueShift = 0;
      let satAdj = 0;
      let lumAdj = 0;
      for (let j = 0; j < 8; j++) {
        const lo = BAND_EDGES[j];
        const hiEdge = BAND_EDGES[j + 1];
        if (h0 >= lo && h0 < hiEdge) {
          const tt = (h0 - lo) / (hiEdge - lo);
          const b0 = mix![COLOR_BANDS[j]];
          const b1 = mix![COLOR_BANDS[(j + 1) % 8]];
          hueShift = (1 - tt) * b0[0] + tt * b1[0];
          satAdj = (1 - tt) * b0[1] + tt * b1[1];
          lumAdj = (1 - tt) * b0[2] + tt * b1[2];
          break;
        }
      }
      const nh = (((h0 + hueShift * 0.3) % 360) + 360) % 360;
      const ns = clamp01(s0 * (1 + satAdj / 100));
      const nl = clamp01(l0 + (lumAdj / 100) * 0.25);
      [r, g, b] = hslToRgb(nh, ns, nl);
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

    if (grain) {
      // Monochrome film grain (stochastic - pattern differs from the saved
      // render but the intensity matches).
      const nz = (Math.random() - 0.5) * grain * 0.2;
      r = clamp01(r + nz);
      g = clamp01(g + nz);
      b = clamp01(b + nz);
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
  const k = (amount / 100) * 0.4;
  const s = src.data;
  const d = out.data;
  for (let y = 0; y < h; y++) {
    const ny = h > 1 ? (y / (h - 1)) * 2 - 1 : 0;
    for (let x = 0; x < w; x++) {
      const nx = w > 1 ? (x / (w - 1)) * 2 - 1 : 0;
      const factor = 1 + k * (nx * nx + ny * ny);
      let sx = Math.round(((nx * factor + 1) / 2) * (w - 1));
      let sy = Math.round(((ny * factor + 1) / 2) * (h - 1));
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

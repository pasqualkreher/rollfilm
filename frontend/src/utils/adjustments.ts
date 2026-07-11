import type { CropBox, ImageOut } from "../api/types";

// Non-destructive edit *state* for the editor UI. All rendering - including
// the live editor preview - happens server-side in the backend pipeline
// (backend/app/services/thumbnails.py), so there is exactly one
// implementation of every effect and the preview is always pixel-identical
// to the saved result. This module only carries the value types, defaults
// and (de)serialisation helpers.

// Tonal/color slider edits, each -100..100 (0 = neutral).
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
// two bands bounding its segment (rendered by the backend).
export const COLOR_BANDS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"] as const;
export type ColorBand = (typeof COLOR_BANDS)[number];
export type ColorMix = Record<ColorBand, [number, number, number]>;
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
// the colour mixer and the effect amounts.
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

// A fully-neutral edit that keeps the given geometry - used by the editor's
// hold-to-compare so the frame doesn't jump while showing the original.
export function neutralEdits(rotation: number, crop: CropBox | null): ImageEdits {
  return {
    ...NEUTRAL,
    rotation,
    crop,
    colorMix: neutralMix(),
    vignette: 0,
    distortion: 0,
    grain: 0,
    grainSize: 0,
    denoise: 0,
    clarity: 0,
    sharpness: 0,
    colorTint: 0,
    chromeEffect: 0,
    chromeBlue: 0,
    mist: 0,
  };
}

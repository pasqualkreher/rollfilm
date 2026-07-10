import { NEUTRAL, neutralMix, COLOR_BANDS, type Adjustments, type ColorBand, type ColorMix } from "./adjustments";

// Fujifilm-style film simulations, expressed purely as parameter sets on top of
// the existing (already preview/backend-matched) adjustment pipeline. Values
// are tuned to approximate each simulation's well-known character - punchy
// Velvia greens, muted Classic Chrome, deep-black Acros, etc. - without any
// new rendering code, so preview == saved render for free.
export interface FilmSimDef {
  id: string;
  label: string;
  description: string;
  swatch: string; // CSS background for the picker chip
  adj?: Partial<Adjustments>;
  colorMix?: Partial<Record<ColorBand, [number, number, number]>>;
  grain?: number;
  grainSize?: number;
  clarity?: number;
}

// "No simulation" - resets the fields below to neutral.
export const NONE_SIM: FilmSimDef = {
  id: "none",
  label: "None",
  description: "No film simulation",
  swatch: "linear-gradient(135deg, #8a8a8a, #cfcfcf)",
};

export const FILM_SIMULATIONS: FilmSimDef[] = [
  {
    id: "provia",
    label: "Provia",
    description: "Standard - balanced, everyday colour",
    swatch: "linear-gradient(135deg, #8fa6c9, #cbc4a6)",
    adj: { contrast: 4, saturation: 4 },
    clarity: 4,
  },
  {
    id: "velvia",
    label: "Velvia",
    description: "Vivid - punchy, saturated landscapes",
    swatch: "linear-gradient(135deg, #1f8f4e, #1c5fd1)",
    adj: { contrast: 18, saturation: 32, shadows: -8, whites: 6 },
    colorMix: { green: [-4, 22, 0], blue: [0, 18, 0], red: [0, 10, 0] },
    clarity: 14,
  },
  {
    id: "astia",
    label: "Astia",
    description: "Soft - gentle contrast, flattering skin tones",
    swatch: "linear-gradient(135deg, #f0c9b0, #f7e0d0)",
    adj: { contrast: -8, saturation: 8, highlights: -12, whites: -6 },
    colorMix: { orange: [0, -6, 4], red: [0, -4, 4] },
    clarity: -4,
  },
  {
    id: "classic-chrome",
    label: "Classic Chrome",
    description: "Muted, documentary-style colour",
    swatch: "linear-gradient(135deg, #6b6a52, #8a7a5c)",
    adj: { contrast: 16, saturation: -18, shadows: -14, dehaze: 10 },
    colorMix: { green: [-2, -22, -6], yellow: [-2, -14, -4], orange: [0, -10, 0] },
    grain: 12,
    grainSize: 20,
    clarity: 6,
  },
  {
    id: "classic-neg",
    label: "Classic Negative",
    description: "Deep shadows, cool cast, heavier grain",
    swatch: "linear-gradient(135deg, #3a4a5c, #7a6a5c)",
    adj: { contrast: 14, saturation: -10, shadows: -20, blacks: -8 },
    colorMix: { blue: [4, 12, -6], aqua: [4, 10, -6] },
    grain: 26,
    grainSize: 30,
    clarity: 4,
  },
  {
    id: "pro-neg-std",
    label: "Pro Neg. Std",
    description: "Soft gradation for portraits",
    swatch: "linear-gradient(135deg, #e0b8a0, #c9a488)",
    adj: { contrast: -10, saturation: -6, highlights: -10 },
    colorMix: { orange: [0, -8, 6], red: [0, -6, 6] },
    clarity: -6,
  },
  {
    id: "pro-neg-hi",
    label: "Pro Neg. Hi",
    description: "Firmer contrast portrait look",
    swatch: "linear-gradient(135deg, #c98f6e, #8a5a42)",
    adj: { contrast: 10, highlights: -4 },
    colorMix: { orange: [0, -4, 2] },
    clarity: 2,
  },
  {
    id: "eterna",
    label: "Eterna",
    description: "Flat, cinematic - low contrast, wide range",
    swatch: "linear-gradient(135deg, #5a6a72, #8a9aa2)",
    adj: { contrast: -24, saturation: -32, highlights: -22, shadows: 16, dehaze: -18 },
    grain: 6,
    clarity: -10,
  },
  {
    id: "eterna-bleach",
    label: "Eterna Bleach Bypass",
    description: "Harsh, desaturated, high contrast",
    swatch: "linear-gradient(135deg, #2a2a2a, #9a9a9a)",
    adj: { contrast: 28, saturation: -55, whites: 10, blacks: -10 },
    grain: 14,
    clarity: 18,
  },
  {
    id: "acros",
    label: "Acros",
    description: "Fine-grain black & white, deep blacks",
    swatch: "linear-gradient(135deg, #1a1a1a, #e8e8e8)",
    adj: { saturation: -100, contrast: 12, blacks: -14, whites: 4 },
    grain: 16,
    grainSize: -10,
    clarity: 10,
  },
  {
    id: "monochrome",
    label: "Monochrome",
    description: "Plain black & white",
    swatch: "linear-gradient(135deg, #333333, #cccccc)",
    adj: { saturation: -100, contrast: 4 },
    grain: 4,
  },
  {
    id: "sepia",
    label: "Sepia",
    description: "Warm-toned, nearly monochrome",
    swatch: "linear-gradient(135deg, #704214, #c9a066)",
    adj: { saturation: -85, temperature: 26, tint: 6, contrast: 6, blacks: -8 },
    grain: 10,
  },
  {
    id: "nostalgic-neg",
    label: "Nostalgic Neg.",
    description: "Warm, faded highlights, retro feel",
    swatch: "linear-gradient(135deg, #8a6a4a, #c9986a)",
    adj: { contrast: -6, saturation: -6, highlights: -20, shadows: 12, temperature: 14 },
    colorMix: { orange: [0, 6, 4] },
    grain: 14,
    grainSize: 20,
  },
];

export interface ResolvedFilmSim {
  adj: Adjustments;
  colorMix: ColorMix;
  grain: number;
  grainSize: number;
  clarity: number;
}

// Blend a simulation toward neutral by `strength` (0..100), so a single
// "Intensity" slider gives an easy way to dial a look in or out.
export function resolveFilmSim(sim: FilmSimDef, strength: number): ResolvedFilmSim {
  const f = Math.min(100, Math.max(0, strength)) / 100;
  const adj: Adjustments = { ...NEUTRAL };
  if (sim.adj) {
    for (const k of Object.keys(sim.adj) as (keyof Adjustments)[]) {
      adj[k] = Math.round((sim.adj[k] as number) * f);
    }
  }
  const colorMix = neutralMix();
  if (sim.colorMix) {
    for (const b of COLOR_BANDS) {
      const v = sim.colorMix[b];
      if (v) colorMix[b] = [Math.round(v[0] * f), Math.round(v[1] * f), Math.round(v[2] * f)];
    }
  }
  return {
    adj,
    colorMix,
    grain: Math.round((sim.grain ?? 0) * f),
    grainSize: Math.round((sim.grainSize ?? 0) * f),
    clarity: Math.round((sim.clarity ?? 0) * f),
  };
}

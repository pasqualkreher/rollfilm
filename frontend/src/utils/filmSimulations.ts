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
  // Fuji Color Chrome Effect / FX Blue (0..100) - deepen saturated colours /
  // blues, the in-camera options that give the looks their depth.
  chromeEffect?: number;
  chromeBlue?: number;
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
    description: "Standard - balanced, true-to-life everyday colour",
    swatch: "linear-gradient(135deg, #8fa6c9, #cbc4a6)",
    // Fuji's baseline: a whisper of contrast + colour and slightly cleaner skies.
    adj: { contrast: 6, saturation: 6 },
    colorMix: { blue: [0, 6, -4] },
    clarity: 4,
    chromeEffect: 10,
  },
  {
    id: "velvia",
    label: "Velvia",
    description: "Vivid - punchy, saturated landscapes",
    swatch: "linear-gradient(135deg, #1f8f4e, #1c5fd1)",
    // Deep contrast + heavy saturation; the chrome effects supply the dense,
    // deepened rendering of saturated foliage/skies (instead of hand-tuned
    // luminance cuts), which is exactly what they do in-camera.
    adj: { contrast: 20, saturation: 34, shadows: -10, blacks: -4, whites: 4 },
    colorMix: { green: [-4, 26, -4], aqua: [-4, 18, -4], blue: [-2, 22, -4], red: [2, 14, 0] },
    clarity: 12,
    chromeEffect: 30,
    chromeBlue: 35,
  },
  {
    id: "astia",
    label: "Astia",
    description: "Soft - gentle contrast, flattering skin tones",
    swatch: "linear-gradient(135deg, #f0c9b0, #f7e0d0)",
    // Softer highlights, lifted skin, but greens/blues stay lively (Astia keeps
    // colour while taming contrast).
    adj: { contrast: -6, saturation: 6, highlights: -14, whites: -6, shadows: 4 },
    colorMix: { orange: [2, -6, 4], red: [2, -2, 2], green: [-2, 6, 0] },
    clarity: -4,
    chromeEffect: 10,
  },
  {
    id: "classic-chrome",
    label: "Classic Chrome",
    description: "Muted, documentary-style colour with olive-toned shadows",
    swatch: "linear-gradient(135deg, #6b6a52, #8a7a5c)",
    // Desaturated and matte, with oranges/yellows pushed toward olive and blues
    // held back - the restrained, editorial Chrome look.
    adj: { contrast: 12, saturation: -22, shadows: -6, blacks: -6, highlights: -4, dehaze: 6 },
    colorMix: {
      red: [4, -16, 0],
      orange: [6, -20, -4],
      yellow: [8, -16, -6],
      green: [-4, -16, -4],
      blue: [-4, -10, -6],
    },
    grain: 10,
    grainSize: 18,
    clarity: 4,
    chromeEffect: 45,
    chromeBlue: 15,
  },
  {
    id: "classic-neg",
    label: "Classic Negative",
    description: "Teal shadows, earthy tones - the Superia negative look",
    swatch: "linear-gradient(135deg, #2f5150, #8a6a52)",
    // Signature high-chroma-variance negative: blues/aquas swing to teal, greens
    // go yellow-earthy, reds warm up, shadows drop - punchy but not saturated.
    adj: { contrast: 16, saturation: -8, shadows: -16, blacks: -6, highlights: -6, temperature: 4 },
    colorMix: {
      red: [6, 8, 0],
      orange: [4, -6, -2],
      yellow: [6, -6, -2],
      green: [-8, -8, -4],
      aqua: [8, 12, -6],
      blue: [10, 12, -8],
    },
    grain: 22,
    grainSize: 28,
    clarity: 4,
    chromeEffect: 35,
    chromeBlue: 15,
  },
  {
    id: "pro-neg-std",
    label: "Pro Neg. Std",
    description: "Soft gradation, natural studio skin tones",
    swatch: "linear-gradient(135deg, #e0b8a0, #c9a488)",
    adj: { contrast: -12, saturation: -6, highlights: -8, shadows: 6 },
    colorMix: { orange: [0, -8, 4], red: [0, -6, 2] },
    clarity: -6,
  },
  {
    id: "pro-neg-hi",
    label: "Pro Neg. Hi",
    description: "Firmer contrast portrait look",
    swatch: "linear-gradient(135deg, #c98f6e, #8a5a42)",
    adj: { contrast: 10, highlights: -4, saturation: -2 },
    colorMix: { orange: [0, -4, 2] },
    clarity: 2,
  },
  {
    id: "eterna",
    label: "Eterna",
    description: "Flat, cinematic - low contrast, wide latitude",
    swatch: "linear-gradient(135deg, #5a6a72, #8a9aa2)",
    // Muted cine profile: gentle contrast, soft highlights, restrained colour
    // with a faint cool/green cast. Deliberately NO dehaze/blacks lift - the
    // old negative-dehaze veil turned it milky once dehaze became a real
    // atmospheric effect; Eterna is flat, not foggy. A touch of chrome keeps
    // the muted colours from going dead.
    adj: { contrast: -16, saturation: -28, highlights: -14, shadows: 10 },
    colorMix: { red: [0, -8, 0], green: [2, -6, 0], blue: [4, -4, -2] },
    grain: 5,
    clarity: -8,
    chromeEffect: 10,
  },
  {
    id: "eterna-bleach",
    label: "Eterna Bleach Bypass",
    description: "Silver, high-contrast, heavily desaturated",
    swatch: "linear-gradient(135deg, #2a2a2a, #9a9a9a)",
    adj: { contrast: 30, saturation: -55, whites: 10, blacks: -12, dehaze: 8 },
    grain: 14,
    clarity: 18,
  },
  {
    id: "acros",
    label: "Acros",
    description: "Fine-grain black & white - deep blacks, dark dramatic skies",
    swatch: "linear-gradient(135deg, #1a1a1a, #e8e8e8)",
    // The colour-mixer luminance runs *before* the desaturation, so darkening
    // blues/aquas acts like a red contrast filter on the B&W conversion -
    // Acros' signature dramatic skies and glowing skin.
    adj: { saturation: -100, contrast: 14, blacks: -16, whites: 4 },
    colorMix: { blue: [0, 0, -30], aqua: [0, 0, -18], orange: [0, 0, 8] },
    grain: 16,
    grainSize: 0,
    clarity: 12,
  },
  {
    id: "monochrome",
    label: "Monochrome",
    description: "Plain black & white with a hint of sky separation",
    swatch: "linear-gradient(135deg, #333333, #cccccc)",
    adj: { saturation: -100, contrast: 4 },
    colorMix: { blue: [0, 0, -12] },
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
    description: "Warm amber, soft faded highlights, retro feel",
    swatch: "linear-gradient(135deg, #8a6a4a, #c9986a)",
    adj: { contrast: -4, saturation: -4, highlights: -18, shadows: 10, blacks: 4, temperature: 14, tint: 2 },
    colorMix: { orange: [2, 8, 4], red: [2, 6, 2], blue: [-2, -8, -4] },
    grain: 14,
    grainSize: 20,
    chromeEffect: 25,
    chromeBlue: 10,
  },
];

export interface ResolvedFilmSim {
  adj: Adjustments;
  colorMix: ColorMix;
  grain: number;
  grainSize: number;
  clarity: number;
  chromeEffect: number;
  chromeBlue: number;
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
    chromeEffect: Math.round((sim.chromeEffect ?? 0) * f),
    chromeBlue: Math.round((sim.chromeBlue ?? 0) * f),
  };
}

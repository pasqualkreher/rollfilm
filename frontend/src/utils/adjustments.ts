import type { CropBox, ImageOut } from "../api/types";

// Non-destructive edit *state* for the editor UI. All rendering - including the
// live editor preview - happens server-side in the backend pipeline
// (backend/app/services/thumbnails.py + develop_effects.py), so there is exactly
// one implementation of every effect and the preview is always pixel-identical
// to the saved result. This module only carries the value types, defaults,
// ranges (kept 1:1 with backend/app/services/develop.py) and (de)serialisation.
//
// The whole develop state is one object (`Adjustments`) stored as JSON in
// `Image.edit_adjustments`; geometry (rotation/crop/flip/straighten/perspective/
// distortion) stays in its own columns and lives on `ImageEdits` alongside it.

// ---- Scalar adjustment spec: the single source of truth for keys/ranges/defaults.
// Mirrors SCALAR_SPEC in backend/app/services/develop.py - keep the two in sync.
export interface ScalarDef {
  def: number;
  min: number;
  max: number;
  step?: number;
  // Display divisor: the slider UI shows value/uiScale (so a +-200 internal
  // range reads as the classic +-100) while the stored/rendered value keeps
  // the full range. Purely cosmetic - backend and saved edits are untouched.
  uiScale?: number;
  // Stored with fractions although the slider moves in whole steps (no
  // `step`): the value is also set by something finer than its own slider.
  fractional?: boolean;
}

export const SCALAR_SPEC = {
  // Basic / tone
  // Exposure and the four region sliders reach past the classic +-5 EV /
  // +-100 - the backend keeps the tone curve monotone in the extended zone.
  exposure: { def: 0, min: -8, max: 8, step: 0.01 },
  brightness: { def: 0, min: -200, max: 200, uiScale: 2 },
  contrast: { def: 0, min: -100, max: 100 },
  highlights: { def: 0, min: -200, max: 200, uiScale: 2 },
  shadows: { def: 0, min: -200, max: 200, uiScale: 2 },
  whites: { def: 0, min: -200, max: 200, uiScale: 2 },
  blacks: { def: 0, min: -200, max: 200, uiScale: 2 },
  // White balance / presence
  // Fractional: the Kelvin slider writes both, and a 10 K step is a fraction
  // of one unit.
  temperature: { def: 0, min: -300, max: 300, fractional: true },
  tint: { def: 0, min: -250, max: 250, fractional: true },
  // The camera-style shift cross (components/WbShiftPad.tsx): one unit is one
  // step of the camera's grid, set in tenths.
  wb_shift_r: { def: 0, min: -9, max: 9, step: 0.1 },
  wb_shift_b: { def: 0, min: -9, max: 9, step: 0.1 },
  // Extended past the classic +-100: the backend clamps the chroma scale at
  // zero, so past -100 both settle at grayscale instead of inverting colours.
  vibrance: { def: 0, min: -200, max: 200, uiScale: 2 },
  saturation: { def: 0, min: -200, max: 200, uiScale: 2 },
  hue: { def: 0, min: -180, max: 180 },
  // Details
  sharpness: { def: 0, min: -100, max: 100 },
  sharpness_threshold: { def: 15, min: 0, max: 80 },
  clarity: { def: 0, min: -100, max: 100 },
  dehaze: { def: 0, min: -100, max: 100 },
  structure: { def: 0, min: -100, max: 100 },
  // High-ISO noise reduction, one slider per half of the noise. A "Denoise"
  // master over both used to sit here; see normalizeAdjustments() for how the
  // edits saved while it existed are folded into these two.
  luma_noise_reduction: { def: 0, min: 0, max: 100 },
  // How much fine texture the luma pass keeps at edges: 0 smooths everything,
  // 100 keeps texture (and grain) where the picture has structure.
  luma_noise_detail: { def: 50, min: 0, max: 100 },
  color_noise_reduction: { def: 0, min: 0, max: 100 },
  chromatic_aberration_red_cyan: { def: 0, min: -100, max: 100 },
  chromatic_aberration_blue_yellow: { def: 0, min: -100, max: 100 },
  // Effects
  glow_amount: { def: 0, min: 0, max: 100 },
  halation_amount: { def: 0, min: 0, max: 100 },
  flare_amount: { def: 0, min: 0, max: 100 },
  grain_amount: { def: 0, min: 0, max: 100 },
  grain_size: { def: 25, min: 0, max: 100 },
  grain_roughness: { def: 50, min: 0, max: 100 },
  vignette_amount: { def: 0, min: -100, max: 100 },
  vignette_midpoint: { def: 50, min: 0, max: 100 },
  vignette_roundness: { def: 0, min: -100, max: 100 },
  vignette_feather: { def: 50, min: 0, max: 100 },
  lut_intensity: { def: 100, min: 0, max: 100 },
  // Fujifilm-style extras kept from the original editor (not in RapidRAW).
  chrome_effect: { def: 0, min: 0, max: 100 },
  chrome_blue: { def: 0, min: 0, max: 100 },
  mist: { def: 0, min: 0, max: 100 },
  // Frame: white border width as a % of the shorter edge, composited last
  // (compositional, not tonal - lives under Transform, kept out of auto-develop).
  frame_width: { def: 0, min: 0, max: 20 },
  // Lens profile correction from the correction data the camera embeds in its
  // RAW (backend services/lens_profile.py): a 0/1 switch, on by default like the
  // camera's own JPEG, and the strength of its distortion and vignetting halves.
  // Lives under Transform, kept out of auto-develop.
  lens_profile: { def: 1, min: 0, max: 1 },
  lens_distortion: { def: 100, min: 0, max: 100 },
  lens_vignetting: { def: 100, min: 0, max: 100 },
} satisfies Record<string, ScalarDef>;

export type ScalarKey = keyof typeof SCALAR_SPEC;

export const LENS_KEYS = ["lens_profile", "lens_distortion", "lens_vignetting"] as const satisfies readonly ScalarKey[];

// ---- Nested adjustment groups (curves / grading / calibration / masks).
// Present in the object for round-trip preservation; Phase-1 UI only edits the
// scalars + HSL, but must not drop these when saving.
export const COLOR_BANDS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"] as const;
export type ColorBand = (typeof COLOR_BANDS)[number];
export type HslMix = Record<ColorBand, [number, number, number]>;
// Per-band Range, -100..100 (0 = the plain linear ramp between band centres):
// how far a band's edit carries into the neighbouring hues before the next band
// takes over. The weights still sum to 1 at every hue, so this only moves the
// handover - a band is always at full strength on its own centre hue.
export type HslRange = Record<ColorBand, number>;
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

export type CurvePoint = [number, number];
export type Curve = CurvePoint[];
export interface PointCurves {
  luma: Curve;
  red: Curve;
  green: Curve;
  blue: Curve;
}
export interface ParamCurveChannel {
  highlights: number;
  lights: number;
  darks: number;
  shadows: number;
  white_level: number;
  black_level: number;
  split1: number;
  split2: number;
  split3: number;
}
export interface ParametricCurve {
  luma: ParamCurveChannel;
  red: ParamCurveChannel;
  green: ParamCurveChannel;
  blue: ParamCurveChannel;
}
export interface GradeWheel {
  hue: number;
  saturation: number;
  luminance: number;
}
export interface ColorGrading {
  shadows: GradeWheel;
  midtones: GradeWheel;
  highlights: GradeWheel;
  global: GradeWheel;
  blending: number;
  balance: number;
}
export interface ColorCalibration {
  shadows_tint: number;
  red_hue: number;
  red_saturation: number;
  red_luminance: number;
  green_hue: number;
  green_saturation: number;
  green_luminance: number;
  blue_hue: number;
  blue_saturation: number;
  blue_luminance: number;
}
export type SubMaskType = "radial" | "linear" | "brush" | "luminance" | "color" | "edge" | "semantic";
export type SubMaskMode = "additive" | "subtractive" | "intersect";
// Brush stores `strokes` as [x, y, size][] (fractions of the frame); semantic
// stores its found region as a base64 PNG in `mask` plus the `subject` it was
// found for and the `geom` signature it was found under; every other parameter
// is a scalar. Coordinates/sizes are 0..1 so a mask drawn on the preview lands
// identically on the full-resolution render.
export type SubMaskParams = { [k: string]: number | number[][] | string };
export interface SubMask {
  id: string;
  type: SubMaskType;
  mode: SubMaskMode;
  visible: boolean;
  invert: boolean;
  parameters: SubMaskParams;
}
export interface MaskDef {
  id: string;
  name: string;
  visible: boolean;
  opacity: number; // 0..100
  invert: boolean;
  sub_masks: SubMask[];
  // Sparse local adjustments (only changed scalar keys, plus the mask's own
  // curve / colour mixer / colour grading while they are off their rest
  // state); the backend merges the defaults (develop._norm_mask_adjustments).
  adjustments: MaskAdjustments;
}
export type MaskAdjustments = Partial<Record<ScalarKey, number>> & {
  curve_mode?: "point" | "parametric";
  point_curves?: PointCurves;
  parametric_curve?: ParametricCurve;
  hsl?: HslMix;
  hsl_range?: HslRange;
  color_grading?: ColorGrading;
};

// A retouch spot (develop._norm_spot): a disc on the finished frame whose
// pixels are replaced by those of a second disc, the source. `heal` matches
// the source's tone to the spot's surroundings first; `clone` copies it as it
// is. Positions are fractions of the finished (cropped) frame, like a mask's;
// the radius a fraction of its long edge, like a brush size.
export type SpotKind = "heal" | "clone";
export interface SpotDef {
  id: string;
  kind: SpotKind;
  x: number;
  y: number;
  src_x: number;
  src_y: number;
  radius: number;
  feather: number; // 0..100
  opacity: number; // 0..100
}
export const SPOT_RADIUS_DEFAULT = 0.02;
export const SPOT_RADIUS_MIN = 0.001;
export const SPOT_RADIUS_MAX = 0.25;
export function newSpot(kind: SpotKind, x: number, y: number, radius: number, src?: { x: number; y: number }): SpotDef {
  return {
    id: _uid(),
    kind,
    x,
    y,
    src_x: src?.x ?? x,
    src_y: src?.y ?? y,
    radius: Math.max(SPOT_RADIUS_MIN, Math.min(SPOT_RADIUS_MAX, radius)),
    feather: 50,
    opacity: 100,
  };
}

// Built-in film simulation looks (rendered server-side in film_sims.py; the
// value list mirrors develop.ENUM_SPEC["film_sim"]). `lut_intensity` is the
// look's strength blend.
export type FilmSim =
  | "none"
  | "provia"
  | "velvia"
  | "astia"
  | "classic_chrome"
  | "reala_ace"
  | "pro_neg_hi"
  | "pro_neg_std"
  | "classic_neg"
  | "nostalgic_neg"
  | "eterna"
  | "eterna_bleach_bypass"
  | "acros"
  | "acros_ye"
  | "acros_r"
  | "acros_g"
  | "monochrome"
  | "monochrome_ye"
  | "monochrome_r"
  | "monochrome_g"
  | "sepia"
  // The analog film looks (film_sims.ANALOG_SIMS).
  | "kodak_portra_400"
  | "kodak_portra_800_push1"
  | "kodak_portra_800_push2"
  | "kodak_ektar_100"
  | "kodak_gold_200"
  | "kodak_ultramax_400"
  | "kodak_portra_160"
  | "kodak_portra_800"
  | "fujifilm_c200"
  | "fujifilm_pro_400h"
  | "fujifilm_xtra_400"
  | "kodak_vision3_50d"
  | "kodak_vision3_500t"
  | "kodak_vision3_250d"
  | "kodak_verita_200d"
  | "kodak_vision3_200t"
  | "kodak_kodachrome_64"
  | "kodak_ektachrome_100"
  | "fujifilm_provia_100f"
  | "fujifilm_velvia_100"
  | "kodak_doublex"
  | "kodak_vericolor_iii"
  | "kodak_aerocolor_iv"
  | "fuji_pro_160s"
  | "fuji_natura_1600"
  | "fuji_eterna_500"
  | "fuji_eterna_500_vivid"
  | "fuji_instax_color"
  | "cinestill_800t"
  | "kodak_5247_ii"
  | "kodak_exr_200t_5293"
  | "kodak_exr_100t_5248"
  | "kodak_vision_320t_5277"
  // The film scan looks (film_sims.CLUT_SIMS).
  | "kodak_portra_160_nc"
  | "kodak_portra_160_vc"
  | "kodak_portra_400_nc"
  | "kodak_portra_400_uc"
  | "kodak_portra_400_vc"
  | "kodak_colorplus_200"
  | "fuji_160c"
  | "fuji_800z"
  | "fuji_superia_100"
  | "fuji_superia_200"
  | "fuji_superia_400"
  | "fuji_superia_800"
  | "fuji_superia_1600"
  | "fuji_superia_hg_1600"
  | "fuji_superia_reala_100"
  | "fuji_superia_xtra_800"
  | "agfa_vista_100"
  | "agfa_vista_200"
  | "agfa_vista_400"
  | "agfa_ultra_color_100"
  | "kodak_elite_color_200"
  | "kodak_elite_color_400"
  | "fuji_velvia_50"
  | "fuji_fortia_sp_50"
  | "fuji_astia_100f"
  | "fuji_provia_400f"
  | "fuji_provia_400x"
  | "fuji_sensia_100"
  | "kodak_kodachrome_25"
  | "kodak_kodachrome_200"
  | "kodak_ektachrome_100_g"
  | "kodak_ektachrome_100_gx"
  | "kodak_ektachrome_100_vs"
  | "kodak_elite_chrome_200"
  | "kodak_elite_chrome_400"
  | "kodak_elite_extracolor_100"
  | "agfa_precisa_100"
  | "kodak_tri_x_400"
  | "kodak_tmax_100"
  | "kodak_tmax_400"
  | "kodak_tmax_3200"
  | "kodak_bw_400cn"
  | "kodak_hie"
  | "ilford_hp5_plus_400"
  | "ilford_hps_800"
  | "ilford_fp4_plus_125"
  | "ilford_delta_100"
  | "ilford_delta_400"
  | "ilford_delta_3200"
  | "ilford_pan_f_plus_50"
  | "ilford_xp2"
  | "fuji_neopan_acros_100"
  | "fuji_neopan_1600"
  | "agfa_apx_25"
  | "agfa_apx_100"
  | "rollei_retro_80s"
  | "rollei_retro_100_tonal"
  | "rollei_ortho_25"
  | "rollei_ir_400"
  | "polaroid_664"
  | "polaroid_665"
  | "polaroid_667"
  | "polaroid_669"
  | "polaroid_672"
  | "polaroid_690"
  | "polaroid_px_70"
  | "polaroid_px_680"
  | "polaroid_px_100uv_cold"
  | "polaroid_px_100uv_warm"
  | "polaroid_time_zero"
  | "polaroid_polachrome"
  | "fuji_fp_100c"
  | "fuji_fp_100c_cool"
  | "fuji_fp_100c_negative"
  | "fuji_fp_3000b"
  | "kodak_elite_100_xpro"
  | "fuji_superia_200_xpro"
  | "lomography_xpro_slide_200"
  | "lomography_redscale_100";

// Which generation of the backend's pixel maths renders an edit (see
// develop.ENUM_SPEC["process"] and services/develop_v2.py). New edits start on
// the current one; an edit saved before it existed keeps "1" and so keeps
// looking exactly as it did.
// "3" is "2" with the film simulations from cubes (Fujifilm's own where it
// publishes one); "4" renders those as the camera renders a still; "5" lets
// the tone mapper set the tone curve under such a look (AgX), where "3" and
// "4" ignore it; "6" has a Calibration primary move its whole band of colours
// by the same amount, where before a colour off the centre of the band (a
// leaf under Green) got part of it; "7" feeds Fujifilm's film simulation
// cubes the scene colours they were made for, so greens no longer come out
// yellowish and flat against the camera's own rendering.
export type ProcessVersion = "1" | "2" | "3" | "4" | "5" | "6" | "7";
export const CURRENT_PROCESS: ProcessVersion = "7";
// The last process on which Calibration renders the old way.
const LAST_BELL_CALIBRATION: ProcessVersion = "5";
// The last process on which the looks render from the unmixed scene; the one
// an edit on "5" moves to when a Calibration slider is first touched.
const LAST_UNMIXED_LOOK: ProcessVersion = "6";

// Which exposure a RAW is developed from (see develop.ENUM_SPEC["raw_base"]).
// "standard" opens every raw at the same brightness - the auto-exposed picture
// the grid shows - and is where new edits start; "native" is the un-lifted
// sensor exposure, switched per photo under Tone. An edit saved before the key
// existed keeps "legacy", which renders native as it always did.
export type RawBase = "legacy" | "standard" | "native";

// The full develop object. Scalars + the enums + nested groups.
export type Adjustments = { [K in ScalarKey]: number } & {
  process: ProcessVersion;
  raw_base: RawBase;
  tone_mapper: "basic" | "agx";
  curve_mode: "point" | "parametric";
  film_sim: FilmSim;
  hsl: HslMix;
  hsl_range: HslRange;
  point_curves: PointCurves;
  parametric_curve: ParametricCurve;
  color_grading: ColorGrading;
  color_calibration: ColorCalibration;
  masks: MaskDef[];
  spots: SpotDef[];
};

export function neutralHsl(): HslMix {
  return Object.fromEntries(COLOR_BANDS.map((b) => [b, [0, 0, 0]])) as HslMix;
}
export function neutralHslRange(): HslRange {
  return Object.fromEntries(COLOR_BANDS.map((b) => [b, 0])) as HslRange;
}
export function identityPointCurves(): PointCurves {
  const id = (): Curve => [
    [0, 0],
    [255, 255],
  ];
  return { luma: id(), red: id(), green: id(), blue: id() };
}
function neutralParamChannel(): ParamCurveChannel {
  return { highlights: 0, lights: 0, darks: 0, shadows: 0, white_level: 0, black_level: 0, split1: 25, split2: 50, split3: 75 };
}
function neutralParametricCurve(): ParametricCurve {
  return {
    luma: neutralParamChannel(),
    red: neutralParamChannel(),
    green: neutralParamChannel(),
    blue: neutralParamChannel(),
  };
}
function neutralWheel(): GradeWheel {
  return { hue: 0, saturation: 0, luminance: 0 };
}
export function neutralColorGrading(): ColorGrading {
  return { shadows: neutralWheel(), midtones: neutralWheel(), highlights: neutralWheel(), global: neutralWheel(), blending: 50, balance: 0 };
}
function neutralCalibration(): ColorCalibration {
  return {
    shadows_tint: 0,
    red_hue: 0, red_saturation: 0, red_luminance: 0,
    green_hue: 0, green_saturation: 0, green_luminance: 0,
    blue_hue: 0, blue_saturation: 0, blue_luminance: 0,
  };
}

export function defaultAdjustments(): Adjustments {
  const scalars = Object.fromEntries(
    (Object.keys(SCALAR_SPEC) as ScalarKey[]).map((k) => [k, SCALAR_SPEC[k].def])
  ) as { [K in ScalarKey]: number };
  return {
    ...scalars,
    process: CURRENT_PROCESS,
    raw_base: "standard",
    tone_mapper: "basic",
    curve_mode: "point",
    film_sim: "none",
    hsl: neutralHsl(),
    hsl_range: neutralHslRange(),
    point_curves: identityPointCurves(),
    parametric_curve: neutralParametricCurve(),
    color_grading: neutralColorGrading(),
    color_calibration: neutralCalibration(),
    masks: [],
    spots: [],
  };
}

export const DEFAULT_ADJUSTMENTS: Adjustments = defaultAdjustments();

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Whether a stored edit WITHOUT a process key uses any control the current
// process renders differently. If it does it stays on "1" (it must keep its
// look); if it doesn't, both processes give the same picture and the edit
// simply continues on the current one.
function usesLegacyLook(raw: Partial<Adjustments>): boolean {
  const nonZero = (v: unknown) => typeof v === "number" && v !== 0;
  if (["highlights", "shadows", "saturation", "vibrance", "hue"].some((k) => nonZero(raw[k as ScalarKey]))) return true;
  if (typeof raw.sharpness === "number" && raw.sharpness > 0) return true;
  if (raw.hsl && COLOR_BANDS.some((b) => Array.isArray(raw.hsl![b]) && raw.hsl![b].some((v) => v !== 0))) return true;
  const g = raw.color_grading;
  if (g && [g.shadows, g.midtones, g.highlights, g.global].some((w) => w && (nonZero(w.saturation) || nonZero(w.luminance)))) return true;
  // Calibration is the same picture on "1" to "5" and a different one on "6".
  if (raw.color_calibration && Object.values(raw.color_calibration).some(nonZero)) return true;
  return Array.isArray(raw.masks) && raw.masks.length > 0;
}

// Merge a partial/parsed object over the defaults, clamping scalars to range.
// Nested groups are taken as-is when present (already server-normalized) or
// defaulted. Mirrors develop.normalize() on the backend.
export function normalizeAdjustments(raw: Partial<Adjustments> | null | undefined): Adjustments {
  const base = defaultAdjustments();
  if (!raw) return base;
  for (const k of Object.keys(SCALAR_SPEC) as ScalarKey[]) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      const spec: ScalarDef = SCALAR_SPEC[k];
      base[k] =
        spec.step || spec.fractional ? clamp(v, spec.min, spec.max) : Math.round(clamp(v, spec.min, spec.max));
    }
  }
  // Legacy "denoise" master (removed): it fed luma 1:1 and chroma 1.3x, and the
  // render took the stronger of master and per-channel slider. Folded in the same
  // way develop.normalize() does it, so an edit saved with it looks unchanged.
  const legacyDenoise = (raw as { denoise?: unknown }).denoise;
  if (typeof legacyDenoise === "number" && Number.isFinite(legacyDenoise) && legacyDenoise > 0) {
    const dn = Math.round(clamp(legacyDenoise, 0, 100));
    base.luma_noise_reduction = Math.max(base.luma_noise_reduction, dn);
    base.color_noise_reduction = Math.max(base.color_noise_reduction, Math.min(100, Math.round(dn * 1.3)));
  }
  // Without a key: "1" if it uses what "2" renders differently, "2" if it
  // carries a film simulation (which "3" and up render differently), else it
  // is the same picture on every version and continues on the current one.
  base.process =
    raw.process === "1" ||
    raw.process === "2" ||
    raw.process === "3" ||
    raw.process === "4" ||
    raw.process === "5" ||
    raw.process === "6" ||
    raw.process === "7"
      ? raw.process
      : usesLegacyLook(raw)
        ? "1"
        : raw.film_sim && raw.film_sim !== "none"
          ? "2"
          : CURRENT_PROCESS;
  // A stored edit without the key was developed on the native base and stays
  // there: moving it to "standard" would brighten it by the auto-exposure gain.
  base.raw_base = raw.raw_base === "standard" || raw.raw_base === "native" ? raw.raw_base : "legacy";
  if (raw.tone_mapper === "basic" || raw.tone_mapper === "agx") base.tone_mapper = raw.tone_mapper;
  if (raw.curve_mode === "point" || raw.curve_mode === "parametric") base.curve_mode = raw.curve_mode;
  if (raw.film_sim && FILM_SIMS.some((f) => f.value === raw.film_sim)) base.film_sim = raw.film_sim;
  if (raw.hsl) {
    for (const b of COLOR_BANDS) {
      const v = raw.hsl[b];
      if (Array.isArray(v)) base.hsl[b] = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
    }
  }
  if (raw.hsl_range) {
    for (const b of COLOR_BANDS) {
      const v = raw.hsl_range[b];
      if (typeof v === "number" && Number.isFinite(v)) base.hsl_range[b] = Math.round(clamp(v, -100, 100));
    }
  }
  if (raw.point_curves) base.point_curves = raw.point_curves as PointCurves;
  if (raw.parametric_curve) base.parametric_curve = raw.parametric_curve as ParametricCurve;
  if (raw.color_grading) base.color_grading = raw.color_grading as ColorGrading;
  // Over the neutral values: an edit saved before a key existed (the primaries'
  // luminance) must read 0 there, not undefined.
  if (raw.color_calibration)
    base.color_calibration = { ...neutralCalibration(), ...(raw.color_calibration as Partial<ColorCalibration>) };
  if (Array.isArray(raw.masks)) base.masks = raw.masks as MaskDef[];
  if (Array.isArray(raw.spots)) base.spots = raw.spots as SpotDef[];
  return base;
}

export function adjustmentsAreNeutral(a: Adjustments): boolean {
  if (a === DEFAULT_ADJUSTMENTS) return true;
  // The scalars first, without serialising anything: during a slider drag one
  // of them is off its default, and that answers the question in a few dozen
  // comparisons instead of two stringifies of the whole tree per frame.
  for (const k of Object.keys(SCALAR_SPEC) as ScalarKey[]) {
    if (a[k] !== DEFAULT_ADJUSTMENTS[k]) return false;
  }
  // The process version says how sliders render, not that any was moved. Nor
  // does the raw base, unless the photo was switched to its native exposure.
  if (a.raw_base === "native") return false;
  return (
    JSON.stringify({ ...a, process: CURRENT_PROCESS, raw_base: DEFAULT_ADJUSTMENTS.raw_base }) ===
    JSON.stringify(DEFAULT_ADJUSTMENTS)
  );
}

export function adjustmentsFromImage(image: ImageOut): Adjustments {
  if (!image.edit_adjustments) return defaultAdjustments();
  try {
    return normalizeAdjustments(JSON.parse(image.edit_adjustments) as Partial<Adjustments>);
  } catch {
    return defaultAdjustments();
  }
}

// ---- UI section metadata: drives the slider panel (exact RapidRAW ranges/labels).
export interface FieldDef {
  key: ScalarKey;
  label: string;
  format?: (v: number) => string;
  // First slider of a sub-group within its section: the panel sets it off from
  // the sliders above (a hairline), so a long column reads as a few blocks.
  groupStart?: boolean;
}
export interface Section {
  title: string;
  fields: FieldDef[];
}

const evFmt = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)} EV`;
const degFmt = (v: number) => `${v > 0 ? "+" : ""}${v}°`;

// Order and grouping mirror RapidRAW's ADJUSTMENT_SECTIONS (Basic, Color,
// Details, Effects). Curves + colour-grading wheels get their own components
// (added in a later phase); the Fuji extras (Color Chrome / Chrome Blue / Mist)
// are kept in Color/Effects.
export const SECTIONS: Section[] = [
  {
    title: "Basic",
    fields: [
      // Exposure is a linear stop multiply (whole-image lift, in EV); Brightness
      // is a midtone gamma lift that pins black/white, so the two are genuinely
      // different tools rather than the duplicated stop sliders RapidRAW shipped.
      { key: "exposure", label: "Exposure", format: evFmt },
      { key: "brightness", label: "Brightness" },
      { key: "contrast", label: "Contrast" },
      { key: "highlights", label: "Highlights", groupStart: true },
      { key: "shadows", label: "Shadows" },
      { key: "whites", label: "Whites", groupStart: true },
      { key: "blacks", label: "Blacks" },
    ],
  },
  {
    title: "Color",
    fields: [
      { key: "temperature", label: "Temperature" },
      { key: "tint", label: "Tint" },
      // Drawn as the shift cross, not as sliders (see PhotoEditor's Color
      // group) - listed here so they count as part of the group's edits.
      { key: "wb_shift_r", label: "WB shift red" },
      { key: "wb_shift_b", label: "WB shift blue" },
      { key: "vibrance", label: "Vibrance" },
      { key: "saturation", label: "Saturation" },
      { key: "hue", label: "Hue", format: degFmt },
      { key: "chrome_effect", label: "Color Chrome" },
      { key: "chrome_blue", label: "Chrome Blue" },
    ],
  },
  {
    title: "Details",
    fields: [
      { key: "sharpness", label: "Sharpness" },
      { key: "sharpness_threshold", label: "Sharpness Threshold" },
      { key: "clarity", label: "Clarity", groupStart: true },
      { key: "dehaze", label: "Dehaze" },
      { key: "luma_noise_reduction", label: "Luminance NR", groupStart: true },
      { key: "luma_noise_detail", label: "Luminance NR Detail" },
      { key: "color_noise_reduction", label: "Color NR" },
      { key: "chromatic_aberration_red_cyan", label: "Red–Cyan CA", groupStart: true },
      { key: "chromatic_aberration_blue_yellow", label: "Blue–Yellow CA" },
    ],
  },
  {
    title: "Effects",
    fields: [
      { key: "glow_amount", label: "Glow" },
      { key: "halation_amount", label: "Halation" },
      { key: "flare_amount", label: "Light Flares" },
      { key: "grain_amount", label: "Grain Amount", groupStart: true },
      { key: "grain_size", label: "Grain Size" },
      { key: "grain_roughness", label: "Grain Roughness" },
      { key: "vignette_amount", label: "Vignette Amount", groupStart: true },
      { key: "vignette_midpoint", label: "Vignette Midpoint" },
      { key: "vignette_roundness", label: "Vignette Roundness" },
      { key: "vignette_feather", label: "Vignette Feather" },
      { key: "mist", label: "Mist", groupStart: true },
    ],
  },
];

export const TONE_MAPPERS: { value: "basic" | "agx"; label: string }[] = [
  { value: "basic", label: "Basic" },
  { value: "agx", label: "AgX" },
];

// The picker's sections, in display order: the camera's simulations, then the
// film looks by kind of stock - negatives printed on paper, cine negatives on
// print film, slides, black & white, instant film, cross-processed film.
export type FilmSimGroup = "fujifilm" | "negative" | "cinema" | "slide" | "bw" | "instant" | "xpro";
export const FILM_SIM_GROUPS: { value: FilmSimGroup; label: string }[] = [
  { value: "fujifilm", label: "Fujifilm camera" },
  { value: "negative", label: "Negative film" },
  { value: "cinema", label: "Cinema film" },
  { value: "slide", label: "Slide film" },
  { value: "bw", label: "Black & white film" },
  { value: "instant", label: "Instant film" },
  { value: "xpro", label: "Cross-processed" },
];

// Film simulation picker entries, in panel display order. `swatch` is the two
// halves of the small disc on the picker tile, hinting at each look's palette.
// For a film look they are what its cube makes of a sky blue and of a warm
// tone (the two of Provia's swatch), with the shift from the unaltered colour
// doubled in Oklab so that it reads at that size; a dark and a light grey as
// the cube renders them for a black & white one. "None" belongs to no section
// and leads the list; a section shows its looks in the order they stand here:
// by maker (Kodak, Fujifilm, Agfa, Ilford, Rollei), a maker's by family and
// speed, with a family's plain line (Superia 100 to 1600) kept together and
// its variants (X-tra, HG, Natura, Reala) after it, so that the speeds read in
// a row across the picker's two columns - whichever of the backend's two
// lists a look comes from.
export const FILM_SIMS: { value: FilmSim; label: string; swatch: string; group?: FilmSimGroup }[] = [
  { value: "none", label: "None", swatch: "linear-gradient(135deg, #888 50%, #bbb 50%)" },
  { value: "provia", label: "Provia · Standard", group: "fujifilm", swatch: "linear-gradient(135deg, #4a7bc8 50%, #d8a05a 50%)" },
  { value: "velvia", label: "Velvia · Vivid", group: "fujifilm", swatch: "linear-gradient(135deg, #c8332e 50%, #2e7d32 50%)" },
  { value: "astia", label: "Astia · Soft", group: "fujifilm", swatch: "linear-gradient(135deg, #6f9bd1 50%, #e8b98a 50%)" },
  { value: "classic_chrome", label: "Classic Chrome", group: "fujifilm", swatch: "linear-gradient(135deg, #6b7d8a 50%, #b09a7a 50%)" },
  { value: "reala_ace", label: "Reala Ace", group: "fujifilm", swatch: "linear-gradient(135deg, #5b86b8 50%, #d9a86a 50%)" },
  { value: "pro_neg_hi", label: "Pro Neg. Hi", group: "fujifilm", swatch: "linear-gradient(135deg, #6f8496 50%, #d6b08c 50%)" },
  { value: "pro_neg_std", label: "Pro Neg. Std", group: "fujifilm", swatch: "linear-gradient(135deg, #8492a0 50%, #dcc0a4 50%)" },
  { value: "classic_neg", label: "Classic Neg.", group: "fujifilm", swatch: "linear-gradient(135deg, #4e8f86 50%, #d2954f 50%)" },
  { value: "nostalgic_neg", label: "Nostalgic Neg.", group: "fujifilm", swatch: "linear-gradient(135deg, #8a6f52 50%, #e0b878 50%)" },
  { value: "eterna", label: "Eterna · Cinema", group: "fujifilm", swatch: "linear-gradient(135deg, #5a6a72 50%, #a5a08e 50%)" },
  { value: "eterna_bleach_bypass", label: "Eterna Bleach Bypass", group: "fujifilm", swatch: "linear-gradient(135deg, #3f474b 50%, #b4b0a6 50%)" },
  { value: "acros", label: "Acros", group: "fujifilm", swatch: "linear-gradient(135deg, #2b2b2b 50%, #d6d6d6 50%)" },
  { value: "acros_ye", label: "Acros +Ye", group: "fujifilm", swatch: "linear-gradient(135deg, #3a3628 50%, #d9d3b8 50%)" },
  { value: "acros_r", label: "Acros +R", group: "fujifilm", swatch: "linear-gradient(135deg, #402c2c 50%, #dcc9c9 50%)" },
  { value: "acros_g", label: "Acros +G", group: "fujifilm", swatch: "linear-gradient(135deg, #2c3a2e 50%, #c9dccd 50%)" },
  { value: "monochrome", label: "Monochrome", group: "fujifilm", swatch: "linear-gradient(135deg, #1f1f1f 50%, #cfcfcf 50%)" },
  { value: "monochrome_ye", label: "Monochrome +Ye", group: "fujifilm", swatch: "linear-gradient(135deg, #2e2b20 50%, #d4cfb6 50%)" },
  { value: "monochrome_r", label: "Monochrome +R", group: "fujifilm", swatch: "linear-gradient(135deg, #352626 50%, #d6c6c6 50%)" },
  { value: "monochrome_g", label: "Monochrome +G", group: "fujifilm", swatch: "linear-gradient(135deg, #253027 50%, #c6d6ca 50%)" },
  { value: "sepia", label: "Sepia", group: "fujifilm", swatch: "linear-gradient(135deg, #3b2a1a 50%, #d9bd94 50%)" },
  { value: "kodak_gold_200", label: "Gold 200", group: "negative", swatch: "linear-gradient(135deg, #349fc3 50%, #c87a0f 50%)" },
  { value: "kodak_colorplus_200", label: "ColorPlus 200", group: "negative", swatch: "linear-gradient(135deg, #6abafd 50%, #e8a401 50%)" },
  { value: "kodak_ultramax_400", label: "UltraMax 400", group: "negative", swatch: "linear-gradient(135deg, #1d8ebb 50%, #cd850e 50%)" },
  { value: "kodak_ektar_100", label: "Ektar 100", group: "negative", swatch: "linear-gradient(135deg, #079db6 50%, #c4740d 50%)" },
  { value: "kodak_portra_160", label: "Portra 160", group: "negative", swatch: "linear-gradient(135deg, #16a8c6 50%, #c7770f 50%)" },
  { value: "kodak_portra_160_nc", label: "Portra 160 NC", group: "negative", swatch: "linear-gradient(135deg, #119dc4 50%, #d7823f 50%)" },
  { value: "kodak_portra_160_vc", label: "Portra 160 VC", group: "negative", swatch: "linear-gradient(135deg, #10a2b9 50%, #e57b2b 50%)" },
  { value: "kodak_portra_400", label: "Portra 400", group: "negative", swatch: "linear-gradient(135deg, #149dc2 50%, #cc7a0b 50%)" },
  { value: "kodak_portra_400_nc", label: "Portra 400 NC", group: "negative", swatch: "linear-gradient(135deg, #76accb 50%, #bc9212 50%)" },
  { value: "kodak_portra_400_uc", label: "Portra 400 UC", group: "negative", swatch: "linear-gradient(135deg, #0e8ebe 50%, #ca9513 50%)" },
  { value: "kodak_portra_400_vc", label: "Portra 400 VC", group: "negative", swatch: "linear-gradient(135deg, #61a9ce 50%, #b9870f 50%)" },
  { value: "kodak_portra_800", label: "Portra 800", group: "negative", swatch: "linear-gradient(135deg, #1992ba 50%, #cb8212 50%)" },
  { value: "kodak_portra_800_push1", label: "Portra 800 · Push +1", group: "negative", swatch: "linear-gradient(135deg, #0391b6 50%, #c9770d 50%)" },
  { value: "kodak_portra_800_push2", label: "Portra 800 · Push +2", group: "negative", swatch: "linear-gradient(135deg, #0590ad 50%, #d17303 50%)" },
  { value: "kodak_vericolor_iii", label: "Vericolor III", group: "negative", swatch: "linear-gradient(135deg, #477edd 50%, #b98d01 50%)" },
  { value: "kodak_aerocolor_iv", label: "Aerocolor IV", group: "negative", swatch: "linear-gradient(135deg, #22b2e2 50%, #c97c15 50%)" },
  { value: "kodak_elite_color_200", label: "Elite Color 200", group: "negative", swatch: "linear-gradient(135deg, #45b0e3 50%, #c46d0d 50%)" },
  { value: "kodak_elite_color_400", label: "Elite Color 400", group: "negative", swatch: "linear-gradient(135deg, #17c6c0 50%, #d25322 50%)" },
  { value: "fujifilm_c200", label: "Fujicolor C200", group: "negative", swatch: "linear-gradient(135deg, #0c79a9 50%, #dc9405 50%)" },
  { value: "fuji_superia_100", label: "Superia 100", group: "negative", swatch: "linear-gradient(135deg, #53a1fa 50%, #c19e2f 50%)" },
  { value: "fuji_superia_200", label: "Superia 200", group: "negative", swatch: "linear-gradient(135deg, #74b9e9 50%, #d38002 50%)" },
  { value: "fuji_superia_400", label: "Superia 400", group: "negative", swatch: "linear-gradient(135deg, #2393e3 50%, #d0a116 50%)" },
  { value: "fuji_superia_800", label: "Superia 800", group: "negative", swatch: "linear-gradient(135deg, #417bce 50%, #d0a215 50%)" },
  { value: "fuji_superia_1600", label: "Superia 1600", group: "negative", swatch: "linear-gradient(135deg, #077ccd 50%, #cfa50b 50%)" },
  { value: "fujifilm_xtra_400", label: "Superia X-tra 400", group: "negative", swatch: "linear-gradient(135deg, #086fa6 50%, #e19b11 50%)" },
  { value: "fuji_superia_xtra_800", label: "Superia X-tra 800", group: "negative", swatch: "linear-gradient(135deg, #4ba2b6 50%, #c77a60 50%)" },
  { value: "fuji_superia_hg_1600", label: "Superia HG 1600", group: "negative", swatch: "linear-gradient(135deg, #0c989b 50%, #c88c72 50%)" },
  { value: "fuji_natura_1600", label: "Natura 1600", group: "negative", swatch: "linear-gradient(135deg, #0581e6 50%, #c69903 50%)" },
  { value: "fuji_superia_reala_100", label: "Superia Reala 100", group: "negative", swatch: "linear-gradient(135deg, #69a3c3 50%, #d9884e 50%)" },
  { value: "fujifilm_pro_400h", label: "Fuji Pro 400H", group: "negative", swatch: "linear-gradient(135deg, #047fa8 50%, #cd9012 50%)" },
  { value: "fuji_160c", label: "Fuji 160C", group: "negative", swatch: "linear-gradient(135deg, #8092d1 50%, #b08910 50%)" },
  { value: "fuji_pro_160s", label: "Fuji Pro 160S", group: "negative", swatch: "linear-gradient(135deg, #1976c6 50%, #c89710 50%)" },
  { value: "fuji_800z", label: "Fuji 800Z", group: "negative", swatch: "linear-gradient(135deg, #718bc6 50%, #b89008 50%)" },
  { value: "agfa_vista_100", label: "Agfa Vista 100", group: "negative", swatch: "linear-gradient(135deg, #3aa7fd 50%, #db9005 50%)" },
  { value: "agfa_vista_200", label: "Agfa Vista 200", group: "negative", swatch: "linear-gradient(135deg, #0285c9 50%, #ec9a03 50%)" },
  { value: "agfa_vista_400", label: "Agfa Vista 400", group: "negative", swatch: "linear-gradient(135deg, #1faffa 50%, #d69c11 50%)" },
  { value: "agfa_ultra_color_100", label: "Agfa Ultra Color 100", group: "negative", swatch: "linear-gradient(135deg, #0e98d3 50%, #f16f0a 50%)" },
  { value: "cinestill_800t", label: "CineStill 800T", group: "negative", swatch: "linear-gradient(135deg, #5990c9 50%, #b28b05 50%)" },
  { value: "kodak_5247_ii", label: "Eastman 100T 5247 II", group: "cinema", swatch: "linear-gradient(135deg, #578ba2 50%, #9e8d2a 50%)" },
  { value: "kodak_exr_200t_5293", label: "EXR 200T 5293", group: "cinema", swatch: "linear-gradient(135deg, #5c8eb6 50%, #9b8908 50%)" },
  { value: "kodak_exr_100t_5248", label: "EXR 100T 5248", group: "cinema", swatch: "linear-gradient(135deg, #5c94c7 50%, #a68236 50%)" },
  { value: "kodak_vision_320t_5277", label: "Vision 320T 5277", group: "cinema", swatch: "linear-gradient(135deg, #558ab4 50%, #a68b48 50%)" },
  { value: "kodak_vision3_50d", label: "Vision3 50D", group: "cinema", swatch: "linear-gradient(135deg, #247d9b 50%, #c3901d 50%)" },
  { value: "kodak_vision3_250d", label: "Vision3 250D", group: "cinema", swatch: "linear-gradient(135deg, #198091 50%, #c18a14 50%)" },
  { value: "kodak_verita_200d", label: "Verita 200D", group: "cinema", swatch: "linear-gradient(135deg, #27859a 50%, #bd891b 50%)" },
  { value: "kodak_vision3_200t", label: "Vision3 200T", group: "cinema", swatch: "linear-gradient(135deg, #4681a2 50%, #b68a02 50%)" },
  { value: "kodak_vision3_500t", label: "Vision3 500T", group: "cinema", swatch: "linear-gradient(135deg, #4889a1 50%, #b1820e 50%)" },
  { value: "fuji_eterna_500", label: "Eterna 500", group: "cinema", swatch: "linear-gradient(135deg, #2e87d1 50%, #a98a2b 50%)" },
  { value: "fuji_eterna_500_vivid", label: "Eterna 500 Vivid", group: "cinema", swatch: "linear-gradient(135deg, #3189d5 50%, #a98509 50%)" },
  { value: "kodak_kodachrome_25", label: "Kodachrome 25", group: "slide", swatch: "linear-gradient(135deg, #0991a9 50%, #d0b446 50%)" },
  { value: "kodak_kodachrome_64", label: "Kodachrome 64", group: "slide", swatch: "linear-gradient(135deg, #4d8d8f 50%, #c29652 50%)" },
  { value: "kodak_kodachrome_200", label: "Kodachrome 200", group: "slide", swatch: "linear-gradient(135deg, #0e9297 50%, #c58f7c 50%)" },
  { value: "kodak_ektachrome_100", label: "Ektachrome 100", group: "slide", swatch: "linear-gradient(135deg, #3b7a98 50%, #c4a44b 50%)" },
  { value: "kodak_ektachrome_100_g", label: "Ektachrome 100 G", group: "slide", swatch: "linear-gradient(135deg, #66aff2 50%, #de9f27 50%)" },
  { value: "kodak_ektachrome_100_gx", label: "Ektachrome 100 GX", group: "slide", swatch: "linear-gradient(135deg, #03b3d8 50%, #c06e56 50%)" },
  { value: "kodak_ektachrome_100_vs", label: "Ektachrome 100 VS", group: "slide", swatch: "linear-gradient(135deg, #108fbb 50%, #f48850 50%)" },
  { value: "kodak_elite_chrome_200", label: "Elite Chrome 200", group: "slide", swatch: "linear-gradient(135deg, #0e91ca 50%, #dd8237 50%)" },
  { value: "kodak_elite_chrome_400", label: "Elite Chrome 400", group: "slide", swatch: "linear-gradient(135deg, #009ebf 50%, #ca8d0f 50%)" },
  { value: "kodak_elite_extracolor_100", label: "Elite ExtraColor 100", group: "slide", swatch: "linear-gradient(135deg, #16b5d4 50%, #d3830a 50%)" },
  { value: "fuji_velvia_50", label: "Velvia 50", group: "slide", swatch: "linear-gradient(135deg, #03a1ba 50%, #c17f36 50%)" },
  { value: "fujifilm_velvia_100", label: "Velvia 100", group: "slide", swatch: "linear-gradient(135deg, #2c78be 50%, #ddab19 50%)" },
  { value: "fujifilm_provia_100f", label: "Provia 100F", group: "slide", swatch: "linear-gradient(135deg, #3d728b 50%, #cdac5b 50%)" },
  { value: "fuji_provia_400f", label: "Provia 400F", group: "slide", swatch: "linear-gradient(135deg, #46acc2 50%, #c18366 50%)" },
  { value: "fuji_provia_400x", label: "Provia 400X", group: "slide", swatch: "linear-gradient(135deg, #33699d 50%, #fea028 50%)" },
  { value: "fuji_astia_100f", label: "Astia 100F", group: "slide", swatch: "linear-gradient(135deg, #3d93a1 50%, #f58e64 50%)" },
  { value: "fuji_sensia_100", label: "Sensia 100", group: "slide", swatch: "linear-gradient(135deg, #7376cc 50%, #e69e44 50%)" },
  { value: "fuji_fortia_sp_50", label: "Fortia SP 50", group: "slide", swatch: "linear-gradient(135deg, #5fbcfd 50%, #fe9b29 50%)" },
  { value: "agfa_precisa_100", label: "Agfa Precisa 100", group: "slide", swatch: "linear-gradient(135deg, #0e8fa9 50%, #dab007 50%)" },
  { value: "kodak_tri_x_400", label: "Tri-X 400", group: "bw", swatch: "linear-gradient(135deg, #292929 50%, #d0d0d0 50%)" },
  { value: "kodak_tmax_100", label: "T-Max 100", group: "bw", swatch: "linear-gradient(135deg, #282828 50%, #d2d2d2 50%)" },
  { value: "kodak_tmax_400", label: "T-Max 400", group: "bw", swatch: "linear-gradient(135deg, #282828 50%, #d2d2d2 50%)" },
  { value: "kodak_tmax_3200", label: "T-Max 3200", group: "bw", swatch: "linear-gradient(135deg, #262626 50%, #d2d2d2 50%)" },
  { value: "kodak_doublex", label: "Double-X", group: "bw", swatch: "linear-gradient(135deg, #2c2c2c 50%, #d6d6d6 50%)" },
  { value: "kodak_bw_400cn", label: "Kodak BW 400CN", group: "bw", swatch: "linear-gradient(135deg, #2a2a2a 50%, #d0d0d0 50%)" },
  { value: "kodak_hie", label: "Kodak HIE Infrared", group: "bw", swatch: "linear-gradient(135deg, #2e2e2e 50%, #e4e4e4 50%)" },
  { value: "ilford_pan_f_plus_50", label: "Pan F Plus 50", group: "bw", swatch: "linear-gradient(135deg, #292929 50%, #d4d4d4 50%)" },
  { value: "ilford_fp4_plus_125", label: "FP4 Plus 125", group: "bw", swatch: "linear-gradient(135deg, #2e2e2e 50%, #d3d3d3 50%)" },
  { value: "ilford_hp5_plus_400", label: "HP5 Plus 400", group: "bw", swatch: "linear-gradient(135deg, #262626 50%, #d8d8d8 50%)" },
  { value: "ilford_hps_800", label: "HPS 800", group: "bw", swatch: "linear-gradient(135deg, #262626 50%, #d9d9d9 50%)" },
  { value: "ilford_delta_100", label: "Delta 100", group: "bw", swatch: "linear-gradient(135deg, #2a2a2a 50%, #d5d5d5 50%)" },
  { value: "ilford_delta_400", label: "Delta 400", group: "bw", swatch: "linear-gradient(135deg, #282828 50%, #cccccc 50%)" },
  { value: "ilford_delta_3200", label: "Delta 3200", group: "bw", swatch: "linear-gradient(135deg, #292929 50%, #cccccc 50%)" },
  { value: "ilford_xp2", label: "Ilford XP2", group: "bw", swatch: "linear-gradient(135deg, #292929 50%, #d4d4d4 50%)" },
  { value: "fuji_neopan_acros_100", label: "Neopan Acros 100", group: "bw", swatch: "linear-gradient(135deg, #272727 50%, #c8c8c8 50%)" },
  { value: "fuji_neopan_1600", label: "Neopan 1600", group: "bw", swatch: "linear-gradient(135deg, #262626 50%, #d7d7d7 50%)" },
  { value: "agfa_apx_25", label: "Agfa APX 25", group: "bw", swatch: "linear-gradient(135deg, #292929 50%, #dadada 50%)" },
  { value: "agfa_apx_100", label: "Agfa APX 100", group: "bw", swatch: "linear-gradient(135deg, #313131 50%, #e0e0e0 50%)" },
  { value: "rollei_ortho_25", label: "Rollei Ortho 25", group: "bw", swatch: "linear-gradient(135deg, #2a2a2a 50%, #e3e3e3 50%)" },
  { value: "rollei_retro_80s", label: "Rollei Retro 80S", group: "bw", swatch: "linear-gradient(135deg, #222222 50%, #dedede 50%)" },
  { value: "rollei_retro_100_tonal", label: "Rollei Retro 100 Tonal", group: "bw", swatch: "linear-gradient(135deg, #2d2d2d 50%, #d3d3d3 50%)" },
  { value: "rollei_ir_400", label: "Rollei IR 400", group: "bw", swatch: "linear-gradient(135deg, #242424 50%, #cfcfcf 50%)" },
  { value: "polaroid_664", label: "Polaroid 664", group: "instant", swatch: "linear-gradient(135deg, #2e2e2e 50%, #d6d6d6 50%)" },
  { value: "polaroid_665", label: "Polaroid 665", group: "instant", swatch: "linear-gradient(135deg, #2c2c2c 50%, #dcdcdc 50%)" },
  { value: "polaroid_667", label: "Polaroid 667", group: "instant", swatch: "linear-gradient(135deg, #2c2c2c 50%, #d6d6d6 50%)" },
  { value: "polaroid_669", label: "Polaroid 669", group: "instant", swatch: "linear-gradient(135deg, #5bb8b4 50%, #b47e75 50%)" },
  { value: "polaroid_672", label: "Polaroid 672", group: "instant", swatch: "linear-gradient(135deg, #262626 50%, #d1d1d1 50%)" },
  { value: "polaroid_690", label: "Polaroid 690", group: "instant", swatch: "linear-gradient(135deg, #06cdda 50%, #be8103 50%)" },
  { value: "polaroid_px_70", label: "Polaroid PX-70", group: "instant", swatch: "linear-gradient(135deg, #dbd300 50%, #c0990d 50%)" },
  { value: "polaroid_px_680", label: "Polaroid PX-680", group: "instant", swatch: "linear-gradient(135deg, #c7b84c 50%, #c1922b 50%)" },
  { value: "polaroid_px_100uv_cold", label: "Polaroid PX-100 UV+ · Cold", group: "instant", swatch: "linear-gradient(135deg, #ffd77a 50%, #2171a7 50%)" },
  { value: "polaroid_px_100uv_warm", label: "Polaroid PX-100 UV+ · Warm", group: "instant", swatch: "linear-gradient(135deg, #ffe1b5 50%, #3b6ba5 50%)" },
  { value: "polaroid_time_zero", label: "Time Zero · Expired", group: "instant", swatch: "linear-gradient(135deg, #fee4d2 50%, #d68b0b 50%)" },
  { value: "polaroid_polachrome", label: "Polachrome", group: "instant", swatch: "linear-gradient(135deg, #d9bdad 50%, #a9996f 50%)" },
  { value: "fuji_fp_100c", label: "Fuji FP-100C", group: "instant", swatch: "linear-gradient(135deg, #3469ba 50%, #bb8611 50%)" },
  { value: "fuji_fp_100c_cool", label: "Fuji FP-100C · Cool", group: "instant", swatch: "linear-gradient(135deg, #1669c2 50%, #b58809 50%)" },
  { value: "fuji_fp_100c_negative", label: "Fuji FP-100C · Negative", group: "instant", swatch: "linear-gradient(135deg, #0243b1 50%, #c19c35 50%)" },
  { value: "fuji_fp_3000b", label: "Fuji FP-3000B", group: "instant", swatch: "linear-gradient(135deg, #2f2f2f 50%, #d8d8d8 50%)" },
  { value: "fuji_instax_color", label: "Fuji Instax Color", group: "instant", swatch: "linear-gradient(135deg, #0e2db3 50%, #f79e05 50%)" },
  { value: "kodak_elite_100_xpro", label: "Elite 100 · X-Pro", group: "xpro", swatch: "linear-gradient(135deg, #1cd2d0 50%, #ce9e17 50%)" },
  { value: "fuji_superia_200_xpro", label: "Superia 200 · X-Pro", group: "xpro", swatch: "linear-gradient(135deg, #0daae2 50%, #0f86ae 50%)" },
  { value: "lomography_xpro_slide_200", label: "Lomo X-Pro Slide 200", group: "xpro", swatch: "linear-gradient(135deg, #2688db 50%, #c7a939 50%)" },
  { value: "lomography_redscale_100", label: "Lomo Redscale 100", group: "xpro", swatch: "linear-gradient(135deg, #90b692 50%, #a2673c 50%)" },
];

// The picker's list as it is shown: "None" on its own, then each section with
// its looks. The order the looks are stepped through (arrow keys, the previous
// / next buttons) is read off the same list, so the two cannot drift apart.
export const FILM_SIM_SECTIONS: { group?: (typeof FILM_SIM_GROUPS)[number]; sims: typeof FILM_SIMS }[] = [
  undefined,
  ...FILM_SIM_GROUPS,
].map((group) => ({ group, sims: FILM_SIMS.filter((f) => f.group === group?.value) }));
export const FILM_SIM_ORDER: FilmSim[] = FILM_SIM_SECTIONS.flatMap((section) => section.sims.map((f) => f.value));

// The process an older edit moves to when it takes a look or a tone mapper in
// its current form: the current one, unless it has Calibration set the old
// way - that renders differently from "6" on, and the move must change
// nothing but the look.
export function processForCurrentLooks(a: Adjustments): ProcessVersion {
  if (calibrationIsNeutral(a) || a.process === LAST_UNMIXED_LOOK || a.process === CURRENT_PROCESS) {
    return CURRENT_PROCESS;
  }
  return LAST_BELL_CALIBRATION;
}

export function calibrationIsNeutral(a: Adjustments): boolean {
  return Object.values(a.color_calibration).every((v) => v === 0);
}

// An edit with one Calibration slider set. The first one moved on an edit
// whose Calibration was untouched takes Calibration in its current form (an
// edit on "5" moves on; with Calibration neutral that changes nothing else).
export function withCalibration(a: Adjustments, key: keyof ColorCalibration, v: number): Adjustments {
  const process = a.process === LAST_BELL_CALIBRATION && calibrationIsNeutral(a) ? LAST_UNMIXED_LOOK : a.process;
  return { ...a, process, color_calibration: { ...a.color_calibration, [key]: v } };
}

// An edit with the look `value` chosen. Choosing a look takes it in its current
// form: an edit on process 2 and up moves to the current one, which differs in
// nothing but how the simulations render (an edit on "1" keeps its recipes).
export function withFilmSim(a: Adjustments, value: FilmSim): Adjustments {
  return { ...a, film_sim: value, process: a.process === "1" ? a.process : processForCurrentLooks(a) };
}

// ---- The full non-destructive edit: geometry + the develop object.
export interface ImageEdits {
  rotation: number; // absolute, multiple of 90
  crop: CropBox | null;
  flipH: boolean;
  flipV: boolean;
  straighten: number; // fine level angle, clockwise degrees (-45..45)
  perspH: number; // keystone / axis tilt about the vertical axis, -100..100
  perspV: number; // keystone / axis tilt about the horizontal axis, -100..100
  distortion: number; // lens distortion correction, geometric, -100..100
  adjustments: Adjustments;
}

export function editsFromImage(image: ImageOut): ImageEdits {
  return {
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
    flipH: image.edit_flip_h,
    flipV: image.edit_flip_v,
    straighten: image.edit_straighten,
    perspH: image.edit_persp_h,
    perspV: image.edit_persp_v,
    distortion: image.edit_distortion,
    adjustments: adjustmentsFromImage(image),
  };
}

// A fully-neutral edit that keeps the given geometry - used by the editor's
// hold-to-compare so the frame doesn't jump while showing the original.
export function neutralEdits(
  rotation: number,
  crop: CropBox | null,
  flipH = false,
  flipV = false,
  straighten = 0,
  perspH = 0,
  perspV = 0,
  distortion = 0
): ImageEdits {
  return {
    rotation,
    crop,
    flipH,
    flipV,
    straighten,
    perspH,
    perspV,
    distortion,
    adjustments: defaultAdjustments(),
  };
}

export function editsAreNeutral(e: ImageEdits): boolean {
  return (
    e.rotation === 0 &&
    !e.crop &&
    !e.flipH &&
    !e.flipV &&
    e.straighten === 0 &&
    e.perspH === 0 &&
    e.perspV === 0 &&
    e.distortion === 0 &&
    adjustmentsAreNeutral(e.adjustments)
  );
}

// ---- Masks (local adjustments) ---------------------------------------------
export const MASK_TYPES: { value: SubMaskType; label: string }[] = [
  { value: "radial", label: "Radial" },
  { value: "linear", label: "Linear" },
  { value: "brush", label: "Brush" },
  { value: "luminance", label: "Luminance" },
  { value: "color", label: "Color" },
  { value: "edge", label: "Edges" },
];

// Subjects the backend can find by name (segmentation.CLASS_GROUPS). Each one
// becomes a `semantic` sub-mask whose region is computed server-side once and
// then stored in the edit - see PhotoEditor.addSemanticMask.
export const MASK_SUBJECTS: { value: string; label: string }[] = [
  { value: "sky", label: "Sky" },
  { value: "water", label: "Water" },
  { value: "greenery", label: "Greenery" },
  { value: "person", label: "People" },
  { value: "building", label: "Buildings" },
  { value: "ground", label: "Ground" },
];

const _MASK_LABEL: Record<SubMaskType, string> = {
  radial: "Radial",
  linear: "Linear",
  brush: "Brush",
  luminance: "Luminance",
  color: "Color",
  edge: "Edges",
  semantic: "Subject",
};
const _DEFAULT_SUBMASK_PARAMS: Record<SubMaskType, SubMaskParams> = {
  radial: { center_x: 0.5, center_y: 0.5, radius_x: 0.25, radius_y: 0.25, rotation: 0, feather: 50 },
  linear: { start_x: 0.5, start_y: 0.2, end_x: 0.5, end_y: 0.8, feather: 50 },
  // flow = how much one stroke lays down, density = the ceiling repeated strokes
  // build toward. Both default to 100, i.e. a single stroke is fully opaque -
  // the behaviour before they existed.
  brush: { strokes: [] as number[][], feather: 50, size: 0.06, flow: 100, density: 100 },
  luminance: { range_min: 0, range_max: 50, feather: 35 },
  color: { target_r: 0.5, target_g: 0.5, target_b: 0.5, tolerance: 20, feather: 35 },
  // Detail rather than tone: threshold is the edge strength that counts as an
  // edge, spread grows the selection off the edge so a sharpening adjustment
  // covers the whole transition instead of a hairline.
  edge: { threshold: 25, spread: 30, feather: 50 },
  // `mask` is filled in by the segmentation call; feather defaults to 0 because
  // the found region already fades where the detection is uncertain, and that
  // edge is usually better than any blur we could add.
  semantic: { subject: "sky", mask: "", geom: "", feather: 0 },
};
function _uid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}`;
}
export function newSubMask(type: SubMaskType): SubMask {
  return { id: _uid(), type, mode: "additive", visible: true, invert: false, parameters: { ..._DEFAULT_SUBMASK_PARAMS[type] } };
}
// A mask's optional second sub-mask: a drawn shape that the mask is INTERSECTED
// with, i.e. "this selection, but only here". It's what makes the selections
// that have no place of their own usable - an edge mask finds every edge in the
// frame, which is the whole picture's worth of detail unless it can be confined
// to the hair, the eyes, the fabric you actually meant. Index 1 by convention;
// index 0 stays the mask's own selection (masks.generate_mask_field takes the
// first sub-mask as the base and folds the rest in by their mode).
export const MASK_LIMIT_TYPES: { value: SubMaskType; label: string }[] = [
  { value: "radial", label: "Radial" },
  { value: "linear", label: "Linear" },
  { value: "brush", label: "Brush" },
];
export const SUBMASK_MODES: { value: SubMaskMode; label: string; hint: string }[] = [
  { value: "additive", label: "Add", hint: "The shape joins the selection" },
  { value: "subtractive", label: "Subtract", hint: "The shape is taken out of the selection" },
  { value: "intersect", label: "Intersect", hint: "The selection is confined to the shape" },
];
export function newShapeSubMask(type: SubMaskType, mode: SubMaskMode): SubMask {
  return { ...newSubMask(type), mode };
}
export function newLimitSubMask(type: SubMaskType): SubMask {
  return { ...newSubMask(type), mode: "intersect" };
}
export function maskLimit(mask: MaskDef): SubMask | null {
  return mask.sub_masks[1] ?? null;
}
export function newMask(type: SubMaskType): MaskDef {
  return { id: _uid(), name: _MASK_LABEL[type], visible: true, opacity: 100, invert: false, sub_masks: [newSubMask(type)], adjustments: {} };
}

// ---- Masks vs. the crop ------------------------------------------------------
// A mask's coordinates are fractions of the *cropped* frame - that's the array
// the backend rasterises them into (thumbnails.apply_masks runs after
// apply_edits_array). So changing the crop moves every mask across the picture:
// crop away the left third and a mask on the subject's face slides left with the
// fractions instead of staying on the face. These helpers re-express the shapes
// in the new frame so they stay on the same pixels.
//
// `base` is the *uncropped* framed image's pixel size, needed only for the brush,
// whose `size` is a fraction of the frame's long edge (masks._brush_field) and so
// depends on which edge is longer before and after.

const FULL_CROP: CropBox = { x: 0, y: 0, width: 1, height: 1 };

function remapSubMaskParams(
  sub: SubMask,
  from: CropBox,
  to: CropBox,
  base: { width: number; height: number }
): SubMask | null {
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  // A point u in the old frame sits at (from.x + u*from.width) in the uncropped
  // frame, which is ((that) - to.x) / to.width in the new one.
  const ox = (from.x - to.x) / to.width;
  const oy = (from.y - to.y) / to.height;
  const mapX = (u: number) => ox + u * sx;
  const mapY = (v: number) => oy + v * sy;
  const p = sub.parameters;
  const num = (k: string, d: number) => (typeof p[k] === "number" ? (p[k] as number) : d);

  if (sub.type === "radial") {
    return {
      ...sub,
      parameters: {
        ...p,
        center_x: mapX(num("center_x", 0.5)),
        center_y: mapY(num("center_y", 0.5)),
        radius_x: Math.max(1e-3, num("radius_x", 0.25) * sx),
        radius_y: Math.max(1e-3, num("radius_y", 0.25) * sy),
      },
    };
  }
  if (sub.type === "linear") {
    return {
      ...sub,
      parameters: {
        ...p,
        start_x: mapX(num("start_x", 0.5)),
        start_y: mapY(num("start_y", 0.2)),
        end_x: mapX(num("end_x", 0.5)),
        end_y: mapY(num("end_y", 0.8)),
      },
    };
  }
  if (sub.type === "brush") {
    const strokes = Array.isArray(p.strokes) ? (p.strokes as number[][]) : [];
    // Long edge of the framed image before and after, in pixels: that's the unit
    // a stroke's `size` is measured in, so a dab keeps its physical size.
    const longFrom = Math.max(base.width * from.width, base.height * from.height);
    const longTo = Math.max(base.width * to.width, base.height * to.height);
    const ss = longTo > 0 ? longFrom / longTo : 1;
    return {
      ...sub,
      parameters: {
        ...p,
        size: num("size", 0.06) * ss,
        strokes: strokes.map((s) => [mapX(s[0] ?? 0), mapY(s[1] ?? 0), (s[2] ?? 0.06) * ss, s[3] ?? 0]),
      },
    };
  }
  // Luminance/colour masks have no geometry, so the crop can't move them. A
  // semantic mask's stored region does live in the old frame - it can't be
  // re-projected without losing the detection's edges, so it keeps its `geom`
  // signature and the panel offers "Recompute" instead.
  return null;
}

// The spots, re-expressed from the frame cropped by `from` into the one cropped
// by `to` (null = the uncropped frame) - centre and source like a radial
// mask's centre, the radius like a brush size (a fraction of the long edge).
// The same array comes back when nothing needed moving.
export function remapSpotsForCrop(
  spots: SpotDef[],
  from: CropBox | null,
  to: CropBox | null,
  base: { width: number; height: number }
): SpotDef[] {
  const f = from ?? FULL_CROP;
  const t = to ?? FULL_CROP;
  if (!spots.length || t.width <= 0 || t.height <= 0) return spots;
  if (f.x === t.x && f.y === t.y && f.width === t.width && f.height === t.height) return spots;
  const sx = f.width / t.width;
  const sy = f.height / t.height;
  const ox = (f.x - t.x) / t.width;
  const oy = (f.y - t.y) / t.height;
  const longFrom = Math.max(base.width * f.width, base.height * f.height);
  const longTo = Math.max(base.width * t.width, base.height * t.height);
  const ss = longTo > 0 ? longFrom / longTo : 1;
  return spots.map((s) => ({
    ...s,
    x: ox + s.x * sx,
    y: oy + s.y * sy,
    src_x: ox + s.src_x * sx,
    src_y: oy + s.src_y * sy,
    radius: Math.max(SPOT_RADIUS_MIN, Math.min(SPOT_RADIUS_MAX, s.radius * ss)),
  }));
}

// Re-express every mask's geometry from the frame cropped by `from` into the one
// cropped by `to` (null = the uncropped frame). `base` is the uncropped framed
// image in pixels. Returns the same array when nothing needed moving, so callers
// can skip a state update.
export function remapMasksForCrop(
  masks: MaskDef[],
  from: CropBox | null,
  to: CropBox | null,
  base: { width: number; height: number }
): MaskDef[] {
  const f = from ?? FULL_CROP;
  const t = to ?? FULL_CROP;
  if (!masks.length || t.width <= 0 || t.height <= 0) return masks;
  if (f.x === t.x && f.y === t.y && f.width === t.width && f.height === t.height) return masks;
  let changed = false;
  const next = masks.map((m) => {
    const subs = m.sub_masks.map((s) => {
      const remapped = remapSubMaskParams(s, f, t, base);
      if (remapped) changed = true;
      return remapped ?? s;
    });
    return { ...m, sub_masks: subs };
  });
  return changed ? next : masks;
}

// The scalar adjustments offered per-mask (a local-adjustment subset), as FieldDefs.
export const MASK_ADJUST_FIELDS: FieldDef[] = (
  [
    "exposure", "contrast", "highlights", "shadows", "whites", "blacks",
    "temperature", "tint", "vibrance", "saturation", "hue",
    "clarity", "dehaze", "sharpness",
  ] as ScalarKey[]
)
  .map((k) => SECTIONS.flatMap((s) => s.fields).find((f) => f.key === k))
  .filter((f): f is FieldDef => !!f);

// ---- "Something in here was changed": which panel groups hold a non-default
// value. The edit panel marks those group headers (and every slider that is off
// its own default) with a small dot, so you can see where a photo has been
// worked on without opening each group in turn.
export function scalarIsEdited(key: ScalarKey, value: number): boolean {
  // Exposure/straighten are fractional - compare with a tolerance rather than
  // by identity, so a value dragged back to zero doesn't stay marked.
  return Math.abs(value - SCALAR_SPEC[key].def) > 1e-6;
}

// The geometry half of the edit state, which lives outside `Adjustments`.
export interface GeometryEditState {
  rotation: number;
  crop: CropBox | null;
  flipH: boolean;
  flipV: boolean;
  straighten: number;
  perspH: number;
  perspV: number;
  distortion: number;
}

// Keyed by the accordion group id in PhotoEditor, plus the three sub-headings
// inside Color. Groups with nothing to mark (Presets) are simply absent.
export function editedGroups(a: Adjustments, g: GeometryEditState): Record<string, boolean> {
  const fieldsEdited = (title: string) =>
    (SECTIONS.find((s) => s.title === title)?.fields ?? []).some((f) => scalarIsEdited(f.key, a[f.key]));
  const same = (v: unknown, def: unknown) => JSON.stringify(v) === JSON.stringify(def);
  const colorMixer = COLOR_BANDS.some((b) => a.hsl[b].some((v) => v !== 0) || a.hsl_range[b] !== 0);
  const colorGrading = !same(a.color_grading, neutralColorGrading());
  const calibration = !same(a.color_calibration, neutralCalibration());
  return {
    transform:
      g.rotation !== 0 ||
      !!g.crop ||
      g.flipH ||
      g.flipV ||
      g.straighten !== 0 ||
      g.perspH !== 0 ||
      g.perspV !== 0 ||
      g.distortion !== 0 ||
      scalarIsEdited("frame_width", a.frame_width) ||
      LENS_KEYS.some((k) => scalarIsEdited(k, a[k])),
    filmsim: a.film_sim !== "none",
    basic: a.tone_mapper !== "basic" || a.raw_base === "native" || fieldsEdited("Basic"),
    curves: !same(a.point_curves, identityPointCurves()) || !same(a.parametric_curve, neutralParametricCurve()),
    color: fieldsEdited("Color") || colorMixer || colorGrading || calibration,
    details: fieldsEdited("Details"),
    effects: fieldsEdited("Effects"),
    masks: a.masks.length > 0,
    retouch: a.spots.length > 0,
    colorMixer,
    colorGrading,
    calibration,
  };
}

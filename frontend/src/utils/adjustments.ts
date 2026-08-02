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
  temperature: { def: 0, min: -250, max: 250 },
  tint: { def: 0, min: -250, max: 250 },
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
  // Master high-ISO noise reduction - drives both NR channels below.
  denoise: { def: 0, min: 0, max: 100 },
  luma_noise_reduction: { def: 0, min: 0, max: 100 },
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
} satisfies Record<string, ScalarDef>;

export type ScalarKey = keyof typeof SCALAR_SPEC;

// ---- Nested adjustment groups (curves / grading / calibration / masks).
// Present in the object for round-trip preservation; Phase-1 UI only edits the
// scalars + HSL, but must not drop these when saving.
export const COLOR_BANDS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"] as const;
export type ColorBand = (typeof COLOR_BANDS)[number];
export type HslMix = Record<ColorBand, [number, number, number]>;
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
  green_hue: number;
  green_saturation: number;
  blue_hue: number;
  blue_saturation: number;
}
export type SubMaskType = "radial" | "linear" | "brush" | "luminance" | "color" | "semantic";
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
  // Sparse local adjustments (only changed scalar keys); backend merges defaults.
  adjustments: Partial<Record<ScalarKey, number>>;
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
  | "classic_neg"
  | "nostalgic_neg"
  | "eterna"
  | "acros"
  | "acros_ye"
  | "acros_r"
  | "monochrome";

// The full develop object. Scalars + three enums + nested groups.
export type Adjustments = { [K in ScalarKey]: number } & {
  tone_mapper: "basic" | "agx";
  curve_mode: "point" | "parametric";
  film_sim: FilmSim;
  hsl: HslMix;
  point_curves: PointCurves;
  parametric_curve: ParametricCurve;
  color_grading: ColorGrading;
  color_calibration: ColorCalibration;
  masks: MaskDef[];
};

function neutralHsl(): HslMix {
  return Object.fromEntries(COLOR_BANDS.map((b) => [b, [0, 0, 0]])) as HslMix;
}
function identityPointCurves(): PointCurves {
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
function neutralColorGrading(): ColorGrading {
  return { shadows: neutralWheel(), midtones: neutralWheel(), highlights: neutralWheel(), global: neutralWheel(), blending: 50, balance: 0 };
}
function neutralCalibration(): ColorCalibration {
  return { shadows_tint: 0, red_hue: 0, red_saturation: 0, green_hue: 0, green_saturation: 0, blue_hue: 0, blue_saturation: 0 };
}

export function defaultAdjustments(): Adjustments {
  const scalars = Object.fromEntries(
    (Object.keys(SCALAR_SPEC) as ScalarKey[]).map((k) => [k, SCALAR_SPEC[k].def])
  ) as { [K in ScalarKey]: number };
  return {
    ...scalars,
    tone_mapper: "basic",
    curve_mode: "point",
    film_sim: "none",
    hsl: neutralHsl(),
    point_curves: identityPointCurves(),
    parametric_curve: neutralParametricCurve(),
    color_grading: neutralColorGrading(),
    color_calibration: neutralCalibration(),
    masks: [],
  };
}

export const DEFAULT_ADJUSTMENTS: Adjustments = defaultAdjustments();

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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
      base[k] = spec.step ? clamp(v, spec.min, spec.max) : Math.round(clamp(v, spec.min, spec.max));
    }
  }
  if (raw.tone_mapper === "basic" || raw.tone_mapper === "agx") base.tone_mapper = raw.tone_mapper;
  if (raw.curve_mode === "point" || raw.curve_mode === "parametric") base.curve_mode = raw.curve_mode;
  if (raw.film_sim && FILM_SIMS.some((f) => f.value === raw.film_sim)) base.film_sim = raw.film_sim;
  if (raw.hsl) {
    for (const b of COLOR_BANDS) {
      const v = raw.hsl[b];
      if (Array.isArray(v)) base.hsl[b] = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
    }
  }
  if (raw.point_curves) base.point_curves = raw.point_curves as PointCurves;
  if (raw.parametric_curve) base.parametric_curve = raw.parametric_curve as ParametricCurve;
  if (raw.color_grading) base.color_grading = raw.color_grading as ColorGrading;
  if (raw.color_calibration) base.color_calibration = raw.color_calibration as ColorCalibration;
  if (Array.isArray(raw.masks)) base.masks = raw.masks as MaskDef[];
  return base;
}

export function adjustmentsAreNeutral(a: Adjustments): boolean {
  return JSON.stringify(a) === JSON.stringify(DEFAULT_ADJUSTMENTS);
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
      { key: "highlights", label: "Highlights" },
      { key: "shadows", label: "Shadows" },
      { key: "whites", label: "Whites" },
      { key: "blacks", label: "Blacks" },
    ],
  },
  {
    title: "Color",
    fields: [
      { key: "temperature", label: "Temperature" },
      { key: "tint", label: "Tint" },
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
      { key: "sharpness_threshold", label: "Threshold" },
      { key: "clarity", label: "Clarity" },
      { key: "dehaze", label: "Dehaze" },
      { key: "denoise", label: "Denoise" },
      { key: "luma_noise_reduction", label: "Luminance NR" },
      { key: "color_noise_reduction", label: "Color NR" },
      { key: "chromatic_aberration_red_cyan", label: "Red–Cyan CA" },
      { key: "chromatic_aberration_blue_yellow", label: "Blue–Yellow CA" },
    ],
  },
  {
    title: "Effects",
    fields: [
      { key: "glow_amount", label: "Glow" },
      { key: "halation_amount", label: "Halation" },
      { key: "flare_amount", label: "Light Flares" },
      { key: "grain_amount", label: "Grain Amount" },
      { key: "grain_size", label: "Grain Size" },
      { key: "grain_roughness", label: "Grain Roughness" },
      { key: "vignette_amount", label: "Vignette Amount" },
      { key: "vignette_midpoint", label: "Vignette Midpoint" },
      { key: "vignette_roundness", label: "Vignette Roundness" },
      { key: "vignette_feather", label: "Vignette Feather" },
      { key: "mist", label: "Mist" },
    ],
  },
];

export const TONE_MAPPERS: { value: "basic" | "agx"; label: string }[] = [
  { value: "basic", label: "Basic" },
  { value: "agx", label: "AgX" },
];

// Film simulation picker entries, in panel display order. `swatch` is a small
// CSS gradient hinting at each look's palette on the picker tile.
export const FILM_SIMS: { value: FilmSim; label: string; swatch: string }[] = [
  { value: "none", label: "None", swatch: "linear-gradient(135deg, #888, #bbb)" },
  { value: "provia", label: "Provia · Standard", swatch: "linear-gradient(135deg, #4a7bc8, #d8a05a)" },
  { value: "velvia", label: "Velvia · Vivid", swatch: "linear-gradient(135deg, #c8332e, #2e7d32)" },
  { value: "astia", label: "Astia · Soft", swatch: "linear-gradient(135deg, #6f9bd1, #e8b98a)" },
  { value: "classic_chrome", label: "Classic Chrome", swatch: "linear-gradient(135deg, #6b7d8a, #b09a7a)" },
  { value: "classic_neg", label: "Classic Neg.", swatch: "linear-gradient(135deg, #4e8f86, #d2954f)" },
  { value: "nostalgic_neg", label: "Nostalgic Neg.", swatch: "linear-gradient(135deg, #8a6f52, #e0b878)" },
  { value: "eterna", label: "Eterna · Cinema", swatch: "linear-gradient(135deg, #5a6a72, #a5a08e)" },
  { value: "acros", label: "Acros", swatch: "linear-gradient(135deg, #2b2b2b, #d6d6d6)" },
  { value: "acros_ye", label: "Acros +Ye", swatch: "linear-gradient(135deg, #3a3628, #d9d3b8)" },
  { value: "acros_r", label: "Acros +R", swatch: "linear-gradient(135deg, #402c2c, #dcc9c9)" },
  { value: "monochrome", label: "Monochrome", swatch: "linear-gradient(135deg, #1f1f1f, #cfcfcf)" },
];

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
export function newMask(type: SubMaskType): MaskDef {
  return { id: _uid(), name: _MASK_LABEL[type], visible: true, opacity: 100, invert: false, sub_masks: [newSubMask(type)], adjustments: {} };
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

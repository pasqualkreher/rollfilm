import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { CropBox, ImageOut } from "../api/types";
import { IconArrowLeft, IconCheck, IconFlipH, IconFlipV, IconRotate, IconSideBySide, IconSplit, IconTarget, IconX } from "./Icons";
import { Dropdown } from "./Dropdown";
import { SaveCopyDialog } from "./SaveCopyDialog";
import {
  adjustmentsFromImage,
  BAND_SWATCH,
  COLOR_BANDS,
  defaultAdjustments,
  editsAreNeutral,
  editsFromImage,
  FILM_SIMS,
  MASK_ADJUST_FIELDS,
  MASK_SUBJECTS,
  MASK_TYPES,
  neutralEdits,
  newMask,
  normalizeAdjustments,
  remapMasksForCrop,
  SCALAR_SPEC,
  SECTIONS,
  TONE_MAPPERS,
  type Adjustments,
  type ColorBand,
  type ColorCalibration,
  type ColorGrading,
  type CurvePoint,
  type FieldDef,
  type GradeWheel,
  type ImageEdits,
  type MaskDef,
  type ParamCurveChannel,
  type ParametricCurve,
  type PointCurves,
  type ScalarDef,
  type ScalarKey,
  type SubMask,
  type SubMaskParams,
  type SubMaskType,
} from "../utils/adjustments";
import {
  PARAM_BASES,
  PARAM_KEYS,
  paramCurveInput,
  parametricToPoints,
  pchipSample,
  pointCurveInput,
  pointsToParametric,
} from "../utils/curveConvert";
import { loadPresets, savePreset, deletePreset, type EditPreset } from "../utils/presets";
import { CurveEditor, MAX_CURVE_POINTS } from "./CurveEditor";
import { ColorWheel } from "./ColorWheel";
import { MaskOverlay } from "./MaskOverlay";
import { useAppDialogs } from "./AppDialogs";
import { useWait } from "../state/wait";

interface Props {
  image: ImageOut;
  onClose: () => void;
}

interface DragRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// The live preview is rendered *server-side* by the exact save pipeline
// (POST /images/:id/editor-preview), debounced per edit change - one
// implementation of every effect, preview always identical to the save.
type GridOverlay = "none" | "thirds" | "grid" | "diagonal";
// Labels are what follows the row's own "Grid" label, so none of them repeats
// it - the select used to read "Grid: Grid", which says nothing about which
// grid it is.
const GRID_OPTIONS: { value: GridOverlay; label: string }[] = [
  { value: "none", label: "None" },
  { value: "thirds", label: "Rule of thirds" },
  { value: "grid", label: "Square grid" },
  { value: "diagonal", label: "Diagonals" },
];
const MIX_CHANNELS: [number, string][] = [
  [0, "Hue"],
  [1, "Saturation"],
  [2, "Luminance"],
];

// Accordion groups in panel render order; keys 1..9 jump straight to them.
const GROUP_ORDER = ["transform", "filmsim", "basic", "curves", "color", "details", "effects", "masks", "presets"];
const SECTION_KEY_ORDER = GROUP_ORDER.map((_, i) => String(i + 1));

// Curves: the four channels share the same key set across point + parametric
// curves. Each carries a display colour for its graph line / dot.
type CurveChannel = keyof PointCurves;
const CURVE_CHANNELS: { key: CurveChannel; label: string; color: string }[] = [
  { key: "luma", label: "Luma", color: "var(--text)" },
  { key: "red", label: "Red", color: "#e5484d" },
  { key: "green", label: "Green", color: "#46a758" },
  { key: "blue", label: "Blue", color: "#3a6df0" },
];

// Colour-grading wheels: the four tonal ranges (blending/balance are separate
// scalars on ColorGrading).
type GradeRange = "shadows" | "midtones" | "highlights" | "global";
const GRADE_RANGES: { key: GradeRange; label: string }[] = [
  { key: "shadows", label: "Shadows" },
  { key: "midtones", label: "Midtones" },
  { key: "highlights", label: "Highlights" },
  { key: "global", label: "Global" },
];

// Mask editing on the canvas: minimum radial radius (fraction), the grab radius
// for overlay handles (screen px, converted to a fraction tolerance per axis),
// and how far above the ellipse top the rotation handle sits (fraction).
const MASK_MIN_R = 0.02;
const MASK_HANDLE_PX = 13;
const MASK_ROT_OFF = 0.07;
// Flags on a brush stroke sample ([x, y, size, flags]); must match
// masks._PEN_DOWN / masks._ERASE on the backend, which uses them to recover
// stroke boundaries and erase strokes from the flat sample list.
const BRUSH_PEN_DOWN = 1;
const BRUSH_ERASE = 2;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
// Gap between the two panes of the side-by-side compare (matches .editor-pair's
// CSS gap, which the fit maths has to subtract before halving the stage).
const PAIR_GAP = 12;

// Colour calibration: seven -100..100 sliders.
const CALIB_FIELDS: { key: keyof ColorCalibration; label: string }[] = [
  { key: "shadows_tint", label: "Shadows Tint" },
  { key: "red_hue", label: "Red Primary Hue" },
  { key: "red_saturation", label: "Red Primary Saturation" },
  { key: "green_hue", label: "Green Primary Hue" },
  { key: "green_saturation", label: "Green Primary Saturation" },
  { key: "blue_hue", label: "Blue Primary Hue" },
  { key: "blue_saturation", label: "Blue Primary Saturation" },
];

// Crop aspect-ratio presets. `ratio` is width/height; "orig" locks to the
// framed image's own aspect, null lets you drag any shape.
type AspectVal = number | "orig" | null;
const ASPECT_OPTIONS: { value: string; label: string; ratio: AspectVal }[] = [
  { value: "free", label: "Freeform", ratio: null },
  { value: "orig", label: "Original", ratio: "orig" },
  { value: "1:1", label: "1:1 · Square", ratio: 1 },
  { value: "3:2", label: "3:2", ratio: 3 / 2 },
  { value: "2:3", label: "2:3", ratio: 2 / 3 },
  { value: "4:3", label: "4:3", ratio: 4 / 3 },
  { value: "3:4", label: "3:4", ratio: 3 / 4 },
  { value: "5:4", label: "5:4", ratio: 5 / 4 },
  { value: "4:5", label: "4:5", ratio: 4 / 5 },
  { value: "7:5", label: "7:5", ratio: 7 / 5 },
  { value: "5:7", label: "5:7", ratio: 5 / 7 },
  { value: "16:9", label: "16:9", ratio: 16 / 9 },
  { value: "9:16", label: "9:16", ratio: 9 / 16 },
];

// The largest crop of fraction-space ratio k (= width/height in fractions of
// the framed image), centred in the frame.
function centeredDragForK(k: number): DragRect {
  const fw = k >= 1 ? 1 : k;
  const fh = k >= 1 ? 1 / k : 1;
  const x0 = (1 - fw) / 2;
  const y0 = (1 - fh) / 2;
  return { x0, y0, x1: x0 + fw, y1: y0 + fh };
}

// Force a drag rect to fraction-space ratio k while keeping the anchor corner
// fixed and staying inside [0,1].
function constrainDragToK(r: DragRect, k: number): DragRect {
  const sx = r.x1 >= r.x0 ? 1 : -1;
  const sy = r.y1 >= r.y0 ? 1 : -1;
  let adx = Math.abs(r.x1 - r.x0);
  let ady = Math.abs(r.y1 - r.y0);
  if (ady < 1e-9 || adx / ady > k) adx = ady * k;
  else ady = adx / k;
  const maxAdx = sx > 0 ? 1 - r.x0 : r.x0;
  const maxAdy = sy > 0 ? 1 - r.y0 : r.y0;
  let scale = 1;
  if (adx > maxAdx) scale = Math.min(scale, maxAdx / adx);
  if (ady > maxAdy) scale = Math.min(scale, maxAdy / ady);
  adx *= scale;
  ady *= scale;
  return { x0: r.x0, y0: r.y0, x1: r.x0 + sx * adx, y1: r.y0 + sy * ady };
}

function normalizeRect(r: DragRect): CropBox {
  return {
    x: Math.min(r.x0, r.x1),
    y: Math.min(r.y0, r.y1),
    width: Math.abs(r.x1 - r.x0),
    height: Math.abs(r.y1 - r.y0),
  };
}

function GridLines({ type }: { type: GridOverlay }) {
  if (type === "none") return null;
  // Dark grey lines (with a faint light edge from CSS drop-shadow) so the
  // composition guides stay subtle and readable over most photos.
  const stroke = "rgba(40,40,46,0.7)";
  const line = (x1: number, y1: number, x2: number, y2: number, i: number) => (
    <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
  );
  const els: JSX.Element[] = [];
  if (type === "thirds") {
    [33.333, 66.666].forEach((p, i) => els.push(line(p, 0, p, 100, i)));
    [33.333, 66.666].forEach((p, i) => els.push(line(0, p, 100, p, i + 2)));
  } else if (type === "grid") {
    [25, 50, 75].forEach((p, i) => els.push(line(p, 0, p, 100, i)));
    [25, 50, 75].forEach((p, i) => els.push(line(0, p, 100, p, i + 3)));
  } else if (type === "diagonal") {
    els.push(line(0, 0, 100, 100, 0), line(100, 0, 0, 100, 1));
  }
  return (
    <svg className="editor-grid-overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
      {els}
    </svg>
  );
}

// Move keyboard focus between the currently rendered sliders (only the open
// accordion group's sliders exist in the DOM). `from` = null enters the list
// from outside: ArrowDown lands on the first slider, ArrowUp on the last.
// Returns the newly focused input, or null when there was nowhere to go.
function focusAdjacentSlider(from: HTMLInputElement | null, dir: 1 | -1): HTMLInputElement | null {
  const all = Array.from(document.querySelectorAll<HTMLInputElement>('.editor-panel .editor-slider input[type="range"]'));
  if (all.length === 0) return null;
  const next = from ? all[all.indexOf(from) + dir] : dir === 1 ? all[0] : all[all.length - 1];
  if (!next) return null;
  next.focus();
  next.scrollIntoView({ block: "nearest" });
  return next;
}

function Slider({
  label,
  value,
  onChange,
  min = -100,
  max = 100,
  step,
  format,
  resetValue = 0,
  uiScale = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  // Optional value formatter (e.g. exposure rendered in EV stops).
  format?: (v: number) => string;
  // Value a double-click resets to - the field's real default, which isn't
  // always 0 (grain size, vignette midpoint/feather, sharpness threshold).
  resetValue?: number;
  // Display divisor (ScalarDef.uiScale): the slider shows value/uiScale while
  // onChange/value stay in the stored full-range units.
  uiScale?: number;
}) {
  const uiValue = value / uiScale;
  // Saved edits can hold odd internal values (uiValue x.5) - display rounded.
  const uiShown = Math.round(uiValue);
  return (
    <label className="editor-slider">
      <span className="editor-slider-head">
        <span>{label}</span>
        <span className="editor-slider-val">{format ? format(uiValue) : uiShown > 0 ? `+${uiShown}` : uiShown}</span>
      </span>
      <input
        type="range"
        min={min / uiScale}
        max={max / uiScale}
        step={step}
        value={uiValue}
        onChange={(e) => onChange(Number(e.target.value) * uiScale)}
        onDoubleClick={() => onChange(resetValue)}
        onKeyDown={(e) => {
          // Up/down walk the slider list; left/right keep the native "nudge
          // the value" behaviour of a focused range input.
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          focusAdjacentSlider(e.currentTarget, e.key === "ArrowDown" ? 1 : -1);
        }}
        title="Double-click to reset"
      />
    </label>
  );
}

// Compute a histogram (4 x 256 bins: R, G, B, luma) from a rendered preview,
// sampling ~120k pixels regardless of size. The luma bin is what the curve
// editor draws behind the Luma channel - the master curve maps luminance, so a
// per-channel silhouette would be the wrong backdrop to shape it against.
function computeHistBins(img: ImageData): Uint32Array[] {
  const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const d = img.data;
  const step = Math.max(1, Math.floor(d.length / 4 / 120000)) * 4;
  for (let i = 0; i < d.length; i += step) {
    bins[0][d[i]]++;
    bins[1][d[i + 1]]++;
    bins[2][d[i + 2]]++;
    bins[3][luma255(d[i], d[i + 1], d[i + 2])]++;
  }
  return bins;
}

// Rec.709 luma, the same weighting the backend's curves use (_LUMA in
// develop_color.py), rounded onto the 0..255 grid.
function luma255(r: number, g: number, b: number): number {
  return Math.max(0, Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)));
}

// Histogram readback goes through a small scratch canvas: the preview is
// downscaled to ~120k pixels first, so getImageData is a fixed small copy
// instead of a synchronous multi-megapixel readback of the display canvas.
// That readback cost was why the histogram used to be skipped during drags;
// at this size it can run on every scrub frame.
let histScratch: HTMLCanvasElement | null = null;
function computeHistBinsFromBitmap(bmp: ImageBitmap): Uint32Array[] | null {
  const scale = Math.min(1, Math.sqrt(120000 / (bmp.width * bmp.height)));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  histScratch ??= document.createElement("canvas");
  histScratch.width = w;
  histScratch.height = h;
  const ctx = histScratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0, w, h);
  return computeHistBins(ctx.getImageData(0, 0, w, h));
}

// A live RGB histogram (Lightroom/RapidRAW-style): screen-blended channel fills,
// sqrt scaling so shadow/highlight detail stays readable next to midtone peaks.
// Driven by `bins` from state so it survives being unmounted/remounted as
// accordion groups open and close - it redraws on mount AND when the bins change
// (the old version only drew on preview render, so a collapsed group's histogram
// was blank until the next edit).
function Histogram({ bins }: { bins: Uint32Array[] | null }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const hc = ref.current;
    if (!hc) return;
    const ctx = hc.getContext("2d")!;
    const W = hc.width;
    const H = hc.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#141416";
    ctx.fillRect(0, 0, W, H);
    if (!bins) return;
    let max = 1;
    for (let ch = 0; ch < 3; ch++) {
      for (let v = 1; v < 255; v++) if (bins[ch][v] > max) max = bins[ch][v];
    }
    ctx.globalCompositeOperation = "screen";
    const colors = ["#c33f3f", "#3f9c4a", "#3f63c3"];
    for (let ch = 0; ch < 3; ch++) {
      ctx.fillStyle = colors[ch];
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let v = 0; v < 256; v++) {
        const y = H - Math.min(1, Math.sqrt(bins[ch][v] / max)) * (H - 2);
        ctx.lineTo((v / 255) * W, y);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }, [bins]);
  return <canvas ref={ref} className="editor-histogram" width={256} height={64} />;
}

export function PhotoEditor({ image, onClose }: Props) {
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const { withWait } = useWait();
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stageMainRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panDragRef = useRef<{ x: number; y: number } | null>(null);
  // RGB histogram bins of the latest preview; the <Histogram> components (in the
  // Basic and Curves groups) draw from this and redraw when it changes or on mount.
  const [histBins, setHistBins] = useState<Uint32Array[] | null>(null);
  // Downscaled copy of the current preview for the curve picker. Reading a
  // pixel straight off the display canvas per pointer-move would force a GPU
  // readback of the whole (multi-megapixel) surface each time; this is copied
  // once per rendered frame, lazily, and only while the picker is armed.
  const pickSnapRef = useRef<{ data: ImageData; w: number; h: number } | null>(null);
  // The UNCROPPED framed image in pixels, recovered from the last painted frame
  // and the crop that frame was rendered with. Mask coordinates are fractions of
  // the *cropped* frame, so moving them across a crop change needs the frame
  // they're fractions of (see remapMasksForCrop).
  const frameBaseRef = useRef<{ width: number; height: number } | null>(null);
  // Square is the harmless fallback before the first frame has been painted:
  // it only feeds the brush-size scaling, and nothing is croppable yet anyway.
  const frameBase = () => frameBaseRef.current ?? { width: 1, height: 1 };
  // Server preview plumbing: abort a stale in-flight render when a newer edit
  // state supersedes it, and ignore late responses by sequence number.
  const abortRef = useRef<AbortController | null>(null);
  const fullAbortRef = useRef<AbortController | null>(null);
  const renderSeq = useRef(0);
  // Coalescing live-preview loop (see the pump effect below). `scrubbing` is true
  // while any pointer is held down over the editor - a slider/curve/wheel/mask
  // drag - so those frames render the cheap "scrub" tier and only snap to the
  // accurate render on release. `previewEditsLatest` always holds the newest edit
  // state; the two tokens let the pump skip past superseded states instead of
  // rendering every one, so a fast drag never backs up a queue of stale renders.
  const scrubbing = useRef(false);
  // Hold-to-compare renders the original: it must show at the accurate/full tier,
  // never the scrub tier - even though holding the button holds the pointer down
  // (which would otherwise flip on scrub mode). Mirrors the `compare` state.
  const compareRef = useRef(false);
  // Current zoom factor - read by the settle pass to work out whether the frame
  // it painted is being shown upscaled, and so whether it should chase the
  // true-resolution render.
  const scaleRef = useRef(1);

  // Is the frame currently on the canvas being stretched past its own pixels?
  // Compares the canvas's on-screen size in DEVICE pixels (layout size x zoom x
  // devicePixelRatio) against the bitmap actually painted into it. This is the
  // question "is the photo soft right now", which is what decides whether a
  // full-resolution render is worth its seconds of CPU - a plain `scale > 1`
  // test misses a hi-dpi screen, where the photo is already upscaled at fit.
  function isUpscaled(): boolean {
    const cv = canvasRef.current;
    if (!cv || !cv.width || !cv.height) return false;
    const dpr = window.devicePixelRatio || 1;
    const shownW = (parseFloat(cv.style.width) || 0) * scaleRef.current * dpr;
    const shownH = (parseFloat(cv.style.height) || 0) * scaleRef.current * dpr;
    // A pixel of slack: rounding in fitCanvasToStage shouldn't trigger a render.
    return shownW > cv.width + 1 || shownH > cv.height + 1;
  }
  // The dirty-token at the moment the pointer went down, so pointer-up can tell a
  // real drag (edits changed → snap to the accurate render) from a plain click
  // that happened to land in the editor (nothing changed → skip the re-render).
  const dragBaseToken = useRef(0);
  const previewEditsLatest = useRef<ImageEdits | null>(null);
  const dirtyToken = useRef(0);
  const renderedToken = useRef(-1);
  const pumping = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pumpRef = useRef<() => void>(() => {});
  // Whether the last accurate render took long (heavy passes like denoise/
  // dehaze/clarity active). When true, discrete changes paint a cheap scrub
  // frame FIRST so there's visual feedback within ~150ms instead of the editor
  // looking stuck until the accurate frame lands seconds later.
  const slowAccurate = useRef(false);

  // The RGB histogram is drawn by the module-level <Histogram> component from the
  // bins computed after each preview render (see setHistBins below); it appears in
  // both the Basic and Curves groups and survives accordion open/close.

  // The canvas's on-screen size must not follow its bitmap size (the default
  // for a canvas): the fast preview and the full-resolution refinement that
  // replaces it moments later have different pixel sizes, so the photo
  // visibly jumped between the two renders (and on every slider change).
  // Instead, fit the canvas into the stage from its aspect ratio - both
  // renders of the same edit state then display at exactly the same size.
  function fitCanvasToStage() {
    const canvas = canvasRef.current;
    const box = stageMainRef.current;
    if (!canvas || !box || !canvas.width || !canvas.height) return;
    // Fit into the box's CONTENT area: getBoundingClientRect includes the
    // box's padding, so fitting against it pressed the photo flush against
    // the frame's edges instead of leaving the padding visible.
    const rect = box.getBoundingClientRect();
    const cs = getComputedStyle(box);
    let width = rect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const height = rect.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (width < 2 || height < 2) return;
    // Side by side puts two panes of equal size in this one box.
    if (pairRef.current) width = Math.max(2, (width - PAIR_GAP) / 2);
    const s = Math.min(width / canvas.width, height / canvas.height);
    const w = `${Math.round(canvas.width * s)}px`;
    const h = `${Math.round(canvas.height * s)}px`;
    canvas.style.width = w;
    canvas.style.height = h;
    // The original pane is the same picture in the same frame, so it takes the
    // edited pane's size exactly - whatever tier either was rendered at.
    const orig = origCanvasRef.current;
    if (orig && pairRef.current) {
      orig.style.width = w;
      orig.style.height = h;
    }
  }

  // Refit whenever the stage box itself changes size - not just on window
  // resize. The stage shrinks after load (the background/compare row appears)
  // and, in narrow stacked layouts, whenever the panel's accordion grows; with
  // only the window listener the canvas kept its stale size and overflowed
  // over the controls.
  useEffect(() => {
    const box = stageMainRef.current;
    if (!box) return;
    // A refit changes how big the photo is shown, and therefore how much
    // resolution it needs - a wider window (or a move to a hi-dpi screen) can
    // leave the settled frame upscaled. Re-settle so it never stays soft.
    const onResize = () => {
      fitCanvasToStage();
      // Only worth a render if the new fit actually leaves the photo stretched -
      // this fires on every accordion open and window-drag tick too.
      if (isUpscaled()) scheduleSettleRef.current();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(box);
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Memoised: editsFromImage JSON-parses the stored adjustments - doing that on
  // every render (every hover/cursor state change) was a steady per-frame cost.
  const saved = useMemo(() => editsFromImage(image), [image]);
  const savedKey = useMemo(() => JSON.stringify(saved), [saved]);
  const [adj, setAdj] = useState<Adjustments>(() => adjustmentsFromImage(image));
  const [rotation, setRotation] = useState(saved.rotation);
  const [crop, setCrop] = useState<CropBox | null>(saved.crop);
  const [flipH, setFlipH] = useState(saved.flipH);
  const [flipV, setFlipV] = useState(saved.flipV);
  const [straighten, setStraighten] = useState(saved.straighten);
  const [perspH, setPerspH] = useState(saved.perspH);
  const [perspV, setPerspV] = useState(saved.perspV);
  const [distortion, setDistortion] = useState(saved.distortion);
  // Which colour band the HSL mixer edits (the values live in adj.hsl).
  const [band, setBand] = useState<ColorBand>("red");
  // Which channel the curves editor targets (point + parametric share it).
  const [curveChannel, setCurveChannel] = useState<CurveChannel>("luma");
  // Targeted-adjustment picker ("TAT" in Lightroom): armed from the curve
  // toolbar, then a drag on the photo moves the curve where the tone under the
  // pointer lives. `curveMarker` is that tone's input value (0..255), shown as a
  // guide in the plot while the pointer is over the image.
  const [curvePickMode, setCurvePickMode] = useState(false);
  const [curveMarker, setCurveMarker] = useState<number | null>(null);
  // Live picker drag: where it started, so every move is applied against the
  // curve as it was at pointerdown instead of compounding.
  const curvePickDrag = useRef<{ x: number; clientY: number; baseY: number; baseParam: number[] } | null>(null);
  const [gridOverlay, setGridOverlay] = useState<GridOverlay>("none");
  const [presets, setPresets] = useState<Record<string, EditPreset>>(() => loadPresets());
  const [selectedPreset, setSelectedPreset] = useState("");
  // Inline preset naming (Electron has no window.prompt).
  const [namingPreset, setNamingPreset] = useState(false);
  // Save-copy options dialog (quality/size, export-style) - the render runs
  // while it's open, so it doubles as the progress popup.
  const [saveCopyOpen, setSaveCopyOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [cropMode, setCropMode] = useState(false);
  const [drag, setDrag] = useState<DragRect | null>(null);
  const [dragging, setDragging] = useState(false);
  // Active crop gesture: draw a fresh box ("new"), move it ("move") or resize
  // from an edge/corner ("nw".."e"). Held in a ref so the move handler reads the
  // box as it was when the gesture began, not a stale render value.
  const cropAction = useRef<{ mode: string; start: { x: number; y: number }; orig: CropBox } | null>(null);
  // Active on-canvas mask gesture (radial/linear drag or brush stroke). Held in
  // a ref so the move handler reads the anchor as it was at pointer-down, and so
  // dragging doesn't hinge on a state update landing first.
  // Active on-canvas mask gesture: which mask, what the pointer-down hit
  // ("create" | "move" | resize handle "e".."sw" | "rotate" for radial;
  // "create" | "start" | "end" | "line" for linear; "paint" for brush), the
  // pointer-down fraction, and a snapshot of the shape's params at grab time so
  // move/resize stay relative to the grab, not the live (changing) value.
  const maskGesture = useRef<{
    type: SubMaskType;
    maskId: string;
    mode: string;
    start: { x: number; y: number };
    orig: Record<string, number>;
    // Brush only: this stroke removes instead of paints, so every sample of it
    // carries the erase flag (the mode is fixed at pointer-down, so releasing
    // Alt mid-stroke doesn't switch it half way).
    erase?: boolean;
  } | null>(null);
  const brushLast = useRef<{ x: number; y: number } | null>(null);
  // Eraser latch for the brush; Alt inverts it for one stroke.
  const [brushErase, setBrushErase] = useState(false);
  const [cropCursor, setCropCursor] = useState("crosshair");
  // Crop aspect-ratio lock (key into ASPECT_OPTIONS; "free" = unconstrained).
  const [aspectKey, setAspectKey] = useState("free");
  // Masks (local adjustments). One mask is selected at a time; drawing a
  // radial/linear/brush sub-mask happens on the canvas in mask-draw mode
  // (mutually exclusive with crop mode). The colour eyedropper samples the next
  // canvas click for a colour sub-mask's target.
  const [selectedMaskId, setSelectedMaskId] = useState<string | null>(null);
  const [maskDrawMode, setMaskDrawMode] = useState(false);
  const [colorPickMode, setColorPickMode] = useState(false);
  // Subject detection ("Sky", "Water", ...): which subject is being looked for
  // right now (null = idle), and the last failure to show under the buttons.
  const [segmenting, setSegmenting] = useState<string | null>(null);
  const [segmentError, setSegmentError] = useState<string | null>(null);
  // Which mask row in the panel the pointer is over. The marking showing what a
  // mask covers is exactly what's in the way once you start adjusting - it sits
  // on top of the change you're trying to judge - so it isn't a mode: point at a
  // mask in the list to see it, move away and the photo is clean again. While
  // drawing on the image the selected mask stays marked regardless, since you
  // can't paint what you can't see.
  const [hoveredMaskId, setHoveredMaskId] = useState<string | null>(null);
  // Live cursor over the canvas while editing a mask (reflects the handle/body
  // under the pointer), and the pointer position for the brush-size ring.
  const [maskCursor, setMaskCursor] = useState("crosshair");
  const [maskCursorPos, setMaskCursorPos] = useState<{ x: number; y: number } | null>(null);
  // Which control-panel accordion group is expanded. Only one is open at a time
  // ("" = all collapsed); purely presentational grouping of the existing panel.
  // Opens fully collapsed, so the panel starts as a plain list of groups and
  // the photo is what you look at first.
  const [openGroup, setOpenGroup] = useState<string>("");

  // Leaving the Masks group hides the mask guides/handles on the image (see the
  // MaskOverlay render condition) - also drop out of draw/pick mode so canvas
  // clicks go back to zoom/pan/crop.
  useEffect(() => {
    if (openGroup !== "masks") {
      setMaskDrawMode(false);
      setColorPickMode(false);
      setSegmentError(null);
    } else {
      // Opening the panel is the earliest honest sign that a subject mask might
      // be wanted, and the model pass costs the same whether it runs now or on
      // the click - so start it now, while the user is still reading the list.
      // One pass covers all six subjects. Fire and forget: runSegment behaves
      // exactly as before if this never finishes.
      api.images.segmentPrepare(image.id, previewEdits).catch(() => {});
    }
    // The targeted picker is what the Curves panel is *for* - pointing at the
    // tone you want to change beats guessing which part of the x axis it sits
    // on - so opening the group arms it. The toolbar button still disarms it,
    // and leaving the group puts it away (it only makes sense with the plot in
    // view). Arming takes the canvas pointer, so drop the other canvas modes.
    if (openGroup === "curves") {
      setCurvePickMode(true);
      setMaskDrawMode(false);
      setColorPickMode(false);
    } else {
      setCurvePickMode(false);
      setCurveMarker(null);
    }
    // Same idea for Transform: the group *is* the crop tool, so opening it arms
    // the crop box (seeded from the crop already applied) rather than hiding it
    // behind a mode button - ratio, Apply and Clear then sit in the panel with
    // the rest of the geometry instead of appearing and reflowing it. Leaving
    // the group puts the box away; the canvas pointer goes back to zoom/pan.
    if (openGroup === "transform") {
      setCropMode(true);
      setMaskDrawMode(false);
      setColorPickMode(false);
      setDrag(crop ? { x0: crop.x, y0: crop.y, x1: crop.x + crop.width, y1: crop.y + crop.height } : null);
    } else {
      setCropMode(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openGroup]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [bgMode, setBgMode] = useState<"light" | "dark">("light");
  // Hold-to-compare: while true, the canvas re-renders with every tonal/colour/
  // effect neutralised (geometry kept, so the frame doesn't jump) - a quick
  // before/after against the original.
  const [compare, setCompare] = useState(false);
  // Two ways to hold the original next to the edit instead of alternating with
  // it, both fed by the same second render (see drawOriginal / paintOriginal):
  //  - "split": the original laid over the photo up to a line you drag. Same
  //    picture, same pixels, so a tonal change is judged where it happens.
  //  - "pair":  the two as separate pictures side by side. Half the size, but
  //    nothing is hidden - which is what you want for framing and colour.
  const [compareMode, setCompareMode] = useState<"off" | "split" | "pair">("off");
  const split = compareMode === "split";
  const pair = compareMode === "pair";
  const [splitPos, setSplitPos] = useState(0.5);
  const origCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const splitDragRef = useRef(false);
  // Read by the preview pump (does the original need rendering at all?) and by
  // fitCanvasToStage / clampPan, which measure against half the stage in "pair".
  const wantOrigRef = useRef(false);
  const pairRef = useRef(false);
  // Bumped when the original half goes stale (geometry changed); compared
  // against what's actually painted on the original canvas.
  const origToken = useRef(0);
  const origRendered = useRef(-1);
  // Scroll/pinch to zoom (toward cursor), drag to pan - same as the lightbox.
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const MAX_ZOOM = 6;
  const MIN_ZOOM = 0.2; // allow zooming out below fit
  const zoomed = scale > 1.001;

  function resetZoom() {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }

  // Clamp the pan so the view stays *inside the image* - you can never pan past
  // the image edges into the empty frame. The max offset is how far the scaled
  // image overhangs the viewport; it's 0 when the image fits or is zoomed out, so
  // it stays centred then.
  function clampPan(p: { x: number; y: number }, s: number) {
    const cv = canvasRef.current;
    const stage = stageMainRef.current;
    if (!cv || !stage) return p;
    const dispW = parseFloat(cv.style.width) || 0;
    const dispH = parseFloat(cv.style.height) || 0;
    // Side by side: the viewport a pane can be panned inside is half the stage.
    const viewW = pairRef.current ? Math.max(2, (stage.clientWidth - PAIR_GAP) / 2) : stage.clientWidth;
    const maxX = Math.max(0, (dispW * s - viewW) / 2);
    const maxY = Math.max(0, (dispH * s - stage.clientHeight) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, p.x)), y: Math.max(-maxY, Math.min(maxY, p.y)) };
  }

  // Memoised so the object identity only changes when an edit actually changes -
  // hover/cursor/zoom re-renders reuse the same object and skip every JSON walk
  // below. With brush masks the strokes array grows into the thousands of
  // points, so stringifying it on each render made the whole editor drag.
  const edits: ImageEdits = useMemo(
    () => ({ rotation, crop, flipH, flipV, straighten, perspH, perspV, distortion, adjustments: adj }),
    [rotation, crop, flipH, flipV, straighten, perspH, perspV, distortion, adj]
  );

  const drawn = drag ? normalizeRect(drag) : null;
  const hasDrawnCrop = drawn && drawn.width > 0.02 && drawn.height > 0.02;

  // What the preview should actually show right now: in crop mode the full
  // (uncropped) frame, in compare mode the untouched original with only the
  // geometry kept so the frame doesn't jump.
  //
  // The white frame expands the canvas, which would offset the crop-rect and
  // mask overlays (they're positioned as fractions of the displayed image), so
  // it's dropped from the preview while such an overlay is up. The test is
  // whether one is ACTUALLY ON SCREEN, not whether its mode is armed: opening
  // Transform arms the crop box, and the White frame slider lives in that very
  // section, so keying this on the mode made the one control you cannot judge
  // without seeing it the one control that never appeared - it only showed once
  // you left for another section. With no crop box drawn there is no overlay to
  // misalign, which is the state the slider is normally reached in.
  const cropRectVisible = cropMode && !!hasDrawnCrop;
  const maskOverlayVisible = openGroup === "masks" && (maskDrawMode || hoveredMaskId !== null);
  const overlayActive = cropRectVisible || maskOverlayVisible || compareMode !== "off";
  const previewEdits: ImageEdits = useMemo(() => {
    if (compare) {
      return neutralEdits(rotation, cropMode ? null : crop, flipH, flipV, straighten, perspH, perspV, distortion);
    }
    let adjustments = overlayActive && adj.frame_width ? { ...adj, frame_width: 0 } : adj;
    // Crop mode shows the UNCROPPED frame, and mask coordinates are fractions of
    // the cropped one - so re-express them for this preview or every mask's
    // effect sits somewhere else for as long as the crop box is open. Preview
    // only: the stored masks move when the crop is actually applied.
    if (cropMode && crop && adjustments.masks.length) {
      adjustments = { ...adjustments, masks: remapMasksForCrop(adjustments.masks, crop, null, frameBase()) };
    }
    return { ...edits, crop: cropMode ? null : crop, adjustments };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, compare, cropMode, overlayActive]);
  // The untouched photo in the same frame as the preview above it, which is what
  // the split view's left half shows.
  const origEdits: ImageEdits = useMemo(
    () => neutralEdits(rotation, cropMode ? null : crop, flipH, flipV, straighten, perspH, perspV, distortion),
    [rotation, crop, cropMode, flipH, flipV, straighten, perspH, perspV, distortion]
  );

  // Always hand the pump the newest edit state (read from a ref so the pump and
  // the pointer-up handler don't close over a stale value).
  previewEditsLatest.current = previewEdits;
  compareRef.current = compare;
  scaleRef.current = scale;
  wantOrigRef.current = compareMode !== "off";
  pairRef.current = pair;
  const origEditsLatest = useRef(origEdits);
  origEditsLatest.current = origEdits;

  // Paint a rendered JPEG onto the canvas, sizing it to the bitmap and
  // (optionally) refreshing the histogram. `seq` guards against a late or
  // superseded render painting over a newer frame.
  // `renderCrop` is the crop this frame was rendered with - the frame's own
  // pixel size divided by it gives the uncropped frame (see frameBaseRef).
  const drawBlob = useCallback(async (blob: Blob, seq: number, withHistogram: boolean, renderCrop: CropBox | null) => {
    const bmp = await createImageBitmap(blob);
    try {
      if (seq !== renderSeq.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Only touch the size when it actually changed. Assigning canvas.width or
      // .height reallocates the backing store and resets the context even when
      // the value is identical, and fitCanvasToStage reads getBoundingClientRect
      // + getComputedStyle, which forces a synchronous layout. Every frame of a
      // slider drag comes back at the same size, so all of that was pure cost
      // paid ~30 times a second for nothing - and it is exactly the kind of
      // per-frame stall that reads as a jerky drag.
      frameBaseRef.current = {
        width: bmp.width / (renderCrop?.width || 1),
        height: bmp.height / (renderCrop?.height || 1),
      };
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        fitCanvasToStage();
      }
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      pickSnapRef.current = null; // a new frame - the picker's copy is stale
      if (withHistogram) {
        const bins = computeHistBinsFromBitmap(bmp);
        if (bins) setHistBins(bins);
      }
    } finally {
      // Release the decoded bitmap immediately - relying on GC leaked dozens of
      // full frames per editing session (every scrub tick decodes a new one).
      bmp.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paint the compare view's original onto its own canvas, and keep the frame
  // that was rendered: switching between split and side-by-side moves that
  // canvas in the DOM, so React hands us a *new*, blank element and the same
  // frame has to go back onto it - re-fetching it would be a render nobody
  // needs. It's sized to the edited canvas (CSS in split, fitCanvasToStage in
  // pair), so its own pixel size never has to match the edited tier.
  const origFrame = useRef<Blob | null>(null);
  const paintOriginal = useCallback(async () => {
    const blob = origFrame.current;
    const cv = origCanvasRef.current;
    if (!blob || !cv) return;
    const bmp = await createImageBitmap(blob);
    try {
      if (origCanvasRef.current !== cv) return; // moved again while decoding
      cv.width = bmp.width;
      cv.height = bmp.height;
      cv.getContext("2d")!.drawImage(bmp, 0, 0);
      fitCanvasToStage();
    } finally {
      bmp.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const drawOriginal = useCallback(
    async (blob: Blob) => {
      origFrame.current = blob;
      await paintOriginal();
    },
    [paintOriginal]
  );

  // Once edits come to rest, refine on the larger full-quality base so the
  // resolution-dependent passes (denoise/sharpen radii, grain) preview as they
  // will be saved. Cancelled the instant a new drag starts.
  const scheduleSettle = useCallback(() => {
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(async () => {
      // A pointer is down, so a drag may still be in flight - but the settle
      // must not be *dropped* here, or the photo stays on a preview tier until
      // the next edit happens to come along (press the mouse again inside the
      // 350ms and nothing would ever refine it). Re-arm and wait it out.
      // Hold-to-compare keeps the pointer down but still wants the full render.
      if (scrubbing.current && !compareRef.current) {
        scheduleSettleRef.current();
        return;
      }
      const seq = renderSeq.current;
      fullAbortRef.current?.abort();
      const fctrl = new AbortController();
      fullAbortRef.current = fctrl;
      try {
        // Climb the quality ladder one rung at a time, re-checking after each
        // painted frame whether the photo is STILL being shown upscaled - so it
        // stops the moment the picture on screen covers its own pixels, and each
        // rung is a visible improvement rather than one long stall.
        //
        // On the test file (40MP Fuji raw): "full" is ~1.0s, "ultra" ~2.2s for
        // no extra decode at all (it's the size the half-size demosaic already
        // hands back - the old ladder threw those pixels away), and "native" is
        // 13.6s of decode plus 18.4s of pipeline. So a hi-dpi fit view now
        // settles at "ultra" and never pays for native; only a real zoom, where
        // nothing else can supply the detail, goes the whole way.
        //
        // Same abort controller throughout: any new edit or drag cancels the
        // rest of the climb, and the seq guard drops a rung whose frame was
        // superseded while it rendered.
        for (const tier of ["full", "ultra", "native"] as const) {
          const blob = await api.images.editorPreview(image.id, previewEditsLatest.current!, fctrl.signal, tier);
          if ((scrubbing.current && !compareRef.current) || seq !== renderSeq.current) return;
          await drawBlob(blob, seq, false, previewEditsLatest.current!.crop);
          if (!isUpscaled()) break;
        }
      } catch {
        // Non-fatal: the accurate preview is already on screen.
      }
    }, 350);
  }, [image.id, drawBlob]);
  // Re-entry point for the re-arm above (scheduleSettle can't name itself).
  const scheduleSettleRef = useRef<() => void>(() => {});
  scheduleSettleRef.current = scheduleSettle;

  // The live-preview pump. It renders the *latest* edit state, one request at a
  // time - never a backlog of superseded renders on the (uninterruptible) numpy
  // pipeline. While a control is being dragged it renders the cheap "scrub"
  // tier; a discrete change renders the accurate tier and then the pump follows
  // with the full-quality settle. There is no fixed debounce: the loop is
  // self-throttling - it only starts the next render when the last one returns,
  // so it runs as fast as the server can, which is what makes a drag feel live.
  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    clearTimeout(settleTimer.current);
    try {
      // The compare view's original rides in this same loop rather than fetching
      // alongside it: the server keeps only the newest preview request per image
      // and drops the rest, so two concurrent fetches would cancel each other at
      // random. Edits come first; the original is brought up to date once
      // they're settled.
      while (
        renderedToken.current !== dirtyToken.current ||
        (wantOrigRef.current && origRendered.current !== origToken.current)
      ) {
        if (renderedToken.current === dirtyToken.current) {
          const otoken = origToken.current;
          abortRef.current?.abort();
          fullAbortRef.current?.abort();
          const octrl = new AbortController();
          abortRef.current = octrl;
          try {
            // browse=1: a raw's "original" is the auto-exposed picture the
            // library shows, not the editor's deliberately dark native base.
            const blob = await api.images.editorPreview(image.id, origEditsLatest.current, octrl.signal, "fast", true);
            await drawOriginal(blob);
          } catch {
            // Non-fatal - the original half keeps whatever it had. Marked
            // rendered either way so a failure can't spin this loop.
          }
          origRendered.current = otoken;
          continue;
        }
        const token = dirtyToken.current;
        // Hold-to-compare shows the original at the accurate tier, so it renders
        // fast/full even while the pointer is held down.
        const scrub = scrubbing.current && !compareRef.current;
        const edits = previewEditsLatest.current!;
        const seq = ++renderSeq.current;
        abortRef.current?.abort();
        fullAbortRef.current?.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        try {
          // Progressive feedback: when the accurate tier has been slow, show a
          // scrub frame of this edit state right away, then let the accurate
          // render replace it. Costs one cheap extra render; turns "the editor
          // is stuck" into "instant preview, sharpens a moment later".
          if (!scrub && slowAccurate.current) {
            const quick = await api.images.editorPreview(image.id, edits, ctrl.signal, "scrub");
            await drawBlob(quick, seq, true, edits.crop);
            setLoading(false);
            setReady(true);
          }
          // The histogram updates on every frame, scrub frames included, so it
          // tracks the sliders live - cheap now that it reads a downscaled
          // scratch canvas instead of the full preview canvas.
          const t0 = performance.now();
          const blob = await api.images.editorPreview(image.id, edits, ctrl.signal, scrub ? "scrub" : "fast");
          if (!scrub) slowAccurate.current = performance.now() - t0 > 300;
          await drawBlob(blob, seq, true, edits.crop);
          setError(null);
          setLoading(false);
          setReady(true);
        } catch (e) {
          if ((e as Error).name !== "AbortError") {
            setError(`Couldn't render the preview: ${(e as Error).message}`);
            setLoading(false);
          }
        }
        renderedToken.current = token;
      }
    } finally {
      pumping.current = false;
    }
    // Every pump ends with a settle pending - unconditionally, which is the
    // whole invariant: whatever frame the loop left on the canvas, a
    // full-quality one is on its way. Called mid-drag it costs nothing, because
    // the settle re-arms itself while a pointer is down instead of rendering.
    scheduleSettle();
  }, [image.id, drawBlob, drawOriginal, scheduleSettle]);
  pumpRef.current = () => void pump();

  // Kick the pump whenever the edit state changes (or the image switches).
  // previewEdits is memoised, so its identity IS the change signal - no
  // stringify of the whole edit state per render just to build a key.
  useEffect(() => {
    dirtyToken.current++;
    void pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image.id, previewEdits]);

  // Geometry moved, so the compare view's original no longer matches the frame
  // it's shown against; entering a compare mode wants it rendered in the first
  // place. Either way the pump does the work (see its original branch).
  useEffect(() => {
    origToken.current++;
  }, [origEdits, image.id]);

  useEffect(() => {
    if (compareMode !== "off") void pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareMode, origEdits, image.id]);

  // Switching between split and side-by-side moves the original's canvas in the
  // DOM (overlay vs. its own pane), so the frame has to be put back on the new
  // element - and both panes re-fitted, since "pair" halves the room each gets.
  useEffect(() => {
    void paintOriginal();
    fitCanvasToStage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareMode]);

  // Zooming while edits are at rest doesn't touch the pump (no edit change), so
  // kick the settle directly whenever the new zoom leaves the painted frame
  // stretched. Keyed on `scale` rather than a zoomed/not flag, so going 2x -> 6x
  // fetches the resolution that step now needs; the settle's own delay coalesces
  // a continuous wheel-zoom into one render.
  useEffect(() => {
    if (isUpscaled()) scheduleSettle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, scheduleSettle]);

  // A pointer held down anywhere over the editor means a control is being
  // dragged (slider/curve/wheel/crop/mask handle) - render the scrub tier until
  // it's released, then snap to the accurate render + settle. Capture phase so it
  // wins regardless of which element handles the gesture.
  useEffect(() => {
    const onDown = () => {
      scrubbing.current = true;
      dragBaseToken.current = dirtyToken.current;
    };
    const onUp = () => {
      if (!scrubbing.current) return;
      scrubbing.current = false;
      // Only re-render if edits actually changed during the hold (a real drag).
      // The frames drawn during the drag were cheap scrub frames, so re-render
      // the released state accurately; the pump then schedules the full settle.
      if (dirtyToken.current !== dragBaseToken.current) {
        dirtyToken.current++;
        pumpRef.current();
      } else {
        // Nothing changed, so no render is due - but a settle may have been
        // waiting on this pointer coming up (it re-arms rather than rendering
        // mid-drag). Kick it, so a click that touched nothing can't be what
        // leaves the photo sitting on a preview tier.
        scheduleSettleRef.current();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, []);

  // Abort any in-flight render and drop the settle timer when the editor closes
  // or switches images.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      fullAbortRef.current?.abort();
      clearTimeout(settleTimer.current);
    };
  }, [image.id]);

  // The framed image changes size on geometry changes / crop mode, so drop back
  // to fit then to keep zoom/pan sane.
  useEffect(() => {
    resetZoom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, rotation, crop, cropMode]);

  // Scroll / pinch to zoom toward the cursor (native non-passive listener so we
  // can preventDefault - mirrors the lightbox).
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      setScale((prev) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev * factor));
        setPan((pp) =>
          next <= 1.001
            ? { x: 0, y: 0 }
            : clampPan({ x: dx - (dx - pp.x) * (next / prev), y: dy - (dy - pp.y) * (next / prev) }, next)
        );
        return next;
      });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function applyPreset(p: EditPreset) {
    // Normalise so presets saved under an older/looser shape still land on a
    // complete, in-range Adjustments object. Geometry is untouched by presets.
    setAdj(normalizeAdjustments(p.adjustments));
  }

  function confirmSavePreset() {
    const name = presetName.trim();
    if (!name) return;
    savePreset(name, { adjustments: adj });
    setPresets(loadPresets());
    setSelectedPreset(name);
    setNamingPreset(false);
    setPresetName("");
  }

  async function handleDeletePreset() {
    if (!selectedPreset || !presets[selectedPreset]) return;
    if (
      !(await dialogs.confirm({
        title: `Delete preset “${selectedPreset}”?`,
        message: "The preset is removed from this machine. Photos it was applied to keep their edits.",
        confirmLabel: "Delete preset",
        danger: true,
      }))
    )
      return;
    deletePreset(selectedPreset);
    setPresets(loadPresets());
    setSelectedPreset("");
  }

  const saveEdits = useMutation({
    mutationFn: () => withWait("Saving edits…", () => api.images.saveEdits(image.id, edits)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["image", image.id] });
      queryClient.invalidateQueries({ queryKey: ["images"] });
      onClose();
    },
  });

  // No withWait here: the Save-copy dialog itself blocks the editor and shows
  // the busy state while the full-resolution render runs.
  const saveCopy = useMutation({
    mutationFn: (opts: { quality: number; maxSize: number | null }) =>
      api.images.saveCopy(image.id, edits, opts),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      onClose();
      // Jump to the freshly created edited photo rather than staying on the
      // original - and make its back arrow lead to the Library, not back
      // through the editing history.
      navigate(`/image/${created.id}`, { state: { backTo: "/" } });
    },
  });

  // Auto develop: ask the backend for settings learned from the user's own
  // saved edits (CLIP k-NN over visually similar edited photos) and load them
  // into the sliders. Purely a suggestion - nothing is stored until Save, and
  // any masks the user drew are kept (masks are spatial and never suggested).
  const autoDevelopSettings = useQuery({
    queryKey: ["auto-develop-settings"],
    queryFn: () => api.settings.getAutoDevelop(),
  });
  const autoAdjust = useMutation({
    mutationFn: () => withWait("Auto-developing…", () => api.images.autoAdjust(image.id)),
    onSuccess: (res) => {
      // The response is *partial* - only the groups enabled in Settings.
      // Spreading it over the current state leaves every unchecked group's
      // sliders exactly where the user has them.
      setAdj((a) => ({
        ...normalizeAdjustments({ ...a, ...(res.adjustments as Partial<Adjustments>) }),
        masks: a.masks,
      }));
    },
  });

  // Auto-dismiss the auto-develop error banner a few seconds after it appears.
  useEffect(() => {
    if (!autoAdjust.isError) return;
    const t = setTimeout(() => autoAdjust.reset(), 5000);
    return () => clearTimeout(t);
  }, [autoAdjust.isError, autoAdjust.reset]);

  // Same for a failed save/copy - the footer error clears itself.
  useEffect(() => {
    if (!saveEdits.isError && !saveCopy.isError) return;
    const t = setTimeout(() => {
      saveEdits.reset();
      saveCopy.reset();
    }, 5000);
    return () => clearTimeout(t);
  }, [saveEdits.isError, saveCopy.isError]);

  function autoErrorText(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("No edited photos")) return "No edited photos to learn from yet – save an edit or a copy first.";
    if (msg.includes("Embedding not ready")) return "This photo's analysis isn't ready yet – try again in a moment.";
    if (msg.includes("affect no settings")) return "Auto develop is set to affect no settings – enable at least one group in Settings.";
    return "Auto develop failed.";
  }

  const busy = saveEdits.isPending || saveCopy.isPending;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Peel back the active on-canvas mode first, then close the editor.
        if (colorPickMode) setColorPickMode(false);
        else if (curvePickMode) {
          setCurvePickMode(false);
          setCurveMarker(null);
        } else if (maskDrawMode) setMaskDrawMode(false);
        // The crop box belongs to the open Transform group, so putting it away
        // means closing that group - dropping crop mode alone would leave the
        // panel showing crop controls with no box on the photo.
        else if (cropMode) setOpenGroup("");
        else if (saveCopyOpen) {
          if (!saveCopy.isPending) setSaveCopyOpen(false);
        } else if (!busy) onClose();
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;

      // Up/down from outside any control jumps into the visible slider list
      // (a focused slider handles these itself and walks the list; text
      // fields/selects keep their native arrow behaviour).
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (focusAdjacentSlider(null, e.key === "ArrowDown" ? 1 : -1)) e.preventDefault();
        return;
      }

      // 1..9 open the matching control section (same order as the panel).
      // Skipped while a text-entry control has focus so typing a preset name
      // or a slider value never switches sections.
      const idx = SECTION_KEY_ORDER.indexOf(e.key);
      if (idx === -1) return;
      if (tag === "TEXTAREA" || tag === "SELECT") return;
      if (tag === "INPUT" && !["range", "checkbox"].includes((target as HTMLInputElement).type)) return;
      const groupId = GROUP_ORDER[idx];
      setOpenGroup(groupId);
      // Scroll after the body has rendered so the opened section is in view.
      requestAnimationFrame(() => {
        document
          .querySelector(`.editor-accordion-header[data-group="${groupId}"]`)
          ?.scrollIntoView({ block: "start", behavior: "smooth" });
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy, cropMode, maskDrawMode, colorPickMode, curvePickMode, saveCopyOpen, saveCopy.isPending]);

  function fractionAt(clientX: number, clientY: number) {
    const box = canvasRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max((clientX - box.left) / box.width, 0), 1),
      y: Math.min(Math.max((clientY - box.top) / box.height, 0), 1),
    };
  }

  // Displayed image aspect (width/height). Needed wherever an x-fraction has to
  // be compared with a y-fraction - they are fractions of different edges, so
  // mixing them without this is not a distance (see the brush step).
  function canvasAspect(): number {
    const cv = canvasRef.current;
    return cv && cv.height ? cv.width / cv.height : 1;
  }

  // Current aspect lock as a fraction-space ratio (fw/fh), or null when free.
  // In crop mode the canvas holds the full framed image, so its pixels give the
  // image aspect A; a target ratio R becomes k = R / A in fraction space.
  function aspectK(): number | null {
    const ratio = ASPECT_OPTIONS.find((o) => o.value === aspectKey)?.ratio ?? null;
    if (ratio == null) return null;
    const cv = canvasRef.current;
    if (!cv || !cv.width || !cv.height) return null;
    const A = cv.width / cv.height;
    const R = ratio === "orig" ? A : ratio;
    return R / A;
  }

  // Commit the drawn crop (or clear it). The box stays on the photo - the crop
  // tool is open for as long as the Transform group is, and the committed box
  // is what it shows. Mask coordinates are
  // fractions of the *cropped* frame, so they're re-expressed for the new frame
  // in the same step - otherwise cropping slides every mask across the picture,
  // off whatever it was drawn on. Semantic masks keep their found region and
  // their now-stale geometry signature, which is what raises the panel's
  // "recompute it" hint.
  function applyCrop(next: CropBox | null) {
    setAdj((a) => {
      const masks = remapMasksForCrop(a.masks, crop, next, frameBase());
      return masks === a.masks ? a : { ...a, masks };
    });
    setCrop(next);
  }

  // Picking a preset drops a centred crop of that ratio; picking Freeform just
  // releases the lock and keeps whatever box is drawn.
  function pickAspect(key: string) {
    setAspectKey(key);
    const ratio = ASPECT_OPTIONS.find((o) => o.value === key)?.ratio ?? null;
    if (ratio == null) return;
    const cv = canvasRef.current;
    if (!cv || !cv.width || !cv.height) return;
    const A = cv.width / cv.height;
    const R = ratio === "orig" ? A : ratio;
    setDrag(centeredDragForK(R / A));
  }

  // Which part of the crop a point hits: a corner/edge handle, "move" (inside)
  // or "new" (draw a fresh box). tol is the handle grab distance in fractions.
  function cropHitTest(
    p: { x: number; y: number },
    box: CropBox,
    tolX: number,
    tolY: number
  ): string {
    const l = box.x;
    const r = box.x + box.width;
    const t = box.y;
    const b = box.y + box.height;
    const nearL = Math.abs(p.x - l) <= tolX;
    const nearR = Math.abs(p.x - r) <= tolX;
    const nearT = Math.abs(p.y - t) <= tolY;
    const nearB = Math.abs(p.y - b) <= tolY;
    const inX = p.x >= l - tolX && p.x <= r + tolX;
    const inY = p.y >= t - tolY && p.y <= b + tolY;
    if (nearL && nearT) return "nw";
    if (nearR && nearT) return "ne";
    if (nearL && nearB) return "sw";
    if (nearR && nearB) return "se";
    // Edge handles only make sense without an aspect lock (a 1D drag can't keep
    // a ratio); a locked crop resizes from its corners.
    if (aspectK() == null) {
      if (nearL && inY) return "w";
      if (nearR && inY) return "e";
      if (nearT && inX) return "n";
      if (nearB && inX) return "s";
    }
    if (p.x > l && p.x < r && p.y > t && p.y < b) return "move";
    return "new";
  }

  // Resize an existing box by dragging handle `mode` to point p. With an aspect
  // lock, corners rebuild the box from the opposite (fixed) corner via the same
  // ratio constraint used for drawing.
  function resizeCrop(mode: string, orig: CropBox, p: { x: number; y: number }, k: number | null): DragRect {
    const clampU = (v: number) => Math.min(1, Math.max(0, v));
    if (k != null && mode.length === 2) {
      const ax = mode.includes("e") ? orig.x : orig.x + orig.width;
      const ay = mode.includes("s") ? orig.y : orig.y + orig.height;
      return constrainDragToK({ x0: ax, y0: ay, x1: clampU(p.x), y1: clampU(p.y) }, k);
    }
    let l = orig.x;
    let r = orig.x + orig.width;
    let t = orig.y;
    let b = orig.y + orig.height;
    if (mode.includes("w")) l = clampU(p.x);
    if (mode.includes("e")) r = clampU(p.x);
    if (mode.includes("n")) t = clampU(p.y);
    if (mode.includes("s")) b = clampU(p.y);
    return { x0: l, y0: t, x1: r, y1: b };
  }

  function cropCursorFor(mode: string): string {
    switch (mode) {
      case "move":
        return "move";
      case "nw":
      case "se":
        return "nwse-resize";
      case "ne":
      case "sw":
        return "nesw-resize";
      case "n":
      case "s":
        return "ns-resize";
      case "e":
      case "w":
        return "ew-resize";
      default:
        return "crosshair";
    }
  }

  function setBandChannel(ch: number, v: number) {
    setAdj((a) => {
      const hsl = { ...a.hsl, [band]: [...a.hsl[band]] as [number, number, number] };
      hsl[band][ch] = v;
      return { ...a, hsl };
    });
  }

  // ---- Nested writers for the Phase-2 groups. All immutable, so the preview
  // (which re-renders on any adj change) picks each edit up live.
  function setPointCurve(ch: CurveChannel, pts: CurvePoint[]) {
    setAdj((a) => {
      const point_curves: PointCurves = { ...a.point_curves, [ch]: pts };
      return { ...a, point_curves };
    });
  }
  function setParamCurve(ch: CurveChannel, patch: Partial<ParamCurveChannel>) {
    setAdj((a) => {
      const parametric_curve: ParametricCurve = {
        ...a.parametric_curve,
        [ch]: { ...a.parametric_curve[ch], ...patch },
      };
      return { ...a, parametric_curve };
    });
  }
  function resetCurve() {
    if (adj.curve_mode === "point") {
      setPointCurve(curveChannel, [
        [0, 0],
        [255, 255],
      ]);
    } else {
      setParamCurve(curveChannel, { highlights: 0, lights: 0, darks: 0, shadows: 0, white_level: 0, black_level: 0 });
    }
  }
  function setGrade(range: GradeRange, patch: Partial<GradeWheel>) {
    setAdj((a) => {
      const color_grading: ColorGrading = {
        ...a.color_grading,
        [range]: { ...a.color_grading[range], ...patch },
      };
      return { ...a, color_grading };
    });
  }
  function setGradeScalar(key: "blending" | "balance", v: number) {
    setAdj((a) => {
      const color_grading: ColorGrading = { ...a.color_grading, [key]: v };
      return { ...a, color_grading };
    });
  }
  function setCalib(key: keyof ColorCalibration, v: number) {
    setAdj((a) => {
      const color_calibration: ColorCalibration = { ...a.color_calibration, [key]: v };
      return { ...a, color_calibration };
    });
  }

  // ---- Mask writers. All immutable: map over adj.masks and rebuild only the
  // changed mask (and, for sub-mask/param edits, its index-0 sub-mask) so the
  // object identity changes and the server preview re-renders live.
  function updateMask(id: string, patch: Partial<MaskDef>) {
    setAdj((a) => ({ ...a, masks: a.masks.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  }
  function updateSubMaskParams(id: string, patch: SubMaskParams) {
    setAdj((a) => ({
      ...a,
      masks: a.masks.map((m) => {
        if (m.id !== id) return m;
        const sub = m.sub_masks[0];
        if (!sub) return m;
        const nextSub: SubMask = { ...sub, parameters: { ...sub.parameters, ...patch } };
        return { ...m, sub_masks: [nextSub, ...m.sub_masks.slice(1)] };
      }),
    }));
  }
  function updateMaskAdjust(id: string, key: ScalarKey, v: number) {
    setAdj((a) => ({
      ...a,
      masks: a.masks.map((m) => (m.id === id ? { ...m, adjustments: { ...m.adjustments, [key]: v } } : m)),
    }));
  }
  // Append one brush point to the index-0 sub-mask's strokes. `flags` marks the
  // pointer-down sample and whether this is an erase stroke - the renderer needs
  // the stroke boundaries to sweep each one as a continuous segment run (and to
  // avoid drawing a line from where one stroke ended to where the next began).
  function appendStroke(id: string, x: number, y: number, size: number, flags: number) {
    appendStrokes(id, [[x, y, size, flags]]);
  }
  // Append several stroke points at once (a fast drag interpolates a run of
  // evenly-spaced points) in a single immutable update.
  function appendStrokes(id: string, pts: number[][]) {
    if (pts.length === 0) return;
    setAdj((a) => ({
      ...a,
      masks: a.masks.map((m) => {
        if (m.id !== id) return m;
        const sub = m.sub_masks[0];
        if (!sub || sub.type !== "brush") return m;
        const strokes = Array.isArray(sub.parameters.strokes) ? (sub.parameters.strokes as number[][]) : [];
        const nextSub: SubMask = { ...sub, parameters: { ...sub.parameters, strokes: [...strokes, ...pts] } };
        return { ...m, sub_masks: [nextSub, ...m.sub_masks.slice(1)] };
      }),
    }));
  }

  // Read a numeric sub-mask parameter (parameters hold number | number[][]).
  function subNum(sub: SubMask, key: string, def: number): number {
    const v = sub.parameters[key];
    return typeof v === "number" ? v : def;
  }
  const isSpatial = (t: SubMaskType | undefined) => t === "radial" || t === "linear" || t === "brush";
  // A sub-mask parameter that holds text (the semantic mask's subject / stored
  // region / geometry signature) rather than a number.
  function subStr(sub: SubMask, key: string): string {
    const v = sub.parameters[key];
    return typeof v === "string" ? v : "";
  }
  const subjectLabel = (s: string) => MASK_SUBJECTS.find((x) => x.value === s)?.label ?? "Subject";

  // Signature of everything that changes the framed image's geometry. A
  // semantic mask is found in that frame, so if this changes afterwards the
  // stored region no longer lines up and has to be found again.
  function geomSignature(): string {
    return [rotation, flipH ? 1 : 0, flipV ? 1 : 0, straighten, perspH, perspV, distortion,
      crop ? `${crop.x},${crop.y},${crop.width},${crop.height}` : ""].join("|");
  }

  // Ask the server to find a subject and turn the answer into a mask. The
  // region is stored in the sub-mask, so the model runs once here and never
  // again in the render path.
  async function runSegment(subject: string, maskId: string, subId: string) {
    setSegmenting(subject);
    setSegmentError(null);
    try {
      const res = await api.images.segment(image.id, previewEdits, subject);
      if (!res.found) {
        setSegmentError(`No ${subjectLabel(subject).toLowerCase()} found in this photo.`);
        return false;
      }
      setAdj((a) => ({
        ...a,
        masks: a.masks.map((m) =>
          m.id !== maskId
            ? m
            : {
                ...m,
                sub_masks: m.sub_masks.map((s) =>
                  s.id !== subId ? s : { ...s, parameters: { ...s.parameters, mask: res.mask, geom: geomSignature() } }
                ),
              }
        ),
      }));
      // A freshly found region is worth seeing before anything is done to it -
      // the pointer is on its row's button, so the hover marking already shows it.
      return true;
    } catch {
      setSegmentError("Subject detection isn't available – the model may still be downloading.");
      return false;
    } finally {
      setSegmenting(null);
    }
  }

  // "Sky", "Water", ... : a mask whose region the server finds. Added first and
  // filled in when the answer arrives, so the panel shows what's happening; if
  // nothing is found the empty mask is taken back out again.
  async function addSemanticMask(subject: string) {
    const mask = newMask("semantic");
    mask.name = subjectLabel(subject);
    mask.sub_masks[0].parameters = { ...mask.sub_masks[0].parameters, subject };
    setAdj((a) => ({ ...a, masks: [...a.masks, mask] }));
    setSelectedMaskId(mask.id);
    setMaskDrawMode(false);
    setColorPickMode(false);
    setOpenGroup("masks");
    const ok = await runSegment(subject, mask.id, mask.sub_masks[0].id);
    if (!ok) deleteMask(mask.id);
  }

  function addMask(type: SubMaskType) {
    const mask = newMask(type);
    setAdj((a) => ({ ...a, masks: [...a.masks, mask] }));
    setSelectedMaskId(mask.id);
    setColorPickMode(false);
    setOpenGroup("masks");
    if (isSpatial(type)) {
      // Radial/linear/brush are drawn on the image - drop into draw mode (and
      // out of crop mode, which shares the canvas pointer).
      setCropMode(false);
      setMaskDrawMode(true);
    } else {
      setMaskDrawMode(false);
    }
  }
  function deleteMask(id: string) {
    setAdj((a) => ({ ...a, masks: a.masks.filter((m) => m.id !== id) }));
    if (selectedMaskId === id) {
      setSelectedMaskId(null);
      setMaskDrawMode(false);
      setColorPickMode(false);
    }
  }
  // Selecting a mask ends any active draw/pick so the pointer doesn't keep
  // editing the previously-selected mask; re-enter per the new mask's type.
  function selectMask(id: string) {
    setSelectedMaskId(id);
    setMaskDrawMode(false);
    setColorPickMode(false);
    setOpenGroup("masks");
  }
  function toggleMaskDraw() {
    setMaskDrawMode((on) => {
      const next = !on;
      if (next) {
        setCropMode(false);
        setColorPickMode(false);
      }
      return next;
    });
  }
  function toggleColorPick() {
    setColorPickMode((on) => {
      const next = !on;
      if (next) {
        setCropMode(false);
        setMaskDrawMode(false);
      }
      return next;
    });
  }

  // Eyedropper: read the rendered pixel under the pointer off the canvas and set
  // the selected colour mask's target_r/g/b (channels 0..1). Same-origin JPEG so
  // getImageData isn't tainted (the histogram reads the canvas the same way).
  function pickColorAt(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    const mask = adj.masks.find((m) => m.id === selectedMaskId);
    const sub = mask?.sub_masks[0];
    if (!canvas || !mask || !sub || sub.type !== "color") return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const f = fractionAt(clientX, clientY);
    const px = Math.min(canvas.width - 1, Math.max(0, Math.floor(f.x * canvas.width)));
    const py = Math.min(canvas.height - 1, Math.max(0, Math.floor(f.y * canvas.height)));
    const d = ctx.getImageData(px, py, 1, 1).data;
    updateSubMaskParams(mask.id, { target_r: d[0] / 255, target_g: d[1] / 255, target_b: d[2] / 255 });
  }

  // ---- Targeted-adjustment picker (curves) ---------------------------------
  // Lightroom's TAT: arm it, then drag on the photo. The tone under the pointer
  // decides *where* on the curve you're working, and the vertical drag decides
  // by how much - so you shape the curve by pointing at the thing you want
  // brighter, not by guessing which part of the x axis it sits on.

  // Downscaled snapshot of the current preview, rebuilt on demand. ~256k px is
  // far more than tone picking needs and keeps the copy cheap.
  function pickSnapshot() {
    if (pickSnapRef.current) return pickSnapRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width || !canvas.height) return null;
    const scale = Math.min(1, Math.sqrt(262144 / (canvas.width * canvas.height)));
    const w = Math.max(1, Math.round(canvas.width * scale));
    const h = Math.max(1, Math.round(canvas.height * scale));
    histScratch ??= document.createElement("canvas");
    histScratch.width = w;
    histScratch.height = h;
    const ctx = histScratch.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0, w, h);
    pickSnapRef.current = { data: ctx.getImageData(0, 0, w, h), w, h };
    return pickSnapRef.current;
  }

  // The active channel's value (0..255) under the pointer, averaged over a
  // small window so a single noisy pixel doesn't decide where the point lands.
  function sampleToneAt(clientX: number, clientY: number): number | null {
    const snap = pickSnapshot();
    if (!snap) return null;
    const f = fractionAt(clientX, clientY);
    const cx = Math.min(snap.w - 1, Math.floor(f.x * snap.w));
    const cy = Math.min(snap.h - 1, Math.floor(f.y * snap.h));
    const r = 2; // 5x5 window, clipped at the edges
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let y = Math.max(0, cy - r); y <= Math.min(snap.h - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(snap.w - 1, cx + r); x++) {
        const i = (y * snap.w + x) * 4;
        sr += snap.data.data[i];
        sg += snap.data.data[i + 1];
        sb += snap.data.data[i + 2];
        n++;
      }
    }
    if (!n) return null;
    const [rr, gg, bb] = [sr / n, sg / n, sb / n];
    if (curveChannel === "red") return rr;
    if (curveChannel === "green") return gg;
    if (curveChannel === "blue") return bb;
    return luma255(rr, gg, bb);
  }

  // The sampled tone is what the curve *output*; the control point belongs at
  // the matching input, so the curve gets inverted on the way in.
  function curveInputAt(clientX: number, clientY: number): number | null {
    const tone = sampleToneAt(clientX, clientY);
    if (tone == null) return null;
    return adj.curve_mode === "point"
      ? pointCurveInput(adj.point_curves[curveChannel], tone)
      : paramCurveInput(adj.parametric_curve[curveChannel], tone);
  }

  // How much output value one pixel of vertical drag is worth.
  const CURVE_PICK_SENS = 0.5;

  function curvePickDown(clientX: number, clientY: number) {
    const x = curveInputAt(clientX, clientY);
    if (x == null) return;
    if (adj.curve_mode === "point") {
      // Land on (or create) a control point at that input value, sitting exactly
      // on the current curve so arming the picker never changes the photo.
      const pts = adj.point_curves[curveChannel];
      const near = pts.findIndex((p) => Math.abs(p[0] - x) <= 4);
      if (near >= 0) {
        curvePickDrag.current = { x: pts[near][0], clientY, baseY: pts[near][1], baseParam: [] };
      } else {
        if (pts.length >= MAX_CURVE_POINTS) return;
        let insert = 0;
        while (insert < pts.length && pts[insert][0] <= x) insert++;
        insert = Math.min(Math.max(insert, 1), pts.length);
        const lo = pts[insert - 1][0] + 1;
        const hi = insert < pts.length ? pts[insert][0] - 1 : 255;
        if (lo > hi) return; // no room between the neighbouring points
        const nx = Math.min(Math.max(x, lo), hi);
        const y = Math.round(pchipSample(pts, [nx])[0]);
        setPointCurve(curveChannel, [...pts.slice(0, insert), [nx, y] as CurvePoint, ...pts.slice(insert)]);
        curvePickDrag.current = { x: nx, clientY, baseY: y, baseParam: [] };
      }
    } else {
      const p = adj.parametric_curve[curveChannel];
      curvePickDrag.current = { x, clientY, baseY: 0, baseParam: PARAM_KEYS.map((k) => p[k]) };
    }
    // The guide snaps to the point being dragged, not the raw sample, so it
    // lines up with the dot that's actually moving.
    setCurveMarker(curvePickDrag.current.x);
  }

  function curvePickMove(clientY: number) {
    const drag = curvePickDrag.current;
    if (!drag) return;
    const delta = (drag.clientY - clientY) * CURVE_PICK_SENS; // drag up = brighter
    if (adj.curve_mode === "point") {
      const pts = adj.point_curves[curveChannel];
      const i = pts.findIndex((p) => p[0] === drag.x);
      if (i < 0) return;
      const ny = Math.round(Math.min(255, Math.max(0, drag.baseY + delta)));
      if (ny === pts[i][1]) return;
      setPointCurve(curveChannel, pts.map((p, idx) => (idx === i ? ([p[0], ny] as CurvePoint) : p)));
    } else {
      // Spread the wanted shift over the four region sliders in proportion to
      // how much each one reaches this input value - the minimum-norm solution
      // of "make the parametric curve move by `delta` at x", so the regions that
      // own this tone move most and the rest of the curve stays put.
      const u = drag.x / 255;
      const w = [0, 1, 2, 3].map((i) => PARAM_BASES[i](u));
      const norm = w.reduce((s, v) => s + v * v, 0);
      if (norm < 1e-6) return;
      const patch: Partial<ParamCurveChannel> = {};
      [0, 1, 2, 3].forEach((i) => {
        const v = drag.baseParam[i] + (100 * delta * w[i]) / norm;
        patch[PARAM_KEYS[i]] = Math.round(Math.min(100, Math.max(-100, v)));
      });
      setParamCurve(curveChannel, patch);
    }
  }

  function curvePickHover(clientX: number, clientY: number) {
    const x = curveInputAt(clientX, clientY);
    setCurveMarker((prev) => (x == null || prev === x ? prev : x));
  }

  // ---- Mask hit-testing (all in 0..1 fraction space). Handle grab tolerance is
  // a screen-pixel radius converted to a per-axis fraction so it stays a fixed
  // on-screen size on non-square images.
  type Pt = { x: number; y: number };
  const radialParams = (sub: SubMask) => ({
    center_x: subNum(sub, "center_x", 0.5),
    center_y: subNum(sub, "center_y", 0.5),
    radius_x: subNum(sub, "radius_x", 0.25),
    radius_y: subNum(sub, "radius_y", 0.25),
    rotation: subNum(sub, "rotation", 0),
  });
  const linearParams = (sub: SubMask) => ({
    start_x: subNum(sub, "start_x", 0.5),
    start_y: subNum(sub, "start_y", 0.2),
    end_x: subNum(sub, "end_x", 0.5),
    end_y: subNum(sub, "end_y", 0.8),
  });
  function maskTol() {
    const rect = canvasRef.current?.getBoundingClientRect();
    const w = rect?.width || 1;
    const h = rect?.height || 1;
    return { tolX: MASK_HANDLE_PX / w, tolY: MASK_HANDLE_PX / h };
  }
  const nearHandle = (p: Pt, h: Pt, tolX: number, tolY: number) => {
    const dx = (p.x - h.x) / tolX;
    const dy = (p.y - h.y) / tolY;
    return dx * dx + dy * dy <= 1;
  };
  // Radial handle positions (centre, 4 edges, 4 corners, rotation) rotated about
  // the centre by `rotation` - matches the SVG rotate() in MaskOverlay exactly.
  function radialHandlePts(prm: ReturnType<typeof radialParams>) {
    const { center_x: cx, center_y: cy, radius_x: rx, radius_y: ry, rotation } = prm;
    const rad = (rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const R = (ox: number, oy: number): Pt => ({ x: cx + ox * cos - oy * sin, y: cy + ox * sin + oy * cos });
    return {
      move: { x: cx, y: cy } as Pt,
      e: R(rx, 0), w: R(-rx, 0), n: R(0, -ry), s: R(0, ry),
      ne: R(rx, -ry), nw: R(-rx, -ry), se: R(rx, ry), sw: R(-rx, ry),
      rotate: R(0, -(ry + MASK_ROT_OFF)),
    };
  }
  function insideRadial(p: Pt, prm: ReturnType<typeof radialParams>) {
    const { center_x: cx, center_y: cy, radius_x: rx, radius_y: ry, rotation } = prm;
    const rad = (rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = p.x - cx;
    const dy = p.y - cy;
    const lx = dx * cos + dy * sin; // project onto the rotated x-axis
    const ly = -dx * sin + dy * cos; // and the rotated y-axis
    return (lx / rx) ** 2 + (ly / ry) ** 2 <= 1;
  }
  // Which part of the mask the pointer is over: handles first, then body, then a
  // fresh draw only when clearly outside.
  function radialHitTest(p: Pt, prm: ReturnType<typeof radialParams>): string {
    const { tolX, tolY } = maskTol();
    const H = radialHandlePts(prm);
    if (nearHandle(p, H.rotate, tolX, tolY)) return "rotate";
    for (const k of ["ne", "nw", "se", "sw"] as const) if (nearHandle(p, H[k], tolX, tolY)) return k;
    for (const k of ["e", "w", "n", "s"] as const) if (nearHandle(p, H[k], tolX, tolY)) return k;
    if (nearHandle(p, H.move, tolX, tolY)) return "move";
    if (insideRadial(p, prm)) return "move";
    return "create";
  }
  // A graduated filter: the gradient runs along start->end; the iso-lines are
  // perpendicular to it through start / midpoint / end. Handles: rotation (off
  // the centre line), the two band edges (at start / end), and the centre (at
  // M). Grabbing a whole iso-line works too. Distance to an iso-line (whose
  // direction is perpendicular to the axis) is just |offset . axisUnit|.
  function linearHitTest(p: Pt, prm: ReturnType<typeof linearParams>): string {
    const { tolX, tolY } = maskTol();
    const tol = (tolX + tolY) / 2;
    const { start_x: sx, start_y: sy, end_x: ex, end_y: ey } = prm;
    const mx = (sx + ex) / 2;
    const my = (sy + ey) / 2;
    let ux = ex - sx;
    let uy = ey - sy;
    const len = Math.hypot(ux, uy) || 1;
    ux /= len;
    uy /= len;
    if (nearHandle(p, { x: sx, y: sy }, tolX, tolY)) return "start";
    if (nearHandle(p, { x: ex, y: ey }, tolX, tolY)) return "end";
    if (nearHandle(p, { x: mx, y: my }, tolX, tolY)) return "line";
    const distIso = (qx: number, qy: number) => Math.abs((p.x - qx) * ux + (p.y - qy) * uy);
    if (distIso(mx, my) <= tol) return "line";
    if (distIso(sx, sy) <= tol) return "start";
    if (distIso(ex, ey) <= tol) return "end";
    return "create";
  }
  function maskCursorFor(type: SubMaskType, mode: string): string {
    if (type === "brush") return "none"; // the brush ring stands in for the cursor
    switch (mode) {
      case "move":
      case "line":
        return "move";
      case "start":
      case "end":
      case "rotate":
        return "grab";
      case "e":
      case "w":
        return "ew-resize";
      case "n":
      case "s":
        return "ns-resize";
      case "ne":
      case "sw":
        return "nesw-resize";
      case "nw":
      case "se":
        return "nwse-resize";
      default:
        return "crosshair"; // create
    }
  }
  // Hover (no active gesture): reflect the handle/body under the pointer in the
  // cursor, and track the pointer for the brush-size ring.
  function updateMaskHover(p: Pt) {
    const sub = adj.masks.find((m) => m.id === selectedMaskId)?.sub_masks[0];
    if (!sub || !isSpatial(sub.type)) {
      setMaskCursorPos(null);
      setMaskCursor("crosshair");
      return;
    }
    if (sub.type === "brush") {
      setMaskCursorPos(p);
      setMaskCursor("none");
      return;
    }
    setMaskCursorPos(null);
    const mode = sub.type === "radial" ? radialHitTest(p, radialParams(sub)) : linearHitTest(p, linearParams(sub));
    setMaskCursor(maskCursorFor(sub.type, mode));
  }

  // Pointer-down: hit-test the existing shape and begin the matching gesture
  // (move / resize / rotate / translate / paint), or a fresh draw when outside.
  // Stroke sample flags, mirroring masks._PEN_DOWN / masks._ERASE.
  function maskPointerDown(clientX: number, clientY: number, altKey = false) {
    const mask = adj.masks.find((m) => m.id === selectedMaskId);
    const sub = mask?.sub_masks[0];
    if (!mask || !sub || !isSpatial(sub.type)) return;
    const p = fractionAt(clientX, clientY);
    if (sub.type === "radial") {
      const prm = radialParams(sub);
      const mode = radialHitTest(p, prm);
      maskGesture.current = { type: "radial", maskId: mask.id, mode, start: p, orig: prm };
      setMaskCursor(maskCursorFor("radial", mode));
      if (mode === "create") {
        updateSubMaskParams(mask.id, { center_x: p.x, center_y: p.y, radius_x: MASK_MIN_R, radius_y: MASK_MIN_R, rotation: 0 });
      }
    } else if (sub.type === "linear") {
      const prm = linearParams(sub);
      const mode = linearHitTest(p, prm);
      maskGesture.current = { type: "linear", maskId: mask.id, mode, start: p, orig: prm };
      setMaskCursor(maskCursorFor("linear", mode));
      if (mode === "create") {
        updateSubMaskParams(mask.id, { start_x: p.x, start_y: p.y, end_x: p.x, end_y: p.y });
      }
    } else {
      // Alt is the standard momentary eraser, on top of the panel's toggle.
      const erasing = brushErase !== altKey;
      maskGesture.current = { type: "brush", maskId: mask.id, mode: "paint", start: p, orig: {}, erase: erasing };
      brushLast.current = p;
      setMaskCursorPos(p);
      appendStroke(mask.id, p.x, p.y, subNum(sub, "size", 0.06), BRUSH_PEN_DOWN | (erasing ? BRUSH_ERASE : 0));
    }
  }
  function maskPointerMove(clientX: number, clientY: number) {
    const p = fractionAt(clientX, clientY);
    const g = maskGesture.current;
    if (!g) {
      updateMaskHover(p);
      return;
    }
    if (g.type === "radial") {
      const o = g.orig;
      if (g.mode === "create") {
        updateSubMaskParams(g.maskId, {
          center_x: g.start.x,
          center_y: g.start.y,
          radius_x: Math.max(MASK_MIN_R, Math.abs(p.x - g.start.x)),
          radius_y: Math.max(MASK_MIN_R, Math.abs(p.y - g.start.y)),
        });
      } else if (g.mode === "move") {
        updateSubMaskParams(g.maskId, {
          center_x: clamp01(o.center_x + (p.x - g.start.x)),
          center_y: clamp01(o.center_y + (p.y - g.start.y)),
        });
      } else if (g.mode === "rotate") {
        const deg = (Math.atan2(p.x - o.center_x, -(p.y - o.center_y)) * 180) / Math.PI;
        updateSubMaskParams(g.maskId, { rotation: Math.round(deg) });
      } else {
        // Resize from an edge/corner: project the pointer onto the ellipse's
        // (possibly rotated) axes and set the half-extent(s) - symmetric about
        // the fixed centre.
        const rad = (o.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const dx = p.x - o.center_x;
        const dy = p.y - o.center_y;
        const patch: SubMaskParams = {};
        if (g.mode.includes("e") || g.mode.includes("w")) patch.radius_x = Math.max(MASK_MIN_R, Math.abs(dx * cos + dy * sin));
        if (g.mode.includes("n") || g.mode.includes("s")) patch.radius_y = Math.max(MASK_MIN_R, Math.abs(-dx * sin + dy * cos));
        updateSubMaskParams(g.maskId, patch);
      }
    } else if (g.type === "linear") {
      const o = g.orig;
      if (g.mode === "line") {
        // Centre line / handle: translate the whole gradient, clamping the delta
        // so neither endpoint leaves [0,1].
        const clampD = (d: number, a: number, b: number) => Math.max(Math.max(-a, -b), Math.min(Math.min(1 - a, 1 - b), d));
        const ddx = clampD(p.x - g.start.x, o.start_x, o.end_x);
        const ddy = clampD(p.y - g.start.y, o.start_y, o.end_y);
        updateSubMaskParams(g.maskId, {
          start_x: o.start_x + ddx,
          start_y: o.start_y + ddy,
          end_x: o.end_x + ddx,
          end_y: o.end_y + ddy,
        });
      } else if (g.mode === "start") {
        // Band edge: drag `start` freely (end fixed). Its distance from `end` sets
        // the width (= softness) and its angle sets the gradient's rotation - so no
        // separate rotation handle is needed.
        updateSubMaskParams(g.maskId, { start_x: clamp01(p.x), start_y: clamp01(p.y) });
      } else if (g.mode === "end") {
        updateSubMaskParams(g.maskId, { end_x: clamp01(p.x), end_y: clamp01(p.y) });
      } else {
        updateSubMaskParams(g.maskId, { start_x: g.start.x, start_y: g.start.y, end_x: p.x, end_y: p.y });
      }
    } else {
      // Brush: sample evenly along the segment since the last stamp. The
      // renderer sweeps the samples as capsules, so this only has to be dense
      // enough to follow the curve of the gesture, not dense enough to hide gaps.
      const sub = adj.masks.find((m) => m.id === g.maskId)?.sub_masks[0];
      const size = sub ? subNum(sub, "size", 0.06) : 0.06;
      setMaskCursorPos(p);
      // x and y are fractions of *different* edges, so hypot() on them is not a
      // distance - on a 3:2 photo a vertical drag measured 1.5x short and sampled
      // that much coarser. Convert to fractions of the long edge (the unit `size`
      // is in) before comparing against the step.
      const a = canvasAspect();
      const xToLong = a >= 1 ? 1 : a;
      const yToLong = a >= 1 ? 1 / a : 1;
      const step = Math.max(0.002, size * 0.5);
      const last = brushLast.current ?? p;
      const dxl = (p.x - last.x) * xToLong;
      const dyl = (p.y - last.y) * yToLong;
      const dist = Math.hypot(dxl, dyl);
      if (dist >= step) {
        const n = Math.floor(dist / step);
        const flags = g.erase ? BRUSH_ERASE : 0;
        const pts: number[][] = [];
        for (let i = 1; i <= n; i++) {
          const t = (i * step) / dist;
          pts.push([last.x + (p.x - last.x) * t, last.y + (p.y - last.y) * t, size, flags]);
        }
        appendStrokes(g.maskId, pts);
        const lastPt = pts[pts.length - 1];
        brushLast.current = { x: lastPt[0], y: lastPt[1] };
      }
    }
  }
  function endMaskGesture() {
    maskGesture.current = null;
    brushLast.current = null;
  }

  // ---- Panel accordion. Groups collapse to a single open one at a time: each
  // header toggles openGroup, and each body renders only when it's the open id.
  const sectionFields = (title: string): FieldDef[] => SECTIONS.find((s) => s.title === title)?.fields ?? [];
  // A group of scalar sliders bound straight to adj[key] (Basic/Color/Details/
  // Effects control blocks - unchanged behaviour, just factored out).
  function scalarSliders(fields: FieldDef[]) {
    return (
      <div className="editor-sliders">
        {fields.map((field) => {
          // Narrow to ScalarDef: indexing SCALAR_SPEC by a union key gives a
          // union of value shapes; the union is assignable to ScalarDef.
          const spec: ScalarDef = SCALAR_SPEC[field.key];
          return (
            <Slider
              key={field.key}
              label={field.label}
              value={adj[field.key]}
              min={spec.min}
              max={spec.max}
              step={spec.step}
              resetValue={spec.def}
              uiScale={spec.uiScale}
              format={field.format}
              onChange={(v) => setAdj((a) => ({ ...a, [field.key]: v }))}
            />
          );
        })}
      </div>
    );
  }
  // A clickable group header (editor-section-title look) + a caret that rotates
  // when this group is open. Clicking an open group collapses it ("").
  function accordionHeader(id: string, title: string) {
    const open = openGroup === id;
    const toggle = () => setOpenGroup(open ? "" : id);
    return (
      <div
        className={`editor-accordion-header${open ? " open" : ""}`}
        data-group={id}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span>{title}</span>
        <span className={`editor-accordion-caret${open ? " open" : ""}`} aria-hidden>
          ›
        </span>
      </div>
    );
  }

  // Apply only lights up while the drawn box differs from the crop already
  // committed - with the controls permanently on show, that difference is what
  // says "there's a crop waiting to be taken", and pressing it a second time
  // would do nothing anyway.
  const cropPending =
    !!hasDrawnCrop &&
    (!crop ||
      Math.abs(drawn!.x - crop.x) > 1e-4 ||
      Math.abs(drawn!.y - crop.y) > 1e-4 ||
      Math.abs(drawn!.width - crop.width) > 1e-4 ||
      Math.abs(drawn!.height - crop.height) > 1e-4);
  // One stringify per actual edit change (not per render), compared against the
  // pre-computed saved-state key.
  const editsKey = useMemo(() => JSON.stringify(edits), [edits]);
  const dirty = editsKey !== savedKey;
  const allNeutral = useMemo(() => editsAreNeutral(edits), [edits]);

  // Nothing left to compare once the edits are back to neutral - both sides
  // would be the same picture, and the toggles disable themselves there, so the
  // mode has to step out on its own rather than leave the user stuck inside it.
  useEffect(() => {
    if (allNeutral) setCompareMode("off");
  }, [allNeutral]);

  // The selected mask (if any) and its index-0 sub-mask - what the panel's mask
  // editor is bound to.
  const selectedMask = selectedMaskId ? adj.masks.find((m) => m.id === selectedMaskId) ?? null : null;
  const selSub = selectedMask?.sub_masks[0] ?? null;
  // Which mask the overlay is about: the one being pointed at in the list, else
  // the one being drawn on the image. Pointing at a row is the explicit request,
  // so it wins.
  const hoveredMask = hoveredMaskId ? adj.masks.find((m) => m.id === hoveredMaskId) ?? null : null;
  const overlayMask = hoveredMask ?? (maskDrawMode ? selectedMask : null);
  const overlaySub = overlayMask?.sub_masks[0] ?? null;
  // Sub-masks that draw something over the image: the editable shapes, plus a
  // semantic mask, which shows the region it found rather than a shape.
  const overlaySpatialSub = overlaySub && (isSpatial(overlaySub.type) || overlaySub.type === "semantic") ? overlaySub : null;
  // Two separate things over the photo. The zebra MARKING - what does this mask
  // cover? - is asked for by pointing at the mask in the list, and goes the
  // moment you point elsewhere, because it covers the very change you're trying
  // to judge. The outline and HANDLES are the editing tools and stay for as long
  // as the mask is being drawn. The one overlap: a brush's painted area is its
  // only outline, so painting keeps it marked - there'd be nothing to see.
  const overlayIsHovered = hoveredMask != null;
  const overlayIsSelected = overlayMask != null && overlayMask.id === selectedMaskId;
  const overlayMark =
    overlayIsHovered || (maskDrawMode && overlayIsSelected && overlaySpatialSub?.type === "brush");
  const maskLabel = (m: MaskDef) => MASK_TYPES.find((t) => t.value === m.sub_masks[0]?.type)?.label ?? "Mask";

  return (
    <div className="editor-overlay">
      <div className="editor-body">
        {/* Back button in its own slim column left of the stage, top aligned -
            same placement as the detail lightbox's back arrow. */}
        <button
          className="icon-btn editor-back-btn"
          onClick={onClose}
          disabled={busy}
          title={busy ? "Saving…" : "Back (Esc)"}
          aria-label="Back"
        >
          <IconArrowLeft size={16} />
        </button>
        <div className={`editor-stage editor-stage-${bgMode}`} ref={stageRef}>
        <div className={`editor-stage-main${pair ? " editor-stage-main--pair" : ""}`} ref={stageMainRef}>
        {loading && <div className="editor-hint">Loading…</div>}
        {error && <div className="editor-hint">{error}</div>}
        {/* Side by side: the original gets a pane of its own, left of the edited
            one. The stage is already a centred flex row, so the two just sit
            next to each other; fitCanvasToStage gives each half the room. Panes
            clip their own contents so a zoomed photo can't spill into its
            neighbour - both carry the same transform, so they zoom together. */}
        {pair && !loading && !error && (
          <div className="editor-pane">
            <canvas
              ref={origCanvasRef}
              className="editor-pane-canvas"
              aria-hidden
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
            />
            <span className="split-tag split-tag-left">Original</span>
          </div>
        )}
        <div
          className={`editor-canvas-wrap${pair ? " editor-canvas-wrap--pane" : ""}`}
          ref={wrapRef}
          style={{ display: loading || error ? "none" : "inline-block" }}
        >
          <canvas
            ref={canvasRef}
            className="editor-canvas"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              cursor: colorPickMode || curvePickMode
                ? "crosshair"
                : maskDrawMode
                  ? maskCursor
                  : cropMode
                    ? cropCursor
                    : zoomed
                      ? panDragRef.current
                        ? "grabbing"
                        : "grab"
                      : "default",
            }}
            onMouseDown={(e) => {
              // Mask-draw / eyedropper take over the canvas pointer, ahead of
              // crop and zoom-pan, and consume the event.
              if (colorPickMode) {
                pickColorAt(e.clientX, e.clientY);
                setColorPickMode(false);
                return;
              }
              // The curve picker stays armed across drags - shaping a curve
              // takes several pulls at different tones.
              if (curvePickMode) {
                curvePickDown(e.clientX, e.clientY);
                return;
              }
              if (maskDrawMode) {
                maskPointerDown(e.clientX, e.clientY, e.altKey);
                return;
              }
              if (cropMode) {
                const p = fractionAt(e.clientX, e.clientY);
                const rect = canvasRef.current!.getBoundingClientRect();
                const tolX = 14 / rect.width;
                const tolY = 14 / rect.height;
                const mode = drawn ? cropHitTest(p, drawn, tolX, tolY) : "new";
                if (mode === "new" || !drawn) {
                  setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
                  cropAction.current = { mode: "new", start: p, orig: { x: p.x, y: p.y, width: 0, height: 0 } };
                } else {
                  cropAction.current = { mode, start: p, orig: drawn };
                }
                setDragging(true);
              } else if (zoomed) {
                e.preventDefault();
                panDragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
              }
            }}
            onMouseMove={(e) => {
              if (curvePickMode) {
                // Dragging shapes the curve; a plain hover just reports which
                // input value the tone under the pointer maps to.
                if (curvePickDrag.current) curvePickMove(e.clientY);
                else curvePickHover(e.clientX, e.clientY);
                return;
              }
              if (maskDrawMode) {
                maskPointerMove(e.clientX, e.clientY);
                return;
              }
              if (cropMode) {
                const p = fractionAt(e.clientX, e.clientY);
                const act = cropAction.current;
                if (dragging && act) {
                  if (act.mode === "new") {
                    let next: DragRect = { x0: act.start.x, y0: act.start.y, x1: p.x, y1: p.y };
                    const k = aspectK();
                    if (k != null) next = constrainDragToK(next, k);
                    setDrag(next);
                  } else if (act.mode === "move") {
                    const nx = Math.min(1 - act.orig.width, Math.max(0, act.orig.x + (p.x - act.start.x)));
                    const ny = Math.min(1 - act.orig.height, Math.max(0, act.orig.y + (p.y - act.start.y)));
                    setDrag({ x0: nx, y0: ny, x1: nx + act.orig.width, y1: ny + act.orig.height });
                  } else {
                    setDrag(resizeCrop(act.mode, act.orig, p, aspectK()));
                  }
                } else if (drawn) {
                  // Hover feedback: cursor reflects the handle under the pointer.
                  const rect = canvasRef.current!.getBoundingClientRect();
                  setCropCursor(cropCursorFor(cropHitTest(p, drawn, 14 / rect.width, 14 / rect.height)));
                }
              } else if (panDragRef.current) {
                setPan(clampPan({ x: e.clientX - panDragRef.current.x, y: e.clientY - panDragRef.current.y }, scale));
              }
            }}
            onMouseUp={() => {
              setDragging(false);
              cropAction.current = null;
              panDragRef.current = null;
              curvePickDrag.current = null;
              endMaskGesture();
            }}
            onMouseLeave={() => {
              setDragging(false);
              cropAction.current = null;
              panDragRef.current = null;
              curvePickDrag.current = null;
              endMaskGesture();
              setMaskCursorPos(null);
              setCurveMarker(null);
            }}
            onDoubleClick={(e) => {
              if (cropMode) return;
              // Lightroom-style: double-click toggles fit <-> 100% at the cursor.
              const wrap = wrapRef.current!;
              const rect = wrap.getBoundingClientRect();
              const dx = e.clientX - (rect.left + rect.width / 2);
              const dy = e.clientY - (rect.top + rect.height / 2);
              if (zoomed) {
                resetZoom();
              } else {
                const cv = canvasRef.current!;
                const target = Math.min(MAX_ZOOM, Math.max(2, cv.width / rect.width));
                setScale(target);
                setPan(clampPan({ x: dx - dx * target, y: dy - dy * target }, target));
              }
            }}
          />
          {/* Split view: the original, drawn over the left of the edited canvas
              up to the divider. It carries the canvas transform so the two
              halves stay registered under zoom/pan, and the clip is applied
              before that transform, so the line splits the *photo*. */}
          {split && (
            <canvas
              ref={origCanvasRef}
              className="editor-split-canvas"
              aria-hidden
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                clipPath: `inset(0 ${(1 - splitPos) * 100}% 0 0)`,
              }}
            />
          )}
          {split && (
            // Deliberately NOT under the canvas transform: a scaled divider
            // would be a 12px bar with a huge grip at 6x zoom. Its position is
            // the split fraction pushed through the same transform by hand
            // (the canvas scales about the wrap's centre, then pans), so the
            // line stays exactly on the clip edge at any zoom while keeping a
            // constant on-screen weight.
            <div
              className="split-divider"
              style={{ left: `calc(${50 + (splitPos - 0.5) * scale * 100}% + ${pan.x}px)` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                splitDragRef.current = true;
              }}
              onPointerMove={(e) => {
                if (splitDragRef.current) setSplitPos(clamp01(fractionAt(e.clientX, e.clientY).x));
              }}
              onPointerUp={(e) => {
                splitDragRef.current = false;
                if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
              }}
            >
              <span className="split-divider-grip" aria-hidden />
            </div>
          )}
          {compareMode !== "off" && (
            <>
              {/* In "pair" the original has its own pane and its own label, so
                  this side is only ever the edit. */}
              {split && <span className="split-tag split-tag-left">Original</span>}
              <span className="split-tag split-tag-right">Edited</span>
            </>
          )}
          {cropMode && hasDrawnCrop && (
            <div
              className="crop-rect"
              style={{
                left: `${drawn!.x * 100}%`,
                top: `${drawn!.y * 100}%`,
                width: `${drawn!.width * 100}%`,
                height: `${drawn!.height * 100}%`,
              }}
            >
              {/* The composition grid lives INSIDE the crop box while cropping -
                  it guides the frame being composed, not the discarded area. */}
              <GridLines type={gridOverlay} />
              {/* Visual handles only - hit-testing happens on the canvas so the
                  handles stay pointer-transparent and the drag never breaks. */}
              <span className="crop-handle nw" />
              <span className="crop-handle ne" />
              <span className="crop-handle sw" />
              <span className="crop-handle se" />
              {aspectK() == null && (
                <>
                  <span className="crop-handle n" />
                  <span className="crop-handle s" />
                  <span className="crop-handle e" />
                  <span className="crop-handle w" />
                </>
              )}
            </div>
          )}
          {/* While a crop is being drawn the grid renders inside the crop box
              instead (see above) - never both at once. */}
          {!zoomed && !(cropMode && hasDrawnCrop) && <GridLines type={gridOverlay} />}
          {/* Selected-mask guide + editable handles, transformed to track the
              canvas under zoom/pan. aspect keeps the round handles round on
              non-square images; cursor draws the brush-size ring. */}
          {overlaySpatialSub && openGroup === "masks" && (
            <MaskOverlay
              sub={overlaySpatialSub}
              mark={overlayMark}
              handles={maskDrawMode && overlayIsSelected}
              aspect={canvasRef.current && canvasRef.current.height ? canvasRef.current.width / canvasRef.current.height : 1}
              cursor={
                overlaySpatialSub.type === "brush" && maskDrawMode && overlayIsSelected && maskCursorPos
                  ? { x: maskCursorPos.x, y: maskCursorPos.y, size: subNum(overlaySpatialSub, "size", 0.06) }
                  : null
              }
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transformOrigin: "center center" }}
            />
          )}
        </div>
        </div>
        {!loading && !error && (
          <div className="editor-bg-toggle">
            <span className="segmented">
              <button className={bgMode === "light" ? "active" : ""} onClick={() => setBgMode("light")}>
                Light background
              </button>
              <button className={bgMode === "dark" ? "active" : ""} onClick={() => setBgMode("dark")}>
                Black background
              </button>
            </span>
            <button
              className={`btn btn-sm editor-compare-btn${compare ? " active" : ""}`}
              onMouseDown={() => setCompare(true)}
              onMouseUp={() => setCompare(false)}
              onMouseLeave={() => setCompare(false)}
              // A compare mode already shows the original; swapping the whole
              // canvas under it would only make both sides the same picture.
              disabled={allNeutral || compareMode !== "off"}
              title="Hold to compare with the original"
            >
              {compare ? "Showing original" : "Compare"}
            </button>
            {/* The two ways to keep the original on screen. Each button toggles
                its own mode, so clicking the lit one goes back to just the edit. */}
            <span className="segmented editor-compare-modes">
              <button
                className={split ? "active" : ""}
                aria-pressed={split}
                aria-label="Compare split by a draggable line"
                disabled={allNeutral}
                onClick={() => setCompareMode((m) => (m === "split" ? "off" : "split"))}
                title="Split: original and edit on the same picture, divided by a line you can drag"
              >
                <IconSplit size={14} />
              </button>
              <button
                className={pair ? "active" : ""}
                aria-pressed={pair}
                aria-label="Compare side by side"
                disabled={allNeutral}
                onClick={() => setCompareMode((m) => (m === "pair" ? "off" : "pair"))}
                title="Side by side: original and edit as two pictures, nothing hidden"
              >
                <IconSideBySide size={14} />
              </button>
            </span>
          </div>
        )}
      </div>

      <div className="editor-panel">
        <div className="editor-panel-body">
        <h3 className="section-title" style={{ marginBottom: 2 }}>
          Edit
        </h3>
        <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 4px" }}>
          Non-destructive. Save updates this photo; Save copy makes a new edited photo.
        </p>

        {/* Transform: rotate/flip, the crop box and its ratio, straighten +
            tilt. Opening the group arms the crop box on the photo (see the
            openGroup effect), so everything here is live at once: the two
            labelled selects, then the quarter-turn tools, then the sliders. */}
        {accordionHeader("transform", "Transform")}
        {openGroup === "transform" && (
          <div className="editor-accordion-body">
            {/* The two labelled selects sit together at the top - one column,
                one left edge - and the button rows follow underneath. The grid
                is what you frame *against*, so it leads. */}
            <div className="editor-field-row">
              <span className="editor-field-label">Grid</span>
              <Dropdown
                className="editor-grid-select"
                value={gridOverlay}
                onChange={(v) => setGridOverlay(v as GridOverlay)}
                title="Overlay grid"
                ariaLabel="Overlay grid"
                options={GRID_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              />
            </div>

            {/* Crop: the ratio it locks to, then take it or drop it - all on one
                row, so the whole thing is a single line in the panel instead of
                a select with a bar of buttons parked under it. A tick and a
                cross sitting on the select need no separator to say they belong
                to it. Taking a crop re-frames the picture, and masks are stored
                as fractions of that frame, so they're carried across to the new
                one or a crop would slide every mask off what it was drawn on. */}
            <div className="editor-field-row">
              <span className="editor-field-label">Crop</span>
              <Dropdown
                className="editor-grid-select"
                value={aspectKey}
                onChange={pickAspect}
                title="Crop aspect ratio"
                ariaLabel="Crop aspect ratio"
                options={ASPECT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              />
              <button
                className="btn btn-sm editor-field-btn editor-field-btn--confirm"
                disabled={!cropPending}
                onClick={() => applyCrop(normalizeRect(drag!))}
                title="Apply this crop"
                aria-label="Apply this crop"
              >
                <IconCheck size={14} />
              </button>
              <button
                className="btn btn-sm editor-field-btn"
                disabled={!crop && !drawn}
                onClick={() => {
                  applyCrop(null);
                  setDrag(null);
                  setAspectKey("free");
                }}
                title="Clear the crop"
                aria-label="Clear the crop"
              >
                <IconX size={13} />
              </button>
            </div>

            {/* Rotate / flip: four equal buttons, one row. */}
            <div className="editor-tool-row">
              <button
                className="btn btn-sm"
                onClick={() => setRotation((r) => (r + 270) % 360)}
                disabled={busy}
                title="Rotate left 90°"
                aria-label="Rotate left 90°"
              >
                <IconRotate size={14} className="flip-h" />
              </button>
              <button
                className="btn btn-sm"
                onClick={() => setRotation((r) => (r + 90) % 360)}
                disabled={busy}
                title="Rotate right 90°"
                aria-label="Rotate right 90°"
              >
                <IconRotate size={14} />
              </button>
              <button
                className={`btn btn-sm${flipH ? " primary" : ""}`}
                onClick={() => setFlipH((v) => !v)}
                disabled={busy}
                title="Flip horizontal"
                aria-label="Flip horizontal"
                aria-pressed={flipH}
              >
                <IconFlipH size={14} />
              </button>
              <button
                className={`btn btn-sm${flipV ? " primary" : ""}`}
                onClick={() => setFlipV((v) => !v)}
                disabled={busy}
                title="Flip vertical"
                aria-label="Flip vertical"
                aria-pressed={flipV}
              >
                <IconFlipV size={14} />
              </button>
            </div>

            {/* Straighten (rotation) + perspective / axis tilt. All auto-fill the
                frame, so nothing shows empty corners. */}
            <div className="editor-sliders">
              <Slider
                label="Straighten"
                value={straighten}
                onChange={setStraighten}
                min={-45}
                max={45}
                step={0.25}
                format={(v) => `${v > 0 ? "+" : ""}${v}°`}
              />
              <Slider label="Tilt horizontal" value={perspH} onChange={setPerspH} />
              <Slider label="Tilt vertical" value={perspV} onChange={setPerspV} />
              <Slider label="Distortion" value={distortion} onChange={setDistortion} />
              {/* White frame: a matte border added around the photo, drawn last.
                  Bound to the develop object (not geometry), so it round-trips
                  through Save and Save copy like every other adjustment. */}
              <Slider
                label="White frame"
                value={adj.frame_width}
                onChange={(v) => setAdj((a) => ({ ...a, frame_width: v }))}
                min={SCALAR_SPEC.frame_width.min}
                max={SCALAR_SPEC.frame_width.max}
                resetValue={SCALAR_SPEC.frame_width.def}
                format={(v) => `${v}%`}
              />
            </div>
          </div>
        )}

        {/* Film simulation: built-in Fuji-style looks rendered server-side as
            the base "stock" under curves/mixer/grading, plus a strength blend. */}
        {accordionHeader("filmsim", "Film Simulation")}
        {openGroup === "filmsim" && (
          <div className="editor-accordion-body">
            <div className="film-sim-grid">
              {FILM_SIMS.map((f) => (
                <button
                  key={f.value}
                  className={`film-sim-tile${adj.film_sim === f.value ? " active" : ""}`}
                  onClick={() => setAdj((a) => ({ ...a, film_sim: f.value }))}
                  title={f.label}
                >
                  <span className="film-sim-swatch" style={{ background: f.swatch }} />
                  <span className="film-sim-label">{f.label}</span>
                </button>
              ))}
            </div>
            {adj.film_sim !== "none" && (
              <div className="editor-sliders">
                <Slider
                  label="Strength"
                  value={adj.lut_intensity}
                  min={SCALAR_SPEC.lut_intensity.min}
                  max={SCALAR_SPEC.lut_intensity.max}
                  resetValue={SCALAR_SPEC.lut_intensity.def}
                  format={(v) => `${v}%`}
                  onChange={(v) => setAdj((a) => ({ ...a, lut_intensity: v }))}
                />
              </div>
            )}
          </div>
        )}

        {/* Tone: tone mapper + histogram + the tone sliders. */}
        {accordionHeader("basic", "Tone")}
        {openGroup === "basic" && (
          <div className="editor-accordion-body">
            {/* Base transfer curve the tonal sliders ride on. */}
            <Dropdown
              className="editor-grid-select"
              value={adj.tone_mapper}
              onChange={(v) => setAdj((a) => ({ ...a, tone_mapper: v as Adjustments["tone_mapper"] }))}
              title="Tone mapper"
              ariaLabel="Tone mapper"
              options={TONE_MAPPERS.map((t) => ({ value: t.value, label: t.label }))}
            />
            {/* Live RGB histogram of the current preview, with the tonal controls. */}
            <Histogram bins={histBins} />
            {scalarSliders(sectionFields("Basic"))}
          </div>
        )}

        {/* Curves: channel tabs + Point/Parametric toggle + editor/sliders. */}
        {accordionHeader("curves", "Curves")}
        {openGroup === "curves" && (
          <div className="editor-accordion-body">
            {/* In point mode the histogram is drawn inside the plot (see the
                CurveEditor), which is where it's actually read; parametric mode
                has no plot, so it keeps the standalone one. */}
            {adj.curve_mode !== "point" && <Histogram bins={histBins} />}
            <div className="curve-tabs">
              {CURVE_CHANNELS.map((c) => (
                <button
                  key={c.key}
                  className={`btn btn-sm curve-tab${curveChannel === c.key ? " primary" : ""}`}
                  onClick={() => setCurveChannel(c.key)}
                >
                  <span className="curve-tab-dot" style={{ background: c.color }} />
                  {c.label}
                </button>
              ))}
            </div>
            <div className="curve-toolbar">
              {/* Targeted adjustment: point at the tone you want to change on
                  the photo and drag up/down. */}
              <button
                className={`btn btn-sm curve-pick${curvePickMode ? " primary" : ""}`}
                aria-pressed={curvePickMode}
                onClick={() =>
                  setCurvePickMode((on) => {
                    const next = !on;
                    if (next) {
                      setCropMode(false);
                      setMaskDrawMode(false);
                      setColorPickMode(false);
                    } else {
                      setCurveMarker(null);
                    }
                    return next;
                  })
                }
                title="Targeted adjustment: drag on the photo to move the curve at that tone"
              >
                <IconTarget />
              </button>
              <span className="segmented">
                {/* Switching modes converts the current curve into the other
                    representation (sampled points / least-squares fitted
                    sliders), so the look carries over instead of resetting. */}
                <button
                  className={adj.curve_mode === "point" ? "active" : ""}
                  onClick={() =>
                    setAdj((a) =>
                      a.curve_mode === "point"
                        ? a
                        : { ...a, curve_mode: "point", point_curves: parametricToPoints(a.parametric_curve) }
                    )
                  }
                >
                  Point
                </button>
                <button
                  className={adj.curve_mode === "parametric" ? "active" : ""}
                  onClick={() =>
                    setAdj((a) =>
                      a.curve_mode === "parametric"
                        ? a
                        : { ...a, curve_mode: "parametric", parametric_curve: pointsToParametric(a.point_curves) }
                    )
                  }
                >
                  Parametric
                </button>
              </span>
              <button className="btn btn-sm ghost" onClick={resetCurve} title="Reset the active channel">
                Reset curve
              </button>
            </div>
            {adj.curve_mode === "point" ? (
              <CurveEditor
                points={adj.point_curves[curveChannel]}
                color={CURVE_CHANNELS.find((c) => c.key === curveChannel)!.color}
                onChange={(pts) => setPointCurve(curveChannel, pts)}
                histogram={histBins}
                channel={curveChannel}
                marker={curvePickMode ? curveMarker : null}
              />
            ) : (
              <div className="editor-sliders">
                {/* Caption to disambiguate these from the Basic panel's
                    Highlights/Shadows sliders: these reshape the tone curve by
                    region and stack on top of Basic, they don't replace it. */}
                <p className="curve-param-hint">
                  Reshape the tone curve by region. Separate from the Basic
                  Highlights/Shadows — both apply.
                </p>
                <Slider
                  label="Highlights (curve)"
                  value={adj.parametric_curve[curveChannel].highlights}
                  onChange={(v) => setParamCurve(curveChannel, { highlights: v })}
                />
                <Slider
                  label="Lights (curve)"
                  value={adj.parametric_curve[curveChannel].lights}
                  onChange={(v) => setParamCurve(curveChannel, { lights: v })}
                />
                <Slider
                  label="Darks (curve)"
                  value={adj.parametric_curve[curveChannel].darks}
                  onChange={(v) => setParamCurve(curveChannel, { darks: v })}
                />
                <Slider
                  label="Shadows (curve)"
                  value={adj.parametric_curve[curveChannel].shadows}
                  onChange={(v) => setParamCurve(curveChannel, { shadows: v })}
                />
              </div>
            )}
          </div>
        )}

        {/* Color: Color sliders + HSL mixer + Color Grading + Calibration. */}
        {accordionHeader("color", "Color")}
        {openGroup === "color" && (
          <div className="editor-accordion-body">
            {scalarSliders(sectionFields("Color"))}

            {/* HSL colour mixer: per-band Hue / Saturation / Luminance (adj.hsl). */}
            <div className="editor-section-title">Color mixer</div>
            <div className="mixer-bands">
              {COLOR_BANDS.map((b) => (
                <button
                  key={b}
                  className={`mixer-band${band === b ? " active" : ""}${!adj.hsl[b].every((v) => v === 0) ? " edited" : ""}`}
                  style={{ background: BAND_SWATCH[b] }}
                  title={b}
                  onClick={() => setBand(b)}
                />
              ))}
            </div>
            <div className="editor-sliders">
              {MIX_CHANNELS.map(([ch, lbl]) => (
                <Slider key={ch} label={lbl} value={adj.hsl[band][ch]} onChange={(v) => setBandChannel(ch, v)} />
              ))}
            </div>

            {/* Colour grading: four hue/saturation wheels + blending / balance. */}
            <div className="editor-section-title">Color Grading</div>
            <div className="grade-wheels">
              {GRADE_RANGES.map((r) => (
                <div key={r.key} className="grade-wheel-cell">
                  <ColorWheel
                    label={r.label}
                    hue={adj.color_grading[r.key].hue}
                    saturation={adj.color_grading[r.key].saturation}
                    onChange={(v) => setGrade(r.key, v)}
                    onReset={() => setGrade(r.key, { hue: 0, saturation: 0 })}
                  />
                  <Slider
                    label="Luminance"
                    value={adj.color_grading[r.key].luminance}
                    onChange={(v) => setGrade(r.key, { luminance: v })}
                  />
                </div>
              ))}
            </div>
            <div className="editor-sliders">
              <Slider
                label="Blending"
                value={adj.color_grading.blending}
                min={0}
                max={100}
                resetValue={50}
                onChange={(v) => setGradeScalar("blending", v)}
              />
              <Slider label="Balance" value={adj.color_grading.balance} onChange={(v) => setGradeScalar("balance", v)} />
            </div>

            {/* Colour calibration: seven primary hue/saturation + shadow tint. */}
            <div className="editor-section-title">Calibration</div>
            <div className="editor-sliders">
              {CALIB_FIELDS.map((f) => (
                <Slider
                  key={f.key}
                  label={f.label}
                  value={adj.color_calibration[f.key]}
                  onChange={(v) => setCalib(f.key, v)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Details */}
        {accordionHeader("details", "Details")}
        {openGroup === "details" && <div className="editor-accordion-body">{scalarSliders(sectionFields("Details"))}</div>}

        {/* Effects */}
        {accordionHeader("effects", "Effects")}
        {openGroup === "effects" && <div className="editor-accordion-body">{scalarSliders(sectionFields("Effects"))}</div>}

        {/* Masks (local / per-region adjustments). Everything writes into
            adj.masks, which rides along in previewEdits, so the server preview
            re-renders on every change. */}
        {accordionHeader("masks", "Masks")}
        {openGroup === "masks" && (
          <div className="editor-accordion-body">
        <div className="mask-list">
          {adj.masks.length === 0 && <p className="mask-empty">No masks yet — add one to adjust part of the photo.</p>}
          {adj.masks.map((m) => (
            <div
              key={m.id}
              className={`mask-row${selectedMaskId === m.id ? " active" : ""}`}
              onClick={() => selectMask(m.id)}
              // Pointing at a row marks that mask on the photo (see markedMask).
              onMouseEnter={() => setHoveredMaskId(m.id)}
              onMouseLeave={() => setHoveredMaskId((id) => (id === m.id ? null : id))}
              title="Hover to see what this mask covers"
            >
              <button
                className="mask-eye"
                title={m.visible ? "Hide mask" : "Show mask"}
                onClick={(e) => {
                  e.stopPropagation();
                  updateMask(m.id, { visible: !m.visible });
                }}
              >
                {m.visible ? "◉" : "◯"}
              </button>
              <span className="mask-row-name">
                {m.name}
                <span className="mask-row-type">{maskLabel(m)}</span>
              </span>
              <button
                className="mask-del"
                title="Delete mask"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteMask(m.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {/* Subject masks: the server finds the region, so these read as things
            in the photo rather than as shapes to draw. */}
        <div className="mask-add-row">
          <span className="mask-add-label">Select subject</span>
          <div className="mask-add-btns">
            {MASK_SUBJECTS.map((s) => (
              <button
                key={s.value}
                className="btn btn-sm"
                disabled={segmenting !== null}
                onClick={() => addSemanticMask(s.value)}
              >
                {segmenting === s.value ? "Finding…" : s.label}
              </button>
            ))}
          </div>
        </div>
        {segmentError && <p className="mask-hint mask-hint-error">{segmentError}</p>}

        <div className="mask-add-row">
          <span className="mask-add-label">Add mask</span>
          <div className="mask-add-btns">
            {MASK_TYPES.map((t) => (
              <button key={t.value} className="btn btn-sm" onClick={() => addMask(t.value)}>
                + {t.label}
              </button>
            ))}
          </div>
        </div>

        {selectedMask && selSub && (
          <div className="mask-editor">
            <Slider
              label="Opacity"
              value={selectedMask.opacity}
              min={0}
              max={100}
              resetValue={100}
              onChange={(v) => updateMask(selectedMask.id, { opacity: v })}
            />
            <div className="mask-btn-row">
              <button
                className={`btn btn-sm${selectedMask.invert ? " primary" : ""}`}
                onClick={() => updateMask(selectedMask.id, { invert: !selectedMask.invert })}
                title="Invert this mask"
              >
                Invert
              </button>
              {isSpatial(selSub.type) && (
                <button
                  className={`btn btn-sm${maskDrawMode ? " primary" : ""}`}
                  onClick={toggleMaskDraw}
                  title="Draw this mask directly on the image"
                >
                  {maskDrawMode ? "Drawing on image…" : "Edit on image"}
                </button>
              )}
            </div>

            {/* Sub-mask (index 0) controls, by type. */}
            {selSub.type === "brush" && (
              <Slider
                label="Brush size"
                value={Math.round(subNum(selSub, "size", 0.06) * 500)}
                min={1}
                max={40}
                resetValue={30}
                onChange={(v) => updateSubMaskParams(selectedMask.id, { size: v / 500 })}
              />
            )}
            {(selSub.type === "radial" || selSub.type === "brush") && (
              <Slider
                label="Feather"
                value={subNum(selSub, "feather", 50)}
                min={0}
                max={100}
                resetValue={50}
                onChange={(v) => updateSubMaskParams(selectedMask.id, { feather: v })}
              />
            )}
            {selSub.type === "brush" && (
              <>
                <Slider
                  label="Flow"
                  value={subNum(selSub, "flow", 100)}
                  min={1}
                  max={100}
                  resetValue={100}
                  onChange={(v) => updateSubMaskParams(selectedMask.id, { flow: v })}
                />
                <Slider
                  label="Density"
                  value={subNum(selSub, "density", 100)}
                  min={0}
                  max={100}
                  resetValue={100}
                  onChange={(v) => updateSubMaskParams(selectedMask.id, { density: v })}
                />
                <button
                  className={`btn btn-sm${brushErase ? " primary" : " ghost"}`}
                  onClick={() => setBrushErase((v) => !v)}
                  title="Paint to remove from this mask instead of adding — hold Alt for a single erase stroke"
                >
                  {brushErase ? "Erasing" : "Erase"}
                </button>
              </>
            )}
            {/* Linear has no Feather: the band width (start->end distance) IS the
                softness, so the edge lines set it directly on the image. */}
            {selSub.type === "linear" && <p className="mask-hint">Drag the outer lines to set the gradient width.</p>}
            {selSub.type === "brush" && (
              <button
                className="btn btn-sm ghost"
                disabled={!Array.isArray(selSub.parameters.strokes) || (selSub.parameters.strokes as number[][]).length === 0}
                onClick={() => updateSubMaskParams(selectedMask.id, { strokes: [] })}
              >
                Clear strokes
              </button>
            )}

            {selSub.type === "luminance" && (
              <>
                <Slider
                  label="Range min"
                  value={subNum(selSub, "range_min", 0)}
                  min={0}
                  max={100}
                  resetValue={0}
                  onChange={(v) => updateSubMaskParams(selectedMask.id, { range_min: v })}
                />
                <Slider
                  label="Range max"
                  value={subNum(selSub, "range_max", 50)}
                  min={0}
                  max={100}
                  resetValue={50}
                  onChange={(v) => updateSubMaskParams(selectedMask.id, { range_max: v })}
                />
                <Slider
                  label="Feather"
                  value={subNum(selSub, "feather", 35)}
                  min={0}
                  max={100}
                  resetValue={35}
                  onChange={(v) => updateSubMaskParams(selectedMask.id, { feather: v })}
                />
              </>
            )}

            {selSub.type === "semantic" && (
              <>
                {/* The region was found in the frame as it was then, so a crop
                    or a straighten afterwards leaves it out of line. Recompute
                    is the fix and sits right here, always available - it used
                    to be introduced by a red warning line, which shouted at
                    every crop for something the button already says. */}
                <div className="mask-btn-row">
                  <button
                    className="btn btn-sm"
                    disabled={segmenting !== null}
                    onClick={() => runSegment(subStr(selSub, "subject") || "sky", selectedMask.id, selSub.id)}
                    title="Find this subject again in the current frame"
                  >
                    {segmenting ? "Finding…" : "Recompute"}
                  </button>
                </div>
                <Slider
                  label="Feather"
                  value={subNum(selSub, "feather", 0)}
                  min={0}
                  max={100}
                  resetValue={0}
                  onChange={(v) => updateSubMaskParams(selectedMask.id, { feather: v })}
                />
              </>
            )}

            {selSub.type === "color" && (
              <>
                <div className="mask-color-row">
                  <button
                    className={`btn btn-sm${colorPickMode ? " primary" : ""}`}
                    onClick={toggleColorPick}
                    title="Sample the target colour from the image"
                  >
                    {colorPickMode ? "Click the image…" : "Pick color"}
                  </button>
                  <span
                    className="mask-swatch"
                    style={{
                      background: `rgb(${Math.round(subNum(selSub, "target_r", 0.5) * 255)}, ${Math.round(
                        subNum(selSub, "target_g", 0.5) * 255
                      )}, ${Math.round(subNum(selSub, "target_b", 0.5) * 255)})`,
                    }}
                  />
                </div>
                <Slider
                  label="Tolerance"
                  value={subNum(selSub, "tolerance", 20)}
                  min={1}
                  max={100}
                  resetValue={20}
                  onChange={(v) => updateSubMaskParams(selectedMask.id, { tolerance: v })}
                />
                <Slider
                  label="Feather"
                  value={subNum(selSub, "feather", 35)}
                  min={0}
                  max={100}
                  resetValue={35}
                  onChange={(v) => updateSubMaskParams(selectedMask.id, { feather: v })}
                />
              </>
            )}

            {/* Per-mask local adjustments: MASK_ADJUST_FIELDS -> sparse adjustments. */}
            <div className="mask-subhead">Adjustments</div>
            <div className="editor-sliders">
              {MASK_ADJUST_FIELDS.map((field) => {
                const spec: ScalarDef = SCALAR_SPEC[field.key];
                return (
                  <Slider
                    key={field.key}
                    label={field.label}
                    value={selectedMask.adjustments[field.key] ?? spec.def}
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    resetValue={spec.def}
                    uiScale={spec.uiScale}
                    format={field.format}
                    onChange={(v) => updateMaskAdjust(selectedMask.id, field.key, v)}
                  />
                );
              })}
            </div>

            <button className="btn btn-sm ghost" onClick={() => deleteMask(selectedMask.id)}>
              Delete mask
            </button>
          </div>
        )}
          </div>
        )}

        {/* Presets */}
        {accordionHeader("presets", "Presets")}
        {openGroup === "presets" && (
          <div className="editor-accordion-body">
        {namingPreset ? (
          <div className="editor-preset-row">
            <input
              className="editor-preset-select"
              type="text"
              autoFocus
              placeholder="Preset name"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmSavePreset();
                else if (e.key === "Escape") {
                  setNamingPreset(false);
                  setPresetName("");
                }
              }}
            />
            <button className="btn btn-sm primary" onClick={confirmSavePreset} disabled={!presetName.trim()}>
              Save
            </button>
            <button
              className="btn btn-sm ghost"
              onClick={() => {
                setNamingPreset(false);
                setPresetName("");
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="editor-preset-row">
            <Dropdown
              className="editor-preset-select"
              value={selectedPreset}
              ariaLabel="Apply preset"
              onChange={(name) => {
                setSelectedPreset(name);
                const p = presets[name];
                if (p) applyPreset(p);
              }}
              options={[
                {
                  value: "",
                  label: Object.keys(presets).length ? "Apply a preset…" : "No presets yet",
                },
                ...Object.keys(presets)
                  .sort()
                  .map((name) => ({ value: name, label: name })),
              ]}
            />
            <button
              className="btn btn-sm"
              onClick={() => {
                setPresetName(selectedPreset || "");
                setNamingPreset(true);
              }}
              title="Save the current look as a preset"
            >
              Save…
            </button>
            <button
              className="btn btn-sm ghost"
              onClick={handleDeletePreset}
              disabled={!selectedPreset}
              title="Delete the selected preset"
            >
              Delete
            </button>
          </div>
        )}
          </div>
        )}

        </div>

        <div className="editor-footer">
          {(saveEdits.isError || saveCopy.isError) && (
            <p className="editor-footer-error">{((saveEdits.error || saveCopy.error) as Error).message}</p>
          )}
          {autoAdjust.isError && <p className="editor-footer-error">{autoErrorText(autoAdjust.error)}</p>}
          <div className="editor-footer-secondary">
            {autoDevelopSettings.data?.enabled && (
              <button
                className="btn ghost btn-sm"
                disabled={autoAdjust.isPending || busy}
                onClick={() => autoAdjust.mutate()}
                title="Suggest develop settings learned from your edited photos"
              >
                {autoAdjust.isPending ? "Auto…" : "Auto"}
              </button>
            )}
            <button
              className="btn ghost btn-sm"
              disabled={allNeutral}
              onClick={() => {
                setAdj(defaultAdjustments());
                setRotation(0);
                setCrop(null);
                setFlipH(false);
                setFlipV(false);
                setStraighten(0);
                setPerspH(0);
                setPerspV(0);
                setDistortion(0);
                setSelectedMaskId(null);
                setMaskDrawMode(false);
                setColorPickMode(false);
              }}
            >
              Reset all
            </button>
          </div>
          <div className="editor-footer-primary">
            <button
              className="btn"
              onClick={() => setSaveCopyOpen(true)}
              disabled={busy}
              title="Create a new edited photo in your library, tagged “edit copy”"
            >
              {saveCopy.isPending ? "Saving…" : "Save copy"}
            </button>
            <button className="btn primary" onClick={() => saveEdits.mutate()} disabled={busy || !dirty}>
              {saveEdits.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
      </div>
      {saveCopyOpen && (
        <SaveCopyDialog
          onClose={() => setSaveCopyOpen(false)}
          onSave={(opts) => saveCopy.mutateAsync(opts)}
        />
      )}
    </div>
  );
}

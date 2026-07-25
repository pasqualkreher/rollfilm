import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { CropBox, ImageOut } from "../api/types";
import {
  adjustmentsFromImage,
  BAND_SWATCH,
  COLOR_BANDS,
  defaultAdjustments,
  editsAreNeutral,
  editsFromImage,
  FILM_SIMS,
  MASK_ADJUST_FIELDS,
  MASK_TYPES,
  neutralEdits,
  newMask,
  normalizeAdjustments,
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
import { parametricToPoints, pointsToParametric } from "../utils/curveConvert";
import { loadPresets, savePreset, deletePreset, type EditPreset } from "../utils/presets";
import { CurveEditor } from "./CurveEditor";
import { ColorWheel } from "./ColorWheel";
import { MaskOverlay } from "./MaskOverlay";

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
const GRID_OPTIONS: { value: GridOverlay; label: string }[] = [
  { value: "none", label: "No grid" },
  { value: "thirds", label: "Rule of thirds" },
  { value: "grid", label: "Grid" },
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
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

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
}) {
  return (
    <label className="editor-slider">
      <span className="editor-slider-head">
        <span>{label}</span>
        <span className="editor-slider-val">{format ? format(value) : value > 0 ? `+${value}` : value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
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

// Compute an RGB histogram (3 x 256 bins) from a rendered preview, sampling
// ~120k pixels regardless of size.
function computeHistBins(img: ImageData): Uint32Array[] {
  const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const d = img.data;
  const step = Math.max(1, Math.floor(d.length / 4 / 120000)) * 4;
  for (let i = 0; i < d.length; i += step) {
    bins[0][d[i]]++;
    bins[1][d[i + 1]]++;
    bins[2][d[i + 2]]++;
  }
  return bins;
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
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stageMainRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panDragRef = useRef<{ x: number; y: number } | null>(null);
  // RGB histogram bins of the latest preview; the <Histogram> components (in the
  // Basic and Curves groups) draw from this and redraw when it changes or on mount.
  const [histBins, setHistBins] = useState<Uint32Array[] | null>(null);
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
  // Whether the canvas is zoomed in (scale > 1) - read by the settle pass to
  // decide if it should chase the full tier with a true-resolution render.
  const zoomedRef = useRef(false);
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
    const rect = box.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const s = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    canvas.style.width = `${Math.round(canvas.width * s)}px`;
    canvas.style.height = `${Math.round(canvas.height * s)}px`;
  }

  useEffect(() => {
    window.addEventListener("resize", fitCanvasToStage);
    return () => window.removeEventListener("resize", fitCanvasToStage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saved = editsFromImage(image);
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
  const [gridOverlay, setGridOverlay] = useState<GridOverlay>("none");
  const [presets, setPresets] = useState<Record<string, EditPreset>>(() => loadPresets());
  const [selectedPreset, setSelectedPreset] = useState("");
  // Inline preset naming (Electron has no window.prompt).
  const [namingPreset, setNamingPreset] = useState(false);
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
  } | null>(null);
  const brushLast = useRef<{ x: number; y: number } | null>(null);
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
  // Live cursor over the canvas while editing a mask (reflects the handle/body
  // under the pointer), and the pointer position for the brush-size ring.
  const [maskCursor, setMaskCursor] = useState("crosshair");
  const [maskCursorPos, setMaskCursorPos] = useState<{ x: number; y: number } | null>(null);
  // Which control-panel accordion group is expanded. Only one is open at a time
  // ("" = all collapsed); purely presentational grouping of the existing panel.
  const [openGroup, setOpenGroup] = useState<string>("basic");

  // Leaving the Masks group hides the mask guides/handles on the image (see the
  // MaskOverlay render condition) - also drop out of draw/pick mode so canvas
  // clicks go back to zoom/pan/crop.
  useEffect(() => {
    if (openGroup !== "masks") {
      setMaskDrawMode(false);
      setColorPickMode(false);
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
    const maxX = Math.max(0, (dispW * s - stage.clientWidth) / 2);
    const maxY = Math.max(0, (dispH * s - stage.clientHeight) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, p.x)), y: Math.max(-maxY, Math.min(maxY, p.y)) };
  }

  const edits: ImageEdits = { rotation, crop, flipH, flipV, straighten, perspH, perspV, distortion, adjustments: adj };

  // What the preview should actually show right now: in crop mode the full
  // (uncropped) frame, in compare mode the untouched original with only the
  // geometry kept so the frame doesn't jump.
  // The white frame expands the canvas, which would offset the crop-rect and
  // mask overlays (they're positioned as fractions of the displayed image). So
  // while a spatial overlay is live, render the preview without the frame - it
  // still shows (and always saves) whenever no overlay needs pixel alignment.
  const overlayActive = cropMode || openGroup === "masks";
  const previewEdits: ImageEdits = compare
    ? neutralEdits(rotation, cropMode ? null : crop, flipH, flipV, straighten, perspH, perspV, distortion)
    : {
        ...edits,
        crop: cropMode ? null : crop,
        adjustments: overlayActive && adj.frame_width ? { ...adj, frame_width: 0 } : adj,
      };
  const previewKey = JSON.stringify(previewEdits);
  // Always hand the pump the newest edit state (read from a ref so the pump and
  // the pointer-up handler don't close over a stale value).
  previewEditsLatest.current = previewEdits;
  compareRef.current = compare;
  zoomedRef.current = zoomed;

  // Paint a rendered JPEG onto the canvas, sizing it to the bitmap and
  // (optionally) refreshing the histogram. `seq` guards against a late or
  // superseded render painting over a newer frame.
  const drawBlob = useCallback(async (blob: Blob, seq: number, withHistogram: boolean) => {
    const bmp = await createImageBitmap(blob);
    if (seq !== renderSeq.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    fitCanvasToStage();
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    if (withHistogram) setHistBins(computeHistBins(ctx.getImageData(0, 0, bmp.width, bmp.height)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once edits come to rest, refine on the larger full-quality base so the
  // resolution-dependent passes (denoise/sharpen radii, grain) preview as they
  // will be saved. Cancelled the instant a new drag starts.
  const scheduleSettle = useCallback(() => {
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(async () => {
      // Hold-to-compare keeps the pointer down but still wants the full render.
      if (scrubbing.current && !compareRef.current) return;
      const seq = renderSeq.current;
      fullAbortRef.current?.abort();
      const fctrl = new AbortController();
      fullAbortRef.current = fctrl;
      try {
        const blob = await api.images.editorPreview(image.id, previewEditsLatest.current!, fctrl.signal, "full");
        if ((scrubbing.current && !compareRef.current) || seq !== renderSeq.current) return;
        await drawBlob(blob, seq, false);
        // Zoomed in, the bounded settle base still shows upscaled - chase it
        // with the TRUE full-resolution render (like the lightbox's full.jpg).
        // Same abort controller: any new edit/drag cancels it; the seq guard
        // drops it if a newer frame was painted while it rendered.
        if (zoomedRef.current) {
          const nblob = await api.images.editorPreview(image.id, previewEditsLatest.current!, fctrl.signal, "native");
          if ((scrubbing.current && !compareRef.current) || seq !== renderSeq.current) return;
          await drawBlob(nblob, seq, false);
        }
      } catch {
        // Non-fatal: the accurate preview is already on screen.
      }
    }, 350);
  }, [image.id, drawBlob]);

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
      while (renderedToken.current !== dirtyToken.current) {
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
          const blob = await api.images.editorPreview(image.id, edits, ctrl.signal, scrub ? "scrub" : "fast");
          await drawBlob(blob, seq, true);
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
    // Refine to full quality when settled - or while holding compare, so the
    // original reaches the same full-resolution tier as the edited preview.
    if (!scrubbing.current || compareRef.current) scheduleSettle();
  }, [image.id, drawBlob, scheduleSettle]);
  pumpRef.current = () => void pump();

  // Kick the pump whenever the edit state changes (or the image switches).
  useEffect(() => {
    dirtyToken.current++;
    void pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image.id, previewKey]);

  // Zooming in while edits are at rest doesn't touch the pump (no edit change),
  // so kick the settle pass directly - it chases the bounded settle render with
  // the true-resolution one now that the canvas is zoomed.
  useEffect(() => {
    if (zoomed) scheduleSettle();
  }, [zoomed, scheduleSettle]);

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

  function handleDeletePreset() {
    if (!selectedPreset || !presets[selectedPreset]) return;
    if (!window.confirm(`Delete preset “${selectedPreset}”?`)) return;
    deletePreset(selectedPreset);
    setPresets(loadPresets());
    setSelectedPreset("");
  }

  const saveEdits = useMutation({
    mutationFn: () => api.images.saveEdits(image.id, edits),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["image", image.id] });
      queryClient.invalidateQueries({ queryKey: ["images"] });
      onClose();
    },
  });

  const saveCopy = useMutation({
    mutationFn: () => api.images.saveCopy(image.id, edits),
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
    mutationFn: () => api.images.autoAdjust(image.id),
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
        else if (maskDrawMode) setMaskDrawMode(false);
        else if (cropMode) setCropMode(false);
        else if (!busy) onClose();
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
  }, [onClose, busy, cropMode, maskDrawMode, colorPickMode]);

  function fractionAt(clientX: number, clientY: number) {
    const box = canvasRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max((clientX - box.left) / box.width, 0), 1),
      y: Math.min(Math.max((clientY - box.top) / box.height, 0), 1),
    };
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
  // Append one brush point [x, y, size] to the index-0 sub-mask's strokes.
  function appendStroke(id: string, x: number, y: number, size: number) {
    appendStrokes(id, [[x, y, size]]);
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
  function maskPointerDown(clientX: number, clientY: number) {
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
      maskGesture.current = { type: "brush", maskId: mask.id, mode: "paint", start: p, orig: {} };
      brushLast.current = p;
      setMaskCursorPos(p);
      appendStroke(mask.id, p.x, p.y, subNum(sub, "size", 0.06));
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
      // Brush: interpolate evenly-spaced points along the segment since the last
      // stamp so a fast drag paints a continuous, gap-free stroke.
      const sub = adj.masks.find((m) => m.id === g.maskId)?.sub_masks[0];
      const size = sub ? subNum(sub, "size", 0.06) : 0.06;
      setMaskCursorPos(p);
      const step = Math.max(0.003, size * 0.5);
      const last = brushLast.current ?? p;
      const dist = Math.hypot(p.x - last.x, p.y - last.y);
      if (dist >= step) {
        const n = Math.floor(dist / step);
        const pts: number[][] = [];
        for (let i = 1; i <= n; i++) {
          const t = (i * step) / dist;
          pts.push([last.x + (p.x - last.x) * t, last.y + (p.y - last.y) * t, size]);
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

  const drawn = drag ? normalizeRect(drag) : null;
  const hasDrawnCrop = drawn && drawn.width > 0.02 && drawn.height > 0.02;
  const dirty = JSON.stringify(edits) !== JSON.stringify(saved);
  const allNeutral = editsAreNeutral(edits);

  // The selected mask (if any), its index-0 sub-mask, and - when that sub-mask
  // is a drawable type - the sub used for the on-canvas overlay.
  const selectedMask = selectedMaskId ? adj.masks.find((m) => m.id === selectedMaskId) ?? null : null;
  const selSub = selectedMask?.sub_masks[0] ?? null;
  const selSpatialSub = selSub && isSpatial(selSub.type) ? selSub : null;
  const maskLabel = (m: MaskDef) => MASK_TYPES.find((t) => t.value === m.sub_masks[0]?.type)?.label ?? "Mask";

  return (
    <div className="editor-overlay">
      {/* Floating back button in the top-left corner - no header bar, so the
          stage gets the full height. */}
      <button
        className="icon-btn back-btn editor-back-float"
        onClick={onClose}
        disabled={busy}
        title="Back (Esc)"
        aria-label="Back"
      >
        ←
      </button>
      <div className="editor-body">
        <div className={`editor-stage editor-stage-${bgMode}`} ref={stageRef}>
        <div className="editor-stage-main" ref={stageMainRef}>
        {loading && <div className="editor-hint">Loading…</div>}
        {error && <div className="editor-hint">{error}</div>}
        <div className="editor-canvas-wrap" ref={wrapRef} style={{ display: loading || error ? "none" : "inline-block" }}>
          <canvas
            ref={canvasRef}
            className="editor-canvas"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              cursor: colorPickMode
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
              if (maskDrawMode) {
                maskPointerDown(e.clientX, e.clientY);
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
              endMaskGesture();
            }}
            onMouseLeave={() => {
              setDragging(false);
              cropAction.current = null;
              panDragRef.current = null;
              endMaskGesture();
              setMaskCursorPos(null);
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
          {!zoomed && <GridLines type={gridOverlay} />}
          {/* Selected-mask guide + editable handles, transformed to track the
              canvas under zoom/pan. aspect keeps the round handles round on
              non-square images; cursor draws the brush-size ring. */}
          {selSpatialSub && openGroup === "masks" && (
            <MaskOverlay
              sub={selSpatialSub}
              handles={maskDrawMode}
              aspect={canvasRef.current && canvasRef.current.height ? canvasRef.current.width / canvasRef.current.height : 1}
              cursor={
                selSpatialSub.type === "brush" && maskDrawMode && maskCursorPos
                  ? { x: maskCursorPos.x, y: maskCursorPos.y, size: subNum(selSpatialSub, "size", 0.06) }
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
              disabled={allNeutral}
              title="Hold to compare with the original"
            >
              {compare ? "Showing original" : "Compare"}
            </button>
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

        {/* Transform: composition grid, rotate/flip/crop, straighten + tilt. */}
        {accordionHeader("transform", "Transform")}
        {openGroup === "transform" && (
          <div className="editor-accordion-body">
        {/* Composition grid overlay - its own row above rotate/crop. */}
        <div className="editor-geometry">
          <select
            className="editor-grid-select"
            value={gridOverlay}
            onChange={(e) => setGridOverlay(e.target.value as GridOverlay)}
            title="Overlay grid"
          >
            {GRID_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/* Geometry */}
        <div className="editor-geometry">
          <button className="btn btn-sm" onClick={() => setRotation((r) => (r + 270) % 360)} disabled={busy} title="Rotate left 90°">
            ⟲
          </button>
          <button className="btn btn-sm" onClick={() => setRotation((r) => (r + 90) % 360)} disabled={busy} title="Rotate right 90°">
            ⟳
          </button>
          <button
            className={`btn btn-sm${flipH ? " primary" : ""}`}
            onClick={() => setFlipH((v) => !v)}
            disabled={busy}
            title="Flip horizontal"
          >
            ⇆
          </button>
          <button
            className={`btn btn-sm${flipV ? " primary" : ""}`}
            onClick={() => setFlipV((v) => !v)}
            disabled={busy}
            title="Flip vertical"
          >
            ⇅
          </button>
          <button
            className={`btn btn-sm${cropMode ? " primary" : ""}`}
            disabled={busy}
            onClick={() => {
              setCropMode((on) => {
                const next = !on;
                if (next) {
                  // Crop and mask-draw share the canvas pointer - only one at a time.
                  setMaskDrawMode(false);
                  setColorPickMode(false);
                  setOpenGroup("transform");
                  if (crop) setDrag({ x0: crop.x, y0: crop.y, x1: crop.x + crop.width, y1: crop.y + crop.height });
                  else setDrag(null);
                }
                return next;
              });
            }}
          >
            Crop
          </button>
          {cropMode && (
            <>
              <select
                className="editor-grid-select"
                value={aspectKey}
                onChange={(e) => pickAspect(e.target.value)}
                title="Crop aspect ratio"
              >
                {ASPECT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button className="btn btn-sm primary" disabled={!hasDrawnCrop} onClick={() => { setCrop(normalizeRect(drag!)); setCropMode(false); }}>
                Apply
              </button>
              <button className="btn btn-sm" disabled={!crop && !drawn} onClick={() => { setCrop(null); setDrag(null); setAspectKey("free"); setCropMode(false); }}>
                Clear
              </button>
            </>
          )}
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
            <select
              className="editor-grid-select"
              value={adj.tone_mapper}
              onChange={(e) => setAdj((a) => ({ ...a, tone_mapper: e.target.value as Adjustments["tone_mapper"] }))}
              title="Tone mapper"
            >
              {TONE_MAPPERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            {/* Live RGB histogram of the current preview, with the tonal controls. */}
            <Histogram bins={histBins} />
            {scalarSliders(sectionFields("Basic"))}
          </div>
        )}

        {/* Curves: channel tabs + Point/Parametric toggle + editor/sliders. */}
        {accordionHeader("curves", "Curves")}
        {openGroup === "curves" && (
          <div className="editor-accordion-body">
            {/* Histogram of the current preview, to shape the tone curve against. */}
            <Histogram bins={histBins} />
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
            <select
              className="editor-preset-select"
              value={selectedPreset}
              onChange={(e) => {
                const name = e.target.value;
                setSelectedPreset(name);
                const p = presets[name];
                if (p) applyPreset(p);
              }}
            >
              <option value="">{Object.keys(presets).length ? "Apply a preset…" : "No presets yet"}</option>
              {Object.keys(presets)
                .sort()
                .map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
            </select>
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
              onClick={() => saveCopy.mutate()}
              disabled={busy}
              title="Create a new edited photo in your library, tagged “edited”"
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
    </div>
  );
}

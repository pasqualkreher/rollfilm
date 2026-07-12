import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { CropBox, ImageOut } from "../api/types";
import {
  ADJUSTMENT_DEFS,
  adjustmentsFromImage,
  BAND_SWATCH,
  COLOR_BANDS,
  editsFromImage,
  isNeutral,
  mixIsNeutral,
  neutralEdits,
  neutralMix,
  NEUTRAL,
  type Adjustments,
  type ColorBand,
  type ColorMix,
  type ImageEdits,
} from "../utils/adjustments";
import { loadPresets, savePreset, deletePreset, type EditPreset } from "../utils/presets";

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
const LIGHT_KEYS: (keyof Adjustments)[] = ["exposure", "contrast", "highlights", "shadows", "whites", "blacks", "dehaze"];
const COLOR_KEYS: (keyof Adjustments)[] = ["temperature", "tint", "saturation"];
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

function labelFor(key: keyof Adjustments): string {
  return ADJUSTMENT_DEFS.find((d) => d.key === key)!.label;
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

function Slider({
  label,
  value,
  onChange,
  min = -100,
  format,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  // Optional value formatter (e.g. exposure rendered in EV stops).
  format?: (v: number) => string;
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
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(0)}
        title="Double-click to reset"
      />
    </label>
  );
}

export function PhotoEditor({ image, onClose }: Props) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panDragRef = useRef<{ x: number; y: number } | null>(null);
  const histRef = useRef<HTMLCanvasElement | null>(null);
  // Server preview plumbing: abort a stale in-flight render when a newer edit
  // state supersedes it, and ignore late responses by sequence number.
  const abortRef = useRef<AbortController | null>(null);
  const fullAbortRef = useRef<AbortController | null>(null);
  const renderSeq = useRef(0);

  // Live RGB histogram of the rendered preview (Lightroom/RapidRAW-style),
  // redrawn on every preview render. Screen-blended channel fills; sqrt scaling
  // so shadows/highlights detail stays readable next to big midtone peaks.
  function drawHistogram(img: ImageData) {
    const hc = histRef.current;
    if (!hc) return;
    const ctx = hc.getContext("2d")!;
    const W = hc.width;
    const H = hc.height;
    const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    const d = img.data;
    // Sample ~120k pixels regardless of preview size.
    const step = Math.max(1, Math.floor(d.length / 4 / 120000)) * 4;
    for (let i = 0; i < d.length; i += step) {
      bins[0][d[i]]++;
      bins[1][d[i + 1]]++;
      bins[2][d[i + 2]]++;
    }
    // Scale by the max over the interior bins so clipped-end spikes don't
    // flatten the rest of the curve (the ends still draw, just capped).
    let max = 1;
    for (let ch = 0; ch < 3; ch++) {
      for (let v = 1; v < 255; v++) if (bins[ch][v] > max) max = bins[ch][v];
    }
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#141416";
    ctx.fillRect(0, 0, W, H);
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
  }

  const saved = editsFromImage(image);
  const [adj, setAdj] = useState<Adjustments>(() => adjustmentsFromImage(image));
  const [rotation, setRotation] = useState(saved.rotation);
  const [crop, setCrop] = useState<CropBox | null>(saved.crop);
  const [colorMix, setColorMix] = useState<ColorMix>(saved.colorMix);
  const [vignette, setVignette] = useState(saved.vignette);
  const [distortion, setDistortion] = useState(saved.distortion);
  const [grain, setGrain] = useState(saved.grain);
  const [grainSize, setGrainSize] = useState(saved.grainSize);
  const [denoise, setDenoise] = useState(saved.denoise);
  const [clarity, setClarity] = useState(saved.clarity);
  const [sharpness, setSharpness] = useState(saved.sharpness);
  const [colorTint, setColorTint] = useState(saved.colorTint);
  const [chromeEffect, setChromeEffect] = useState(saved.chromeEffect);
  const [chromeBlue, setChromeBlue] = useState(saved.chromeBlue);
  const [mistAmount, setMistAmount] = useState(saved.mist);
  const [band, setBand] = useState<ColorBand>("red");
  const [gridOverlay, setGridOverlay] = useState<GridOverlay>("none");
  const [presets, setPresets] = useState<Record<string, EditPreset>>(() => loadPresets());
  const [selectedPreset, setSelectedPreset] = useState("");
  // Inline preset naming (Electron has no window.prompt).
  const [namingPreset, setNamingPreset] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [cropMode, setCropMode] = useState(false);
  const [drag, setDrag] = useState<DragRect | null>(null);
  const [dragging, setDragging] = useState(false);
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
  const zoomed = scale > 1.001;

  function resetZoom() {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }

  const edits: ImageEdits = {
    ...adj,
    rotation,
    crop,
    colorMix,
    vignette,
    distortion,
    grain,
    grainSize,
    denoise,
    clarity,
    sharpness,
    colorTint,
    chromeEffect,
    chromeBlue,
    mist: mistAmount,
  };

  // What the preview should actually show right now: in crop mode the full
  // (uncropped) frame, in compare mode the untouched original with only the
  // geometry kept so the frame doesn't jump.
  const previewEdits: ImageEdits = compare
    ? neutralEdits(rotation, cropMode ? null : crop)
    : { ...edits, crop: cropMode ? null : crop };
  const previewKey = JSON.stringify(previewEdits);

  // Server-rendered live preview: debounce edit changes, cancel the stale
  // in-flight render, draw the returned JPEG onto the canvas. The very first
  // render (and image switches) skip the debounce. Once the sliders settle, a
  // second render on the *full-resolution* base replaces the fast one, so
  // resolution-dependent passes (denoise, sharpen radius, grain) preview
  // exactly as they will be saved.
  useEffect(() => {
    let cancelled = false;
    let fullTimer: ReturnType<typeof setTimeout> | undefined;
    const seq = ++renderSeq.current;
    const draw = async (blob: Blob, withHistogram: boolean) => {
      const bmp = await createImageBitmap(blob);
      if (cancelled || seq !== renderSeq.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      if (withHistogram) drawHistogram(ctx.getImageData(0, 0, bmp.width, bmp.height));
    };
    const timer = setTimeout(
      async () => {
        abortRef.current?.abort();
        fullAbortRef.current?.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        try {
          const blob = await api.images.editorPreview(image.id, previewEdits, ctrl.signal);
          if (cancelled || seq !== renderSeq.current) return;
          await draw(blob, true);
          setError(null);
          setLoading(false);
          setReady(true);
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          if (!cancelled) {
            setError(`Couldn't render the preview: ${(e as Error).message}`);
            setLoading(false);
          }
          return;
        }
        // Full-quality refinement after the sliders settle. The histogram
        // keeps the fast pass's data (statistically identical, and
        // getImageData over a full-res canvas is not free).
        fullTimer = setTimeout(async () => {
          const fctrl = new AbortController();
          fullAbortRef.current = fctrl;
          try {
            const blob = await api.images.editorPreview(image.id, previewEdits, fctrl.signal, true);
            if (cancelled || seq !== renderSeq.current) return;
            await draw(blob, false);
          } catch {
            // Non-fatal: the fast preview is already on screen.
          }
        }, 400);
      },
      ready ? 140 : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (fullTimer) clearTimeout(fullTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image.id, previewKey]);

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
        const next = Math.min(MAX_ZOOM, Math.max(1, prev * factor));
        setPan((pp) =>
          next <= 1.001
            ? { x: 0, y: 0 }
            : { x: dx - (dx - pp.x) * (next / prev), y: dy - (dy - pp.y) * (next / prev) }
        );
        return next;
      });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function applyPreset(p: EditPreset) {
    setAdj({ ...NEUTRAL, ...p.adj });
    setColorMix(p.colorMix ? { ...neutralMix(), ...p.colorMix } : neutralMix());
    setVignette(p.vignette ?? 0);
    setDistortion(p.distortion ?? 0);
    setGrain(p.grain ?? 0);
    setGrainSize(p.grainSize ?? 0);
    setDenoise(p.denoise ?? 0);
    setClarity(p.clarity ?? 0);
    setSharpness(p.sharpness ?? 0);
    setColorTint(p.colorTint ?? 0);
    setChromeEffect(p.chromeEffect ?? 0);
    setChromeBlue(p.chromeBlue ?? 0);
    setMistAmount(p.mist ?? 0);
  }

  function confirmSavePreset() {
    const name = presetName.trim();
    if (!name) return;
    savePreset(name, {
      adj,
      colorMix,
      vignette,
      distortion,
      grain,
      grainSize,
      denoise,
      clarity,
      sharpness,
      colorTint,
      chromeEffect,
      chromeBlue,
      mist: mistAmount,
    });
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

  const busy = saveEdits.isPending || saveCopy.isPending;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (cropMode) setCropMode(false);
      else if (!busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy, cropMode]);

  function fractionAt(clientX: number, clientY: number) {
    const box = canvasRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max((clientX - box.left) / box.width, 0), 1),
      y: Math.min(Math.max((clientY - box.top) / box.height, 0), 1),
    };
  }

  function setBandChannel(ch: number, v: number) {
    setColorMix((m) => {
      const next: ColorMix = { ...m, [band]: [...m[band]] as [number, number, number] };
      next[band][ch] = v;
      return next;
    });
  }

  const drawn = drag ? normalizeRect(drag) : null;
  const hasDrawnCrop = drawn && drawn.width > 0.02 && drawn.height > 0.02;
  const dirty = JSON.stringify(edits) !== JSON.stringify(saved);
  const allNeutral =
    isNeutral(adj) &&
    rotation === 0 &&
    !crop &&
    mixIsNeutral(colorMix) &&
    vignette === 0 &&
    distortion === 0 &&
    grain === 0 &&
    grainSize === 0 &&
    denoise === 0 &&
    clarity === 0 &&
    sharpness === 0 &&
    colorTint === 0 &&
    chromeEffect === 0 &&
    chromeBlue === 0 &&
    mistAmount === 0;

  return (
    <div className="editor-overlay">
      <div className="editor-header">
        <button
          className="icon-btn back-btn"
          onClick={onClose}
          disabled={busy}
          title="Back (Esc)"
          aria-label="Back"
        >
          ←
        </button>
      </div>
      <div className="editor-body">
        <div className={`editor-stage editor-stage-${bgMode}`} ref={stageRef}>
        <div className="editor-stage-main">
        {loading && <div className="editor-hint">Loading…</div>}
        {error && <div className="editor-hint">{error}</div>}
        <div className="editor-canvas-wrap" ref={wrapRef} style={{ display: loading || error ? "none" : "inline-block" }}>
          <canvas
            ref={canvasRef}
            className="editor-canvas"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              cursor: cropMode ? "crosshair" : zoomed ? (panDragRef.current ? "grabbing" : "grab") : "default",
            }}
            onMouseDown={(e) => {
              if (cropMode) {
                const p = fractionAt(e.clientX, e.clientY);
                setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
                setDragging(true);
              } else if (zoomed) {
                e.preventDefault();
                panDragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
              }
            }}
            onMouseMove={(e) => {
              if (cropMode) {
                if (dragging && drag) {
                  const p = fractionAt(e.clientX, e.clientY);
                  setDrag({ ...drag, x1: p.x, y1: p.y });
                }
              } else if (panDragRef.current) {
                setPan({ x: e.clientX - panDragRef.current.x, y: e.clientY - panDragRef.current.y });
              }
            }}
            onMouseUp={() => {
              setDragging(false);
              panDragRef.current = null;
            }}
            onMouseLeave={() => {
              panDragRef.current = null;
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
                setPan({ x: dx - dx * target, y: dy - dy * target });
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
            />
          )}
          {!zoomed && <GridLines type={gridOverlay} />}
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
          <button className="btn btn-sm" onClick={() => setRotation((r) => (r + 270) % 360)} disabled={busy}>
            ⟲
          </button>
          <button className="btn btn-sm" onClick={() => setRotation((r) => (r + 90) % 360)} disabled={busy}>
            ⟳
          </button>
          <button
            className={`btn btn-sm${cropMode ? " primary" : ""}`}
            disabled={busy}
            onClick={() => {
              setCropMode((on) => {
                const next = !on;
                if (next && crop) setDrag({ x0: crop.x, y0: crop.y, x1: crop.x + crop.width, y1: crop.y + crop.height });
                else if (next) setDrag(null);
                return next;
              });
            }}
          >
            Crop
          </button>
          {cropMode && (
            <>
              <button className="btn btn-sm primary" disabled={!hasDrawnCrop} onClick={() => { setCrop(normalizeRect(drag!)); setCropMode(false); }}>
                Apply
              </button>
              <button className="btn btn-sm" disabled={!crop && !drawn} onClick={() => { setCrop(null); setDrag(null); setCropMode(false); }}>
                Clear
              </button>
            </>
          )}
        </div>

        {/* Light */}
        <div className="editor-section-title">Light</div>
        {/* Live RGB histogram of the current preview, right with the tonal
            controls it responds to. */}
        <canvas ref={histRef} className="editor-histogram" width={256} height={64} />
        <div className="editor-sliders">
          {LIGHT_KEYS.map((k) => (
            <Slider
              key={k}
              label={labelFor(k)}
              value={adj[k]}
              onChange={(v) => setAdj((a) => ({ ...a, [k]: v }))}
              // Exposure maps to +/-2 stops; show the actual EV so the number
              // means something photographic.
              format={k === "exposure" ? (v) => `${v > 0 ? "+" : ""}${((v / 100) * 2).toFixed(2)} EV` : undefined}
            />
          ))}
        </div>

        {/* Color */}
        <div className="editor-section-title">Color</div>
        <div className="editor-sliders">
          {COLOR_KEYS.map((k) => (
            <Slider key={k} label={labelFor(k)} value={adj[k]} onChange={(v) => setAdj((a) => ({ ...a, [k]: v }))} />
          ))}
          {/* Fuji in-camera colour depth options. */}
          <Slider label="Color chrome" value={chromeEffect} onChange={setChromeEffect} min={0} />
          <Slider label="Chrome blue" value={chromeBlue} onChange={setChromeBlue} min={0} />
        </div>

        {/* Color mixer */}
        <div className="editor-section-title">Color mixer</div>
        <div className="mixer-bands">
          {COLOR_BANDS.map((b) => (
            <button
              key={b}
              className={`mixer-band${band === b ? " active" : ""}${!colorMix[b].every((v) => v === 0) ? " edited" : ""}`}
              style={{ background: BAND_SWATCH[b] }}
              title={b}
              onClick={() => setBand(b)}
            />
          ))}
        </div>
        <div className="editor-sliders">
          {MIX_CHANNELS.map(([ch, lbl]) => (
            <Slider key={ch} label={lbl} value={colorMix[band][ch]} onChange={(v) => setBandChannel(ch, v)} />
          ))}
        </div>

        {/* Detail */}
        <div className="editor-section-title">Detail</div>
        <div className="editor-sliders">
          <Slider label="Clarity" value={clarity} onChange={setClarity} />
          <Slider label="Sharpness" value={sharpness} onChange={setSharpness} />
          <Slider label="Denoise" value={denoise} onChange={setDenoise} min={0} />
        </div>

        {/* Lens / effects */}
        <div className="editor-section-title">Lens &amp; effects</div>
        <div className="editor-sliders">
          <Slider label="Distortion" value={distortion} onChange={setDistortion} />
          <Slider label="Vignette" value={vignette} onChange={setVignette} />
          <Slider label="Mist" value={mistAmount} onChange={setMistAmount} min={0} />
          <Slider label="Grain" value={grain} onChange={setGrain} min={0} />
          <Slider label="Grain size" value={grainSize} onChange={setGrainSize} min={0} />
        </div>

        {/* Presets */}
        <div className="editor-section-title">Presets</div>
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

        <div className="editor-footer">
          {(saveEdits.isError || saveCopy.isError) && (
            <p className="editor-footer-error">{((saveEdits.error || saveCopy.error) as Error).message}</p>
          )}
          <div className="editor-footer-secondary">
            <button
              className="btn ghost btn-sm"
              disabled={allNeutral}
              onClick={() => {
                setAdj(NEUTRAL);
                setRotation(0);
                setCrop(null);
                setColorMix(neutralMix());
                setVignette(0);
                setDistortion(0);
                setGrain(0);
                setGrainSize(0);
                setDenoise(0);
                setClarity(0);
                setSharpness(0);
                setColorTint(0);
                setChromeEffect(0);
                setChromeBlue(0);
                setMistAmount(0);
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

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { CropBox, ImageOut } from "../api/types";
import {
  ADJUSTMENT_DEFS,
  adjustmentsFromImage,
  applyAdjustments,
  applyDistortion,
  applyGrain,
  clarity as clarityPass,
  unsharp,
  BAND_SWATCH,
  COLOR_BANDS,
  editsFromImage,
  isNeutral,
  mixIsNeutral,
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

// Working resolution for the live preview. Full original res isn't feasible for
// a per-pixel JS pass on every slider move; 2048 keeps zoom sharp while staying
// interactive. The saved/exported render is always full original resolution.
const MAX_PX = 2048;
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
  const stroke = "rgba(255,255,255,0.55)";
  const line = (x1: number, y1: number, x2: number, y2: number, i: number) => (
    <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={0.4} vectorEffect="non-scaling-stroke" />
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
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
}) {
  return (
    <label className="editor-slider">
      <span className="editor-slider-head">
        <span>{label}</span>
        <span className="editor-slider-val">{value > 0 ? `+${value}` : value}</span>
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseRef = useRef<ImageData | null>(null); // raw pixels (no edits)
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null); // base drawn, for rotation
  const stageRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panDragRef = useRef<{ x: number; y: number } | null>(null);
  // Cache the distortion-corrected base so it's only recomputed when the
  // distortion slider changes, not on every tonal tweak.
  const distortRef = useRef<{ amount: number; canvas: HTMLCanvasElement } | null>(null);

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
  // Scroll/pinch to zoom (toward cursor), drag to pan - same as the lightbox.
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const MAX_ZOOM = 6;
  const zoomed = scale > 1.001;

  function resetZoom() {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }

  // Compose: rotate + crop the raw base, then run tonal/colour/vignette on the
  // resulting (final) frame - same order as the backend, so preview == save.
  function drawPreview(
    px: Adjustments & { colorMix: ColorMix; vignette: number; colorTint: number },
    rot: number,
    cr: CropBox | null,
    cropping: boolean,
    dist: number,
    dn: number,
    cl: number,
    sp: number,
    gr: number,
    gsz: number
  ) {
    const base = baseRef.current;
    const baseCanvas = baseCanvasRef.current;
    const canvas = canvasRef.current;
    if (!base || !baseCanvas || !canvas) return;

    // Lens distortion (geometric) is applied to the base first, cached so tonal
    // tweaks don't re-run the per-pixel remap.
    let srcCanvas = baseCanvas;
    if (dist) {
      if (!distortRef.current || distortRef.current.amount !== dist) {
        const dImg = applyDistortion(base, dist);
        const dc = document.createElement("canvas");
        dc.width = base.width;
        dc.height = base.height;
        dc.getContext("2d")!.putImageData(dImg, 0, 0);
        distortRef.current = { amount: dist, canvas: dc };
      }
      srcCanvas = distortRef.current.canvas;
    }

    const w0 = base.width;
    const h0 = base.height;
    const swap = rot % 180 !== 0;
    const rw = swap ? h0 : w0;
    const rh = swap ? w0 : h0;
    const rotc = document.createElement("canvas");
    rotc.width = rw;
    rotc.height = rh;
    const rctx = rotc.getContext("2d")!;
    rctx.translate(rw / 2, rh / 2);
    rctx.rotate((rot * Math.PI) / 180);
    rctx.drawImage(srcCanvas, -w0 / 2, -h0 / 2);

    let sx = 0;
    let sy = 0;
    let sw = rw;
    let sh = rh;
    let fw = rw;
    let fh = rh;
    if (cr && !cropping) {
      sx = cr.x * rw;
      sy = cr.y * rh;
      sw = Math.max(1, cr.width * rw);
      sh = Math.max(1, cr.height * rh);
      fw = Math.round(sw);
      fh = Math.round(sh);
    }
    const frame = document.createElement("canvas");
    frame.width = fw;
    frame.height = fh;
    const fctx = frame.getContext("2d")!;
    // Denoise: a light Gaussian blur, scaled to frame size to roughly match the
    // backend render.
    if (dn > 0) {
      const radius = (dn / 100) * (Math.max(fw, fh) / 600);
      if (radius > 0.1) fctx.filter = `blur(${radius}px)`;
    }
    fctx.drawImage(rotc, sx, sy, sw, sh, 0, 0, fw, fh);
    fctx.filter = "none";

    // Detail (spatial) before the tonal pass, matching the backend order.
    let work = fctx.getImageData(0, 0, fw, fh);
    if (cl) work = clarityPass(work, Math.max(3, Math.max(fw, fh) / 60), (cl / 100) * 0.9);
    if (sp) work = unsharp(work, Math.max(0.6, Math.max(fw, fh) / 1500), (sp / 100) * 1.2);
    const out = fctx.createImageData(fw, fh);
    applyAdjustments(work.data, out.data, px, fw, fh);
    if (gr > 0) applyGrain(out, gr, gsz);
    canvas.width = fw;
    canvas.height = fh;
    canvas.getContext("2d")!.putImageData(out, 0, 0);
  }

  useEffect(() => {
    let cancelled = false;
    let objUrl: string | null = null;
    setLoading(true);
    setError(null);
    fetch(api.images.basePreviewUrl(image.id))
      .then((r) => {
        if (!r.ok) throw new Error(`preview ${r.status}`);
        return r.blob();
      })
      .then(
        (blob) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            objUrl = URL.createObjectURL(blob);
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error("decode failed"));
            im.src = objUrl;
          })
      )
      .then((im) => {
        if (cancelled) return;
        const scale = Math.min(1, MAX_PX / Math.max(im.naturalWidth, im.naturalHeight));
        const w = Math.max(1, Math.round(im.naturalWidth * scale));
        const h = Math.max(1, Math.round(im.naturalHeight * scale));
        const bc = document.createElement("canvas");
        bc.width = w;
        bc.height = h;
        const bctx = bc.getContext("2d")!;
        bctx.drawImage(im, 0, 0, w, h);
        baseRef.current = bctx.getImageData(0, 0, w, h);
        baseCanvasRef.current = bc;
        setLoading(false);
        setReady(true);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(`Couldn't load the photo for editing: ${(e as Error).message}`);
          setLoading(false);
        }
      })
      .finally(() => {
        if (objUrl) URL.revokeObjectURL(objUrl);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image.id]);

  useEffect(() => {
    if (!ready) return;
    const raf = requestAnimationFrame(() =>
      drawPreview(
        { ...adj, colorMix, vignette, colorTint },
        rotation,
        crop,
        cropMode,
        distortion,
        denoise,
        clarity,
        sharpness,
        grain,
        grainSize
      )
    );
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ready,
    adj,
    colorMix,
    vignette,
    colorTint,
    distortion,
    grain,
    grainSize,
    denoise,
    clarity,
    sharpness,
    rotation,
    crop,
    cropMode,
  ]);

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
  };

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      onClose();
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
    colorTint === 0;

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
        <div className="editor-sliders">
          {LIGHT_KEYS.map((k) => (
            <Slider key={k} label={labelFor(k)} value={adj[k]} onChange={(v) => setAdj((a) => ({ ...a, [k]: v }))} />
          ))}
        </div>

        {/* Color */}
        <div className="editor-section-title">Color</div>
        <div className="editor-sliders">
          {COLOR_KEYS.map((k) => (
            <Slider key={k} label={labelFor(k)} value={adj[k]} onChange={(v) => setAdj((a) => ({ ...a, [k]: v }))} />
          ))}
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

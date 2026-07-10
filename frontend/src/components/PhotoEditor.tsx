import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { CropBox, ImageOut } from "../api/types";
import {
  ADJUSTMENT_DEFS,
  adjustmentsFromImage,
  applyAdjustments,
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

const MAX_PX = 1400;
const LIGHT_KEYS: (keyof Adjustments)[] = ["exposure", "contrast", "highlights", "shadows"];
const COLOR_KEYS: (keyof Adjustments)[] = ["temperature", "tint", "saturation"];
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

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="editor-slider">
      <span className="editor-slider-head">
        <span>{label}</span>
        <span className="editor-slider-val">{value > 0 ? `+${value}` : value}</span>
      </span>
      <input
        type="range"
        min={-100}
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

  const saved = editsFromImage(image);
  const [adj, setAdj] = useState<Adjustments>(() => adjustmentsFromImage(image));
  const [rotation, setRotation] = useState(saved.rotation);
  const [crop, setCrop] = useState<CropBox | null>(saved.crop);
  const [colorMix, setColorMix] = useState<ColorMix>(saved.colorMix);
  const [vignette, setVignette] = useState(saved.vignette);
  const [band, setBand] = useState<ColorBand>("red");
  const [cropMode, setCropMode] = useState(false);
  const [drag, setDrag] = useState<DragRect | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Compose: rotate + crop the raw base, then run tonal/colour/vignette on the
  // resulting (final) frame - same order as the backend, so preview == save.
  function drawPreview(px: Adjustments & { colorMix: ColorMix; vignette: number }, rot: number, cr: CropBox | null, cropping: boolean) {
    const base = baseRef.current;
    const baseCanvas = baseCanvasRef.current;
    const canvas = canvasRef.current;
    if (!base || !baseCanvas || !canvas) return;

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
    rctx.drawImage(baseCanvas, -w0 / 2, -h0 / 2);

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
    fctx.drawImage(rotc, sx, sy, sw, sh, 0, 0, fw, fh);

    const srcData = fctx.getImageData(0, 0, fw, fh);
    const out = fctx.createImageData(fw, fh);
    applyAdjustments(srcData.data, out.data, px, fw, fh);
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
    const raf = requestAnimationFrame(() => drawPreview({ ...adj, colorMix, vignette }, rotation, crop, cropMode));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, adj, colorMix, vignette, rotation, crop, cropMode]);

  const edits: ImageEdits = { ...adj, rotation, crop, colorMix, vignette };

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
  const allNeutral = isNeutral(adj) && rotation === 0 && !crop && mixIsNeutral(colorMix) && vignette === 0;

  return (
    <div className="editor-overlay">
      <button className="editor-close" onClick={onClose} disabled={busy} title="Close (Esc)" aria-label="Close editor">
        ✕
      </button>
      <div className="editor-stage">
        {loading && <div className="editor-hint">Loading…</div>}
        {error && <div className="editor-hint">{error}</div>}
        <div className="editor-canvas-wrap" style={{ display: loading || error ? "none" : "inline-block" }}>
          <canvas
            ref={canvasRef}
            className="editor-canvas"
            style={{ cursor: cropMode ? "crosshair" : "default" }}
            onMouseDown={(e) => {
              if (!cropMode) return;
              const p = fractionAt(e.clientX, e.clientY);
              setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
              setDragging(true);
            }}
            onMouseMove={(e) => {
              if (!cropMode || !dragging || !drag) return;
              const p = fractionAt(e.clientX, e.clientY);
              setDrag({ ...drag, x1: p.x, y1: p.y });
            }}
            onMouseUp={() => setDragging(false)}
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
        </div>
      </div>

      <div className="editor-panel">
        <h3 className="section-title" style={{ marginBottom: 2 }}>
          Edit
        </h3>
        <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 4px" }}>
          Non-destructive. Save updates this photo; Save copy makes a new edited photo.
        </p>

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

        {/* Lens / effects */}
        <div className="editor-section-title">Lens</div>
        <div className="editor-sliders">
          <Slider label="Vignette" value={vignette} onChange={setVignette} />
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
              }}
            >
              Reset all
            </button>
            <button className="btn ghost btn-sm" onClick={onClose} disabled={busy}>
              Cancel
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
  );
}

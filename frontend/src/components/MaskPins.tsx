import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import type { MaskDef, SubMask } from "../utils/adjustments";

// One numbered pin per mask that has a place on the photo, so a mask can be
// found and picked on the picture itself - the number is the one its row in
// the list carries. Drawn over the canvas like MaskOverlay (an SVG in a
// 0..100 viewBox stretched over the framed image, carrying the zoom/pan
// transform), but each pin is drawn in its own uniform space so it stays a
// round dot of the same size on a 3:2 photo and at 400 %.
//
// Where a pin sits: a radial's centre, a linear's midpoint, the middle of a
// brush's strokes, a subject's centroid (read once from its stored region).
// A luminance, colour or edge mask has no place of its own - its row in the
// list is its handle, and it gets no pin.
const PIN_R = 1.1; // x-units of the viewBox at zoom 1

type Pt = { x: number; y: number };

function placeOf(sub: SubMask | undefined, centroids: Map<string, Pt>): Pt | null {
  if (!sub) return null;
  const p = sub.parameters;
  const num = (k: string, d: number) => (typeof p[k] === "number" ? (p[k] as number) : d);
  switch (sub.type) {
    case "radial":
      return { x: num("center_x", 0.5), y: num("center_y", 0.5) };
    case "linear":
      return { x: (num("start_x", 0.5) + num("end_x", 0.5)) / 2, y: (num("start_y", 0.2) + num("end_y", 0.8)) / 2 };
    case "brush": {
      const strokes = Array.isArray(p.strokes) ? (p.strokes as number[][]) : [];
      let n = 0;
      let sx = 0;
      let sy = 0;
      for (const s of strokes) {
        // Erasing dabs (flag bit 2, masks._ERASE) take away; they say nothing
        // about where the mask is.
        if (((s[3] ?? 0) & 2) !== 0) continue;
        sx += s[0] ?? 0;
        sy += s[1] ?? 0;
        n++;
      }
      return n ? { x: sx / n, y: sy / n } : null;
    }
    case "semantic":
      return centroids.get(sub.id) ?? null;
    default:
      return null;
  }
}

// The centroid of a subject mask's stored PNG, from a 32x32 rendering of it:
// one decode per sub-mask id, kept for the editor's lifetime.
function useCentroids(masks: MaskDef[]): Map<string, Pt> {
  const cache = useRef(new Map<string, Pt>());
  const pending = useRef(new Set<string>());
  const [, bump] = useState(0);
  useEffect(() => {
    for (const m of masks) {
      const sub = m.sub_masks[0];
      if (!sub || sub.type !== "semantic") continue;
      const png = typeof sub.parameters.mask === "string" ? sub.parameters.mask : "";
      if (!png || cache.current.has(sub.id) || pending.current.has(sub.id)) continue;
      pending.current.add(sub.id);
      const img = new Image();
      img.onload = () => {
        const N = 32;
        const cv = document.createElement("canvas");
        cv.width = N;
        cv.height = N;
        const ctx = cv.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, N, N);
        const d = ctx.getImageData(0, 0, N, N).data;
        let w = 0;
        let sx = 0;
        let sy = 0;
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < N; x++) {
            const v = d[(y * N + x) * 4];
            w += v;
            sx += v * (x + 0.5);
            sy += v * (y + 0.5);
          }
        }
        if (w > 0) cache.current.set(sub.id, { x: sx / w / N, y: sy / w / N });
        pending.current.delete(sub.id);
        bump((n) => n + 1);
      };
      img.onerror = () => pending.current.delete(sub.id);
      img.src = `data:image/png;base64,${png}`;
    }
  }, [masks]);
  return cache.current;
}

function MaskPinsImpl({
  masks,
  selectedId,
  aspect = 1,
  zoom = 1,
  style,
  busy = false,
  onPick,
}: {
  masks: MaskDef[];
  selectedId: string | null;
  // Canvas width / height: a pin is drawn uniformly by scaling y by it.
  aspect?: number;
  // The stage's zoom, so a pin keeps its size when the picture grows.
  zoom?: number;
  style?: CSSProperties;
  // A gesture is in flight: the pins step out of the pointer's way.
  busy?: boolean;
  onPick: (id: string) => void;
}) {
  const centroids = useCentroids(masks);
  return (
    <svg
      className={`mask-pins${busy ? " is-busy" : ""}`}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={style}
      aria-hidden
    >
      {masks.map((m, i) => {
        const at = placeOf(m.sub_masks[0], centroids);
        if (!at) return null;
        const k = 1 / Math.max(0.25, zoom);
        return (
          <g
            key={m.id}
            className={`mask-pin${m.id === selectedId ? " is-selected" : ""}${m.visible ? "" : " is-off"}`}
            transform={`translate(${at.x * 100} ${at.y * 100}) scale(${k} ${k * aspect})`}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onPick(m.id);
            }}
          >
            <title>{m.name}</title>
            <circle r={PIN_R} className="mask-pin-dot" vectorEffect="non-scaling-stroke" />
            <text className="mask-pin-num" textAnchor="middle" dominantBaseline="central" fontSize={PIN_R * 1.25}>
              {i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function sameStyle(a: CSSProperties | undefined, b: CSSProperties | undefined): boolean {
  if (!a || !b) return a === b;
  return a.transform === b.transform && a.transformOrigin === b.transformOrigin;
}

export const MaskPins = memo(
  MaskPinsImpl,
  (a, b) =>
    a.masks === b.masks &&
    a.selectedId === b.selectedId &&
    a.aspect === b.aspect &&
    a.zoom === b.zoom &&
    a.busy === b.busy &&
    a.onPick === b.onPick &&
    sameStyle(a.style, b.style)
);

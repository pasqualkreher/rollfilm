import { useRef, useState } from "react";
import { pchipSample } from "../utils/curveConvert";

// A square 0..255 -> 0..255 tone-curve editor. Points live on the same grid the
// backend expects (see PointCurves / Curve in utils/adjustments.ts). SVG y is
// inverted, so value 255 draws at the top. All editing is immutable: every
// change hands a fresh points array back through onChange; the parent owns the
// state and writes it into adj.point_curves[channel].

type Point = [number, number];

export type CurveChannelKey = "luma" | "red" | "green" | "blue";

interface Props {
  points: Point[];
  // Stroke colour for the curve + control dots (a CSS colour or var()).
  color: string;
  onChange: (points: Point[]) => void;
  // Histogram bins of the current preview (see computeHistBins in PhotoEditor:
  // [R, G, B, luma]), drawn behind the grid so the curve can be shaped against
  // the tones the photo actually has.
  histogram?: Uint32Array[] | null;
  // Channel being edited - selects which of those bin sets to draw.
  channel?: CurveChannelKey;
  // Input value (0..255) under the on-image picker, drawn as a vertical marker.
  // null when the picker is off or the pointer isn't over the photo.
  marker?: number | null;
}

// Grid extent: values run 0..255 on both axes.
const N = 255;
// Control-point cap. The backend keeps only the first 16 (develop.
// _norm_point_curves), so refusing the 17th here beats silently losing it.
export const MAX_CURVE_POINTS = 16;
// Which histogram bin array belongs to which channel tab.
const HIST_BIN: Record<CurveChannelKey, number> = { red: 0, green: 1, blue: 2, luma: 3 };
// Resolution the curve is drawn at. PCHIP is evaluated, not approximated, so
// this only has to be fine enough to look smooth at panel size.
const PATH_STEPS = 128;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// The drawn curve IS the curve the backend renders: monotone cubic (PCHIP),
// evaluated with the shared helper that mirrors develop_color._pchip_lut. The
// editor used to draw a Catmull-Rom lookalike, which bulged away from the real
// result between points and could overshoot outside the 0..255 box.
function curvePath(pts: Point[]): string {
  if (pts.length < 2) return "";
  const xs = Array.from({ length: PATH_STEPS + 1 }, (_, i) => (i * N) / PATH_STEPS);
  const ys = pchipSample(pts, xs);
  return xs.map((x, i) => `${i ? "L" : "M"} ${x.toFixed(2)} ${(N - ys[i]).toFixed(2)}`).join(" ");
}

// Filled histogram silhouette across the plot, sqrt-scaled like the panel
// histogram so shadow/highlight detail stays readable next to a midtone peak.
// Bins 0 and 255 are left out of the max so a clipping spike doesn't flatten
// everything else.
function histPath(bins: Uint32Array): string {
  let max = 1;
  for (let v = 1; v < 255; v++) if (bins[v] > max) max = bins[v];
  let d = `M 0 ${N}`;
  for (let v = 0; v < 256; v++) {
    const h = Math.min(1, Math.sqrt(bins[v] / max)) * N;
    d += ` L ${((v / 255) * N).toFixed(2)} ${(N - h).toFixed(2)}`;
  }
  return `${d} L ${N} ${N} Z`;
}

export function CurveEditor({ points, color, onChange, histogram, channel = "luma", marker }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Index of the control point currently being dragged, or null.
  const dragRef = useRef<number | null>(null);
  // Last pointerdown on a control point, for manual double-click detection: the
  // SVG's pointer capture swallows the browser's dblclick, so we detect it here.
  const lastTap = useRef<{ i: number; t: number } | null>(null);
  // Selected point: highlighted, and the target for arrow-key nudges / Delete.
  const [selected, setSelected] = useState<number | null>(null);

  // Pointer (client) coords -> data coords (0..255, y already un-inverted).
  function toData(clientX: number, clientY: number): Point {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * N;
    const y = N - ((clientY - rect.top) / rect.height) * N;
    return [clamp(Math.round(x), 0, N), clamp(Math.round(y), 0, N)];
  }

  // Move point `i` to (x, y), clamping x so the points stay ordered and the
  // curve stays a function. Endpoints may slide along their axis - that's how
  // the black/white clipping point is set (the backend holds the curve flat
  // outside the outermost points).
  function movePoint(i: number, x: number, y: number): Point[] {
    const lo = i === 0 ? 0 : points[i - 1][0] + 1;
    const hi = i === points.length - 1 ? N : points[i + 1][0] - 1;
    const nx = clamp(x, Math.min(lo, hi), Math.max(lo, hi));
    return points.map((pt, idx) => (idx === i ? ([nx, clamp(y, 0, N)] as Point) : pt));
  }

  function moveActive(clientX: number, clientY: number, lockX: boolean) {
    const i = dragRef.current;
    if (i == null || i < 0 || i >= points.length) return;
    const [dx, dy] = toData(clientX, clientY);
    // Shift locks the x position, for adjusting a point's output value alone.
    const next = movePoint(i, lockX ? points[i][0] : dx, dy);
    // A pointermove that rounds to the same grid cell is not an edit - skipping
    // it keeps identical states from re-triggering a preview render.
    if (next[i][0] === points[i][0] && next[i][1] === points[i][1]) return;
    onChange(next);
  }

  // Add a control point where the user clicked and hand back its index, so the
  // same gesture that creates a point can go straight on to dragging it.
  function addPoint(clientX: number, clientY: number): number | null {
    if (points.length >= MAX_CURVE_POINTS) return null;
    const [x, y] = toData(clientX, clientY);
    let insert = 1;
    while (insert < points.length && points[insert][0] <= x) insert++;
    insert = clamp(insert, 1, points.length - 1);
    const lo = points[insert - 1][0] + 1;
    const hi = points[insert][0] - 1;
    if (lo > hi) return null; // neighbours are adjacent - no room for a point here
    const nx = clamp(x, lo, hi);
    onChange([...points.slice(0, insert), [nx, y] as Point, ...points.slice(insert)]);
    return insert;
  }

  function removePoint(i: number) {
    // Never remove the two endpoints, and always keep at least two points.
    if (i <= 0 || i >= points.length - 1 || points.length <= 2) return;
    setSelected(null);
    onChange(points.filter((_, idx) => idx !== i));
  }

  // Start dragging point `i`. Focusing the plot (without scrolling the panel)
  // is what makes the arrow-key nudges reachable straight after a drag.
  function grab(i: number, pointerId: number) {
    setSelected(i);
    dragRef.current = i;
    svgRef.current!.setPointerCapture(pointerId);
    svgRef.current!.focus({ preventScroll: true });
  }

  function endDrag(pointerId: number) {
    dragRef.current = null;
    const svg = svgRef.current;
    if (svg && svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
  }

  // Arrow keys nudge the selected point (Shift = x10), Delete removes it. The
  // events are stopped so the editor's global Up/Down handler doesn't also jump
  // focus into the slider list.
  function onKeyDown(e: React.KeyboardEvent) {
    const i = selected;
    if (i == null || i >= points.length) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      removePoint(i);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(movePoint(i, points[i][0] + d[0], points[i][1] + d[1]));
  }

  // The In/Out readout: whichever point the user is working on, else the tone
  // the on-image picker is over.
  const readout =
    selected != null && selected < points.length
      ? { x: points[selected][0], y: points[selected][1] }
      : marker != null
        ? { x: Math.round(marker), y: Math.round(pchipSample(points, [marker])[0]) }
        : null;
  const markerY = marker != null ? pchipSample(points, [marker])[0] : null;
  const bins = histogram?.[HIST_BIN[channel]] ?? null;

  return (
    <div className="curve-editor">
      <svg
        ref={svgRef}
        className="curve-editor-svg"
        viewBox={`0 0 ${N} ${N}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        // Background click (anywhere not on a control point) adds a point and
        // starts dragging it right away - one gesture, like every other editor.
        onPointerDown={(e) => {
          const i = addPoint(e.clientX, e.clientY);
          if (i == null) return;
          grab(i, e.pointerId);
        }}
        onPointerMove={(e) => {
          if (dragRef.current != null) moveActive(e.clientX, e.clientY, e.shiftKey);
        }}
        onPointerUp={(e) => endDrag(e.pointerId)}
        onPointerCancel={(e) => endDrag(e.pointerId)}
        onBlur={() => setSelected(null)}
      >
        {/* Transparent hit surface so clicks on empty area reach onPointerDown. */}
        <rect className="curve-bg" x={0} y={0} width={N} height={N} />
        {/* Histogram of the current preview, behind the grid. */}
        {bins && (
          <path
            className="curve-hist"
            d={histPath(bins)}
            fill={channel === "luma" ? "var(--text-muted)" : color}
          />
        )}
        {/* Quarter grid. */}
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f}>
            <line className="curve-grid-line" x1={f * N} y1={0} x2={f * N} y2={N} vectorEffect="non-scaling-stroke" />
            <line className="curve-grid-line" x1={0} y1={f * N} x2={N} y2={f * N} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {/* Identity diagonal (bottom-left -> top-right in screen space). */}
        <line className="curve-grid-diagonal" x1={0} y1={N} x2={N} y2={0} vectorEffect="non-scaling-stroke" />
        {/* Where the on-image picker is pointing. */}
        {marker != null && markerY != null && (
          <g className="curve-marker">
            <line x1={marker} y1={0} x2={marker} y2={N} vectorEffect="non-scaling-stroke" />
            <circle cx={marker} cy={N - markerY} r={5} vectorEffect="non-scaling-stroke" />
          </g>
        )}
        {/* The curve itself. */}
        <path className="curve-line" d={curvePath(points)} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {/* Control points: a visual dot plus a larger transparent hit target. */}
        {points.map(([x, y], i) => (
          <g key={i}>
            <circle
              className={`curve-point-dot${selected === i ? " selected" : ""}`}
              cx={x}
              cy={N - y}
              r={6}
              fill={color}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              className="curve-point-hit"
              cx={x}
              cy={N - y}
              r={12}
              fill="transparent"
              onPointerDown={(e) => {
                e.stopPropagation(); // don't also add a point
                // Double-tap the same point within 350ms to remove it.
                const prev = lastTap.current;
                if (prev && prev.i === i && e.timeStamp - prev.t < 350) {
                  lastTap.current = null;
                  removePoint(i);
                  return;
                }
                lastTap.current = { i, t: e.timeStamp };
                grab(i, e.pointerId);
              }}
            />
          </g>
        ))}
      </svg>
      {readout && (
        <div className="curve-readout">
          In {readout.x} · Out {readout.y}
        </div>
      )}
    </div>
  );
}

import { useRef } from "react";

// A square 0..255 -> 0..255 tone-curve editor. Points live on the same grid the
// backend expects (see PointCurves / Curve in utils/adjustments.ts). SVG y is
// inverted, so value 255 draws at the top. All editing is immutable: every
// change hands a fresh points array back through onChange; the parent owns the
// state and writes it into adj.point_curves[channel].

type Point = [number, number];

interface Props {
  points: Point[];
  // Stroke colour for the curve + control dots (a CSS colour or var()).
  color: string;
  onChange: (points: Point[]) => void;
}

// Grid extent: values run 0..255 on both axes.
const N = 255;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Catmull-Rom spline -> cubic Bezier path through the (already x-sorted) points,
// in SVG space (y inverted). Endpoints are duplicated so the ends stay put.
function curvePath(pts: Point[]): string {
  if (pts.length < 2) return "";
  const p = pts.map(([x, y]) => [x, N - y] as Point);
  let d = `M ${p[0][0]} ${p[0][1]}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] ?? p[i + 1];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2[0]} ${p2[1]}`;
  }
  return d;
}

export function CurveEditor({ points, color, onChange }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Index of the control point currently being dragged, or null.
  const dragRef = useRef<number | null>(null);
  // Last pointerdown on a control point, for manual double-click detection: the
  // SVG's pointer capture swallows the browser's dblclick, so we detect it here.
  const lastTap = useRef<{ i: number; t: number } | null>(null);

  // Pointer (client) coords -> data coords (0..255, y already un-inverted).
  function toData(clientX: number, clientY: number): Point {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * N;
    const y = N - ((clientY - rect.top) / rect.height) * N;
    return [clamp(Math.round(x), 0, N), clamp(Math.round(y), 0, N)];
  }

  function moveActive(clientX: number, clientY: number) {
    const i = dragRef.current;
    if (i == null || i < 0 || i >= points.length) return;
    const [dx, dy] = toData(clientX, clientY);
    let nx: number;
    if (i === 0 || i === points.length - 1) {
      // Endpoints move vertically only - their x stays pinned (0 / 255).
      nx = points[i][0];
    } else {
      // Interior points clamp between their neighbours so the curve stays a
      // function of x (points never cross, so the array stays sorted).
      nx = clamp(dx, points[i - 1][0] + 1, points[i + 1][0] - 1);
    }
    onChange(points.map((pt, idx) => (idx === i ? ([nx, dy] as Point) : pt)));
  }

  // Add a control point where the user clicked (interior only). Returns nothing;
  // dragging the new point is a separate gesture.
  function addPoint(clientX: number, clientY: number) {
    const [x, y] = toData(clientX, clientY);
    let insert = 1;
    while (insert < points.length && points[insert][0] <= x) insert++;
    insert = clamp(insert, 1, points.length - 1);
    const lo = points[insert - 1][0] + 1;
    const hi = points[insert][0] - 1;
    if (lo > hi) return; // neighbours are adjacent - no room for a point here
    const nx = clamp(x, lo, hi);
    onChange([...points.slice(0, insert), [nx, y] as Point, ...points.slice(insert)]);
  }

  function removePoint(i: number) {
    // Never remove the two endpoints, and always keep at least two points.
    if (i <= 0 || i >= points.length - 1 || points.length <= 2) return;
    onChange(points.filter((_, idx) => idx !== i));
  }

  function endDrag(pointerId: number) {
    dragRef.current = null;
    const svg = svgRef.current;
    if (svg && svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
  }

  return (
    <div className="curve-editor">
      <svg
        ref={svgRef}
        className="curve-editor-svg"
        viewBox={`0 0 ${N} ${N}`}
        // Background click (anywhere not on a control point) adds a point.
        onPointerDown={(e) => addPoint(e.clientX, e.clientY)}
        onPointerMove={(e) => {
          if (dragRef.current != null) moveActive(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => endDrag(e.pointerId)}
        onPointerCancel={(e) => endDrag(e.pointerId)}
      >
        {/* Transparent hit surface so clicks on empty area reach onPointerDown. */}
        <rect className="curve-bg" x={0} y={0} width={N} height={N} />
        {/* Quarter grid. */}
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f}>
            <line className="curve-grid-line" x1={f * N} y1={0} x2={f * N} y2={N} vectorEffect="non-scaling-stroke" />
            <line className="curve-grid-line" x1={0} y1={f * N} x2={N} y2={f * N} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {/* Identity diagonal (bottom-left -> top-right in screen space). */}
        <line className="curve-grid-diagonal" x1={0} y1={N} x2={N} y2={0} vectorEffect="non-scaling-stroke" />
        {/* The curve itself. */}
        <path className="curve-line" d={curvePath(points)} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {/* Control points: a visual dot plus a larger transparent hit target. */}
        {points.map(([x, y], i) => (
          <g key={i}>
            <circle className="curve-point-dot" cx={x} cy={N - y} r={6} fill={color} vectorEffect="non-scaling-stroke" />
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
                dragRef.current = i;
                svgRef.current!.setPointerCapture(e.pointerId);
              }}
            />
          </g>
        ))}
      </svg>
    </div>
  );
}

import { memo, useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import type { SubMask } from "../utils/adjustments";

// Guide + editable handles for the selected mask's spatial sub-mask, drawn over
// the canvas exactly like GridLines: an SVG in a 0..100 viewBox stretched
// (preserveAspectRatio="none") to cover the framed image, so the mask's
// fractional (0..1) params map straight to percent coordinates. It carries the
// canvas zoom/pan transform (via `style`) so handles stay registered with the
// image. Pointer-transparent - hit-testing + dragging live in PhotoEditor; this
// only renders. Luminance / colour / edge masks select by what the pixels are
// rather than by where they are, so there is no shape to draw here: those are
// marked by the render itself (editor-preview's `peek`, thumbnails.paint_mask_peek)
// in the same pink zebra, so both kinds of mask read the same on the photo.
//
// When `mark` is set, every type paints the area it covers with the same pink
// zebra (see ZebraPattern); its own outline and handles draw on top of that:
//
//  - radial : rotated ellipse + centre / 4 edge / 4 corner / rotation handles.
//  - linear : the gradient line + a perpendicular hint + start & end handles,
//             over a zebra that ramps across the band like the render does.
//  - brush  : the painted area, plus a brush-size ring at the pointer
//             (`cursor`) while painting/hovering.
//  - semantic: the found region, through the stored PNG.
//
// `aspect` (canvas width/height) makes the round handles render round on
// non-square images: a viewBox circle is stretched non-uniformly, so handles
// are drawn as ellipses whose y-radius is pre-multiplied by aspect to cancel it.
const HANDLE_R = 1.0; // handle radius in viewBox-x units (grab tolerance is larger, in px)
// Rotation handle sits this far (viewBox units) beyond the ellipse top; mirrors
// PhotoEditor's MASK_ROT_OFF (0.07 fraction) so render + hit-test agree.
const ROT_OFF_VB = 7;
// Stroke sample flag bit for an erasing dab - mirrors masks._ERASE and
// PhotoEditor's BRUSH_ERASE.
const BRUSH_ERASE = 2;

// Every mask's *covered area* is marked with the same pink zebra: diagonal
// candy stripes, the way a video scope marks a region. A flat wash reads as
// part of the photo on a pink sunset or a grey wall; stripes never do, and
// being able to see the picture between them is what lets the boundary be
// judged. One pattern, referenced by every mask type's fill.
const ZEBRA_ID = "mask-zebra";

function ZebraPattern() {
  return (
    <pattern id={ZEBRA_ID} width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="2" height="2" className="mask-zebra-gap" />
      <rect width="1" height="2" className="mask-zebra-bar" />
    </pattern>
  );
}

// Gradient stops tracing the brush dab's own falloff, so the guide softens
// exactly where the render does. `offset` is a fraction of the dab radius:
// opaque out to (1 - feather), then the same smoothstep the field uses, sampled
// at four points because SVG interpolates linearly between stops.
function brushFadeStops(feather: number): [number, number][] {
  const core = 1 - feather;
  const stops: [number, number][] = [[0, 1]];
  if (feather <= 0) return [...stops, [1, 1]];
  stops.push([core, 1]);
  for (let k = 1; k <= 4; k++) {
    const t = 1 - k / 4; // 0.75, 0.5, 0.25, 0
    stops.push([core + (k / 4) * feather, t * t * (3 - 2 * t)]);
  }
  return stops;
}

// Memoised by value: the editor re-renders on every slider frame, and a brush
// mask is one SVG element per stroke sample - thousands of nodes that React
// rebuilt each time although nothing about the mask had changed. The cursor
// and style props are compared by content (the editor makes fresh objects for
// them every render); `sub` by identity, which changes exactly when the mask
// does.
type MaskOverlayProps = Parameters<typeof MaskOverlayImpl>[0];
function sameCursor(a: MaskOverlayProps["cursor"], b: MaskOverlayProps["cursor"]): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.size === b.size;
}
function sameStyle(a: CSSProperties | undefined, b: CSSProperties | undefined): boolean {
  if (!a || !b) return a === b;
  return a.transform === b.transform && a.transformOrigin === b.transformOrigin;
}
export const MaskOverlay = memo(
  MaskOverlayImpl,
  (a, b) =>
    a.sub === b.sub &&
    a.aspect === b.aspect &&
    a.handles === b.handles &&
    a.mark === b.mark &&
    a.dashed === b.dashed &&
    a.cursorSink === b.cursorSink &&
    a.brushSink === b.brushSink &&
    sameCursor(a.cursor, b.cursor) &&
    sameStyle(a.style, b.style)
);

function MaskOverlayImpl({
  sub,
  style,
  aspect = 1,
  cursor = null,
  cursorSink,
  brushSink,
  handles = false,
  mark = true,
  dashed = false,
}: {
  sub: SubMask;
  style?: CSSProperties;
  aspect?: number;
  cursor?: { x: number; y: number; size: number } | null;
  // Where the brush ring's moves arrive from while it is shown: the editor
  // calls every registered mover per pointer move and the ring follows in the
  // DOM, with no render in between. `cursor` still says whether the ring is
  // up (and where it first appeared); its last moved-to position wins over
  // that on a re-render, so the ring never jumps back.
  cursorSink?: Set<(x: number, y: number) => void>;
  // Where a brush stroke's samples arrive while it is being painted: the
  // editor stamps them here the moment the pointer moves and hands them to
  // the edit state in batches (see BRUSH_FLUSH_MS). The overlay's brush
  // canvas paints the live samples at once and skips them again when the
  // batch lands in `sub`, so the guide follows the pointer at pointer rate
  // while the editor re-renders a few times a second.
  brushSink?: Set<(pts: number[][]) => void>;
  // Draw the drag handles - only while editing on the image. The shape's own
  // outline renders either way, so a mask being edited stays locatable.
  handles?: boolean;
  // Paint the zebra over the area the mask covers. Separate from `handles`:
  // the marking answers "what does this cover?" and is asked for by pointing at
  // the mask in the list, while the outline and handles are the editing tools.
  mark?: boolean;
  // Draw the outline dashed - what a "limit to area" shape is drawn as, so a
  // boundary the mask is confined to never reads as the selection itself.
  dashed?: boolean;
}) {
  const ringRef = useRef<SVGEllipseElement | null>(null);
  const ringPosRef = useRef<{ x: number; y: number } | null>(null);
  const ringShown = cursor !== null;
  useEffect(() => {
    if (!ringShown) ringPosRef.current = null;
  }, [ringShown]);
  useEffect(() => {
    if (!cursorSink) return;
    const move = (x: number, y: number) => {
      ringPosRef.current = { x, y };
      const el = ringRef.current;
      if (el) {
        el.setAttribute("cx", String(x * 100));
        el.setAttribute("cy", String(y * 100));
      }
    };
    cursorSink.add(move);
    return () => {
      cursorSink.delete(move);
    };
  }, [cursorSink]);
  const p = sub.parameters;
  const num = (k: string, d: number) => (typeof p[k] === "number" ? (p[k] as number) : d);
  // --- The brush guide is a canvas, painted incrementally --------------------
  // It used to be one SVG <ellipse> per stroke sample inside a luminance
  // <mask>: thousands of nodes React rebuilt and the browser re-rasterised on
  // every render while painting. Here the coverage lives in an offscreen
  // canvas that only ever receives the NEW samples (a redraw from scratch
  // happens when the stroke list shrinks - undo - or the dab falloff
  // changes), and the visible canvas is the zebra cut to that coverage.
  const brushCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const brushStateRef = useRef<{
    coverage: HTMLCanvasElement;
    zebra: HTMLCanvasElement | null;
    painted: number; // samples of `strokes` already on the coverage
    live: number; // samples stamped through the sink, not yet seen in `strokes`
    key: string; // size/feather/aspect the coverage was painted with
  } | null>(null);
  const isBrush = sub.type === "brush";
  const brushStrokes = isBrush && Array.isArray(p.strokes) ? (p.strokes as number[][]) : null;
  const brushFeather = isBrush ? Math.min(1, Math.max(0, num("feather", 50) / 100)) : 0;
  const brushMark = isBrush && mark;
  // Canvas backing store: a fixed long edge stretched over the photo like the
  // SVG viewBox is; the dab radius is `size` of the long edge, so it is the
  // same circle in canvas pixels whatever the aspect.
  const BRUSH_W = aspect >= 1 ? 1200 : Math.round(1200 * aspect);
  const BRUSH_H = aspect >= 1 ? Math.round(1200 / aspect) : 1200;
  const stampDabs = (pts: number[][]) => {
    const st = brushStateRef.current;
    if (!st) return;
    const ctx = st.coverage.getContext("2d")!;
    const long = Math.max(BRUSH_W, BRUSH_H);
    const stops = brushFadeStops(brushFeather);
    for (const s of pts) {
      const x = (s[0] ?? 0) * BRUSH_W;
      const y = (s[1] ?? 0) * BRUSH_H;
      const r = Math.max(1, (s[2] ?? 0.06) * long);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      for (const [offset, alpha] of stops) g.addColorStop(Math.min(1, offset), `rgba(255,255,255,${alpha})`);
      ctx.globalCompositeOperation = ((s[3] ?? 0) & BRUSH_ERASE) !== 0 ? "destination-out" : "source-over";
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  };
  const compositeBrush = () => {
    const st = brushStateRef.current;
    const cv = brushCanvasRef.current;
    if (!st || !cv) return;
    const ctx = cv.getContext("2d")!;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!brushMark) return;
    if (!st.zebra) st.zebra = makeZebra(cv.width, cv.height);
    ctx.drawImage(st.zebra, 0, 0);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(st.coverage, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  };
  useLayoutEffect(() => {
    if (!brushStrokes) return;
    const cv = brushCanvasRef.current;
    if (!cv) return;
    const key = `${BRUSH_W}x${BRUSH_H}:${brushFeather}`;
    let st = brushStateRef.current;
    if (cv.width !== BRUSH_W || cv.height !== BRUSH_H) {
      cv.width = BRUSH_W;
      cv.height = BRUSH_H;
      if (st) st.zebra = null;
    }
    if (!st || st.key !== key || brushStrokes.length < st.painted) {
      const coverage = st?.coverage ?? document.createElement("canvas");
      coverage.width = BRUSH_W;
      coverage.height = BRUSH_H;
      st = { coverage, zebra: st?.zebra ?? null, painted: 0, live: 0, key };
      brushStateRef.current = st;
      stampDabs(brushStrokes);
      st.painted = brushStrokes.length;
    } else {
      // The samples painted live through the sink are the head of what just
      // arrived (same order, same points) - they are not painted twice.
      const fresh = brushStrokes.length - st.painted;
      const skip = Math.min(st.live, fresh);
      if (fresh > skip) stampDabs(brushStrokes.slice(st.painted + skip));
      st.live -= skip;
      st.painted = brushStrokes.length;
    }
    compositeBrush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brushStrokes, brushFeather, brushMark, BRUSH_W, BRUSH_H]);
  useEffect(() => {
    if (!brushSink || !isBrush) return;
    const paint = (pts: number[][]) => {
      const st = brushStateRef.current;
      if (!st) return;
      stampDabs(pts);
      st.live += pts.length;
      compositeBrush();
    };
    brushSink.add(paint);
    return () => {
      brushSink.delete(paint);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brushSink, isBrush, brushFeather, brushMark, BRUSH_W, BRUSH_H]);
  const handle = (x: number, y: number, key: string) => (
    <ellipse key={key} cx={x} cy={y} rx={HANDLE_R} ry={HANDLE_R * aspect} className="mask-handle" vectorEffect="non-scaling-stroke" />
  );

  let shapes: JSX.Element | null = null;

  if (sub.type === "radial") {
    const cx = num("center_x", 0.5) * 100;
    const cy = num("center_y", 0.5) * 100;
    const rx = Math.max(0.5, num("radius_x", 0.25) * 100);
    const ry = Math.max(0.5, num("radius_y", 0.25) * 100);
    const rot = num("rotation", 0);
    const rad = (rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // Rotate a local offset about the centre - same convention as SVG rotate().
    const R = (ox: number, oy: number): [number, number] => [cx + ox * cos - oy * sin, cy + ox * sin + oy * cos];
    const nPt = R(0, -ry);
    const rotPt = R(0, -(ry + ROT_OFF_VB));
    shapes = (
      <>
        <ellipse
          cx={cx}
          cy={cy}
          rx={rx}
          ry={ry}
          transform={rot ? `rotate(${rot} ${cx} ${cy})` : undefined}
          className="mask-overlay-shape"
          fill={mark ? `url(#${ZEBRA_ID})` : "none"}
          vectorEffect="non-scaling-stroke"
        />
        {handles && (
          <>
            {/* rotation stalk from the top of the ellipse to the rotation handle */}
            <line x1={nPt[0]} y1={nPt[1]} x2={rotPt[0]} y2={rotPt[1]} className="mask-overlay-shape mask-overlay-hint" vectorEffect="non-scaling-stroke" />
            {handle(...R(rx, 0), "e")}
            {handle(...R(-rx, 0), "w")}
            {handle(...R(0, -ry), "n")}
            {handle(...R(0, ry), "s")}
            {handle(...R(rx, -ry), "ne")}
            {handle(...R(-rx, -ry), "nw")}
            {handle(...R(rx, ry), "se")}
            {handle(...R(-rx, ry), "sw")}
            {handle(rotPt[0], rotPt[1], "rot")}
            {handle(cx, cy, "c")}
          </>
        )}
      </>
    );
  } else if (sub.type === "linear") {
    // Graduated filter: the gradient runs along start->end; its iso-lines are
    // perpendicular to that axis through start / midpoint / end. The centre line
    // (solid) is the main grab line; the two edge lines (dashed) are the band
    // edges, and their separation is the gradient width (= softness). Each line
    // is drawn well past the frame and clipped by the 0..100 viewBox.
    const sx = num("start_x", 0.5) * 100;
    const sy = num("start_y", 0.2) * 100;
    const ex = num("end_x", 0.5) * 100;
    const ey = num("end_y", 0.8) * 100;
    const mx = (sx + ex) / 2;
    const my = (sy + ey) / 2;
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len; // gradient direction (start -> end)
    const uy = dy / len;
    // Iso-line / arrowhead perpendicular in SCREEN (pixel) space, NOT viewBox: the
    // SVG is stretched non-uniformly (preserveAspectRatio="none") and the backend
    // computes the gradient in pixels, so correct by the aspect ratio (w/h). This
    // keeps the band lines exactly 90 deg to the effect direction (the arrow) on
    // screen and matching the real mask on non-square images.
    let qx = -dy / aspect;
    let qy = dx * aspect;
    const qlen = Math.hypot(qx, qy) || 1;
    qx /= qlen;
    qy /= qlen;
    const L = 160;
    // A direction arrow along the axis, pointing toward `end` (the side where the
    // gradient reaches full effect), so the mask's direction is obvious at a glance.
    const aFromX = mx + ux * 3;
    const aFromY = my + uy * 3;
    const aTipX = mx + ux * 14;
    const aTipY = my + uy * 14;
    const aHead = `${aTipX - ux * 4.5 - qx * 3},${aTipY - uy * 4.5 - qy * 3} ${aTipX},${aTipY} ${aTipX - ux * 4.5 + qx * 3},${aTipY - uy * 4.5 + qy * 3}`;
    const isoLine = (cx0: number, cy0: number, key: string, cls: string) => (
      <line key={key} x1={cx0 - qx * L} y1={cy0 - qy * L} x2={cx0 + qx * L} y2={cy0 + qy * L} className={cls} vectorEffect="non-scaling-stroke" />
    );
    // The band shown as the zebra it selects, ramping 0 -> 1 across it exactly
    // like the render: a full-frame zebra rect behind an SVG mask whose only
    // content is the same gradient. The gradient axis is corrected for the
    // viewBox's non-uniform stretch the same way the iso-lines above are - the
    // backend measures the ramp in pixels, so an uncorrected SVG gradient would
    // lean the wrong way on every non-square photo. `k` puts the stops back on
    // the start/end points after that correction (k = 1 on a square image).
    const a2 = aspect * aspect;
    const denom = a2 * a2 * dx * dx + dy * dy || 1;
    const k = (a2 * dx * dx + dy * dy) / denom;
    const gradId = `mask-linear-ramp-${sub.id}`;
    const maskId = `mask-linear-${sub.id}`;
    shapes = (
      <>
        <defs>
          <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1={sx} y1={sy} x2={sx + a2 * dx * k} y2={sy + dy * k}>
            <stop offset="0%" stopColor="#000" />
            <stop offset="100%" stopColor="#fff" />
          </linearGradient>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
            <rect x="0" y="0" width="100" height="100" fill={`url(#${gradId})`} />
          </mask>
        </defs>
        {mark && <rect x="0" y="0" width="100" height="100" fill={`url(#${ZEBRA_ID})`} mask={`url(#${maskId})`} />}
        {isoLine(sx, sy, "edge-s", "mask-overlay-shape mask-overlay-hint")}
        {isoLine(ex, ey, "edge-e", "mask-overlay-shape mask-overlay-hint")}
        {isoLine(mx, my, "center", "mask-overlay-shape")}
        {/* direction arrow toward the full-effect side */}
        <line x1={aFromX} y1={aFromY} x2={aTipX} y2={aTipY} className="mask-overlay-shape" vectorEffect="non-scaling-stroke" />
        <polyline points={aHead} fill="none" className="mask-overlay-shape" vectorEffect="non-scaling-stroke" />
        {handles && (
          <>
            {handle(mx, my, "center")}
            {handle(sx, sy, "start")}
            {handle(ex, ey, "end")}
          </>
        )}
      </>
    );
  } else if (sub.type === "brush") {
    const strokes = Array.isArray(p.strokes) ? (p.strokes as number[][]) : [];
    const feather = Math.min(1, Math.max(0, num("feather", 50) / 100));
    // A dab is a circle of `size` * the image's LONG edge in pixels (matching
    // masks._brush_field). The viewBox is stretched non-uniformly onto the image,
    // so that circle is an ellipse here - and the two radii differ by the aspect.
    // The old code drew r = size * 50 for both, which on a 3:2 photo was half the
    // real width and a third of the real height: what you painted was not what
    // got rendered.
    const rx = (s: number) => Math.max(0.3, s * 100 * (aspect >= 1 ? 1 : 1 / aspect));
    const ry = (s: number) => Math.max(0.3, s * 100 * (aspect >= 1 ? aspect : 1));
    // The painted area itself is on the canvas beside this SVG (see the brush
    // hooks above); the SVG keeps the ring, which needs the viewBox stretch.
    void feather;
    void strokes;
    shapes = (
      <>
        {cursor && (
          <ellipse
            ref={ringRef}
            cx={(ringPosRef.current ?? cursor).x * 100}
            cy={(ringPosRef.current ?? cursor).y * 100}
            rx={rx(cursor.size)}
            ry={ry(cursor.size)}
            className="mask-brush-ring"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </>
    );
  } else if (sub.type === "semantic") {
    // A found region has no shape to trace, so it shows as the region itself:
    // the stored PNG used as a luminance mask over a translucent wash, the way
    // every editor shows a selection. SVG's <mask> is luminance-based by
    // definition, which is exactly what the stored grayscale PNG is - no colour
    // conversion, and the soft edges come through as soft.
    const png = typeof p.mask === "string" ? p.mask : "";
    if (!png || !mark) return null; // a found region IS its marking - no outline to keep
    const id = `mask-region-${sub.id}`;
    shapes = (
      <>
        <defs>
          <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
            <image href={`data:image/png;base64,${png}`} x="0" y="0" width="100" height="100" preserveAspectRatio="none" />
          </mask>
        </defs>
        <rect x="0" y="0" width="100" height="100" fill={`url(#${ZEBRA_ID})`} mask={`url(#${id})`} />
      </>
    );
  } else {
    return null;
  }

  if (isBrush) {
    return (
      <div className={`mask-overlay mask-overlay-brush${dashed ? " mask-overlay-dashed" : ""}`} style={style}>
        <canvas ref={brushCanvasRef} className="mask-brush-canvas" width={BRUSH_W} height={BRUSH_H} />
        <svg className="mask-brush-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          {shapes}
        </svg>
      </div>
    );
  }
  return (
    <svg
      className={`mask-overlay${dashed ? " mask-overlay-dashed" : ""}`}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={style}
    >
      <defs>
        <ZebraPattern />
      </defs>
      {shapes}
    </svg>
  );
}

// The zebra as pixels, for the brush canvas: the same pink candy stripes the
// SVG pattern draws (ZebraPattern), one stripe = 1% of the picture's width,
// so the two kinds of marking read alike side by side.
function makeZebra(w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "rgba(255, 45, 149, 0.12)";
  ctx.fillRect(0, 0, w, h);
  const unit = w / 100;
  ctx.strokeStyle = "rgba(255, 45, 149, 0.55)";
  ctx.lineWidth = unit;
  ctx.beginPath();
  // 45-degree lines, period 2 units, covering the whole rectangle.
  const period = 2 * unit * Math.SQRT2;
  for (let d = -h; d < w + h; d += period) {
    ctx.moveTo(d, 0);
    ctx.lineTo(d - h, h);
  }
  ctx.stroke();
  return cv;
}

import type { CSSProperties } from "react";
import type { SubMask } from "../utils/adjustments";

// Guide + editable handles for the selected mask's spatial sub-mask, drawn over
// the canvas exactly like GridLines: an SVG in a 0..100 viewBox stretched
// (preserveAspectRatio="none") to cover the framed image, so the mask's
// fractional (0..1) params map straight to percent coordinates. It carries the
// canvas zoom/pan transform (via `style`) so handles stay registered with the
// image. Pointer-transparent - hit-testing + dragging live in PhotoEditor; this
// only renders. Luminance/colour masks have no spatial shape, so nothing draws.
//
//  - radial : rotated ellipse + centre / 4 edge / 4 corner / rotation handles.
//  - linear : the gradient line + a perpendicular hint + start & end handles.
//  - brush  : a translucent dot per stroke point + a brush-size ring at the
//             pointer (`cursor`) while painting/hovering.
//
// `aspect` (canvas width/height) makes the round handles render round on
// non-square images: a viewBox circle is stretched non-uniformly, so handles
// are drawn as ellipses whose y-radius is pre-multiplied by aspect to cancel it.
const HANDLE_R = 1.0; // handle radius in viewBox-x units (grab tolerance is larger, in px)
// Rotation handle sits this far (viewBox units) beyond the ellipse top; mirrors
// PhotoEditor's MASK_ROT_OFF (0.07 fraction) so render + hit-test agree.
const ROT_OFF_VB = 7;

export function MaskOverlay({
  sub,
  style,
  aspect = 1,
  cursor = null,
  handles = false,
}: {
  sub: SubMask;
  style?: CSSProperties;
  aspect?: number;
  cursor?: { x: number; y: number; size: number } | null;
  // Draw the drag handles (only while editing on the image); the shape outline
  // always renders so a selected mask stays visible.
  handles?: boolean;
}) {
  const p = sub.parameters;
  const num = (k: string, d: number) => (typeof p[k] === "number" ? (p[k] as number) : d);
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
          className="mask-overlay-shape mask-overlay-fill"
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
    shapes = (
      <>
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
    shapes = (
      <>
        {strokes.map((s, i) => (
          <circle
            key={i}
            cx={(s[0] ?? 0) * 100}
            cy={(s[1] ?? 0) * 100}
            r={Math.max(0.5, (s[2] ?? 0.06) * 50)}
            className="mask-overlay-shape mask-overlay-fill"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {cursor && (
          <circle
            cx={cursor.x * 100}
            cy={cursor.y * 100}
            r={Math.max(0.5, cursor.size * 50)}
            className="mask-brush-ring"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </>
    );
  } else {
    return null;
  }

  return (
    <svg className="mask-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" style={style}>
      {shapes}
    </svg>
  );
}

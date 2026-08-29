import type { CSSProperties } from "react";
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

export function MaskOverlay({
  sub,
  style,
  aspect = 1,
  cursor = null,
  handles = false,
  mark = true,
  dashed = false,
}: {
  sub: SubMask;
  style?: CSSProperties;
  aspect?: number;
  cursor?: { x: number; y: number; size: number } | null;
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
    const fadeId = `mask-brush-fade-${sub.id}`;
    const maskId = `mask-brush-${sub.id}`;
    shapes = (
      <>
        <defs>
          {/* Mirrors the render's falloff: solid out to (1 - feather) of the
              radius, then smoothstep to nothing at the edge. Without this the
              guide was a hard-edged disc and the Feather slider looked dead.
              White, because the dabs are the content of a luminance <mask>. */}
          <radialGradient id={fadeId}>
            {brushFadeStops(feather).map(([offset, opacity], i) => (
              <stop key={i} offset={`${offset * 100}%`} stopColor="#fff" stopOpacity={opacity} />
            ))}
          </radialGradient>
          {/* The painted area drives a mask over the zebra, so the stripes are
              the paint - a striped dab per sample would break up as the strokes
              overlap. */}
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
            {strokes.map((s, i) => (
              <ellipse
                key={i}
                cx={(s[0] ?? 0) * 100}
                cy={(s[1] ?? 0) * 100}
                rx={rx(s[2] ?? 0.06)}
                ry={ry(s[2] ?? 0.06)}
                fill={`url(#${fadeId})`}
              />
            ))}
          </mask>
        </defs>
        {mark && strokes.length > 0 && (
          <rect x="0" y="0" width="100" height="100" fill={`url(#${ZEBRA_ID})`} mask={`url(#${maskId})`} />
        )}
        {cursor && (
          <ellipse
            cx={cursor.x * 100}
            cy={cursor.y * 100}
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

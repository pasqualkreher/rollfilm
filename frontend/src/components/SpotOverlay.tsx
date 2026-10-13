import { memo, useEffect, useRef, type CSSProperties } from "react";
import type { SpotDef } from "../utils/adjustments";

// The retouch spots drawn over the canvas the way MaskOverlay draws a mask's
// shape: an SVG in a 0..100 viewBox stretched (preserveAspectRatio="none")
// over the framed image, so a spot's fractions map straight to per cent. Every
// spot shows as a faint circle; the selected one also shows where it reads
// from - its source, dashed - and a thread between the two. It carries the
// canvas zoom/pan transform (`style`) so the circles stay on their pixels.
// Pointer-transparent: hit-testing and dragging live in PhotoEditor.
//
// A spot's radius is a fraction of the frame's LONG edge (like a brush size),
// and the viewBox is stretched non-uniformly, so a circle is drawn as an
// ellipse whose radii are converted per axis (`aspect` = width / height).
function SpotOverlayImpl({
  spots,
  selectedId,
  aspect = 1,
  style,
  hidden = false,
  cursor = null,
  cursorSink,
}: {
  spots: SpotDef[];
  selectedId: string | null;
  aspect?: number;
  style?: CSSProperties;
  hidden?: boolean;
  // The size ring at the pointer while the tool is armed: where it first
  // appeared and how big; its moves arrive through `cursorSink` and land in
  // the DOM without a render, the way the brush ring's do (MaskOverlay).
  cursor?: { x: number; y: number; r: number } | null;
  cursorSink?: Set<(x: number, y: number) => void>;
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
  if (hidden) return null;
  const rx = (r: number) => (aspect >= 1 ? r : r / aspect) * 100;
  const ry = (r: number) => (aspect >= 1 ? r * aspect : r) * 100;
  return (
    <svg className="spot-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" style={style} aria-hidden>
      <defs>
        {/* The arrowhead at the spot's end of the source->spot line: the
            direction the pixels travel. Sized by the stroke, so it keeps
            its size under zoom like the strokes do. */}
        <marker id="spot-arrow" markerUnits="strokeWidth" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto">
          <path d="M0 0.5 L6 3.5 L0 6.5" className="spot-arrowhead" />
        </marker>
      </defs>
      {cursor && (
        <ellipse
          ref={ringRef}
          cx={(ringPosRef.current ?? cursor).x * 100}
          cy={(ringPosRef.current ?? cursor).y * 100}
          rx={rx(cursor.r)}
          ry={ry(cursor.r)}
          className="spot-ring"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {spots.map((s) => {
        const selected = s.id === selectedId;
        return (
          <g key={s.id} className={`spot${selected ? " is-selected" : ""}`}>
            {selected && (
              <>
                <line
                  x1={s.src_x * 100}
                  y1={s.src_y * 100}
                  x2={s.x * 100}
                  y2={s.y * 100}
                  className="spot-link"
                  markerEnd="url(#spot-arrow)"
                  vectorEffect="non-scaling-stroke"
                />
                <ellipse
                  cx={s.src_x * 100}
                  cy={s.src_y * 100}
                  rx={rx(s.radius)}
                  ry={ry(s.radius)}
                  className="spot-source"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
            <ellipse
              cx={s.x * 100}
              cy={s.y * 100}
              rx={rx(s.radius)}
              ry={ry(s.radius)}
              className="spot-dest"
              vectorEffect="non-scaling-stroke"
            />
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

// Memoised by value: the editor re-renders on every slider frame, and the
// spots only change when one is placed or moved.
export const SpotOverlay = memo(
  SpotOverlayImpl,
  (a, b) =>
    a.spots === b.spots &&
    a.selectedId === b.selectedId &&
    a.aspect === b.aspect &&
    a.hidden === b.hidden &&
    a.cursorSink === b.cursorSink &&
    sameCursor(a.cursor, b.cursor) &&
    sameStyle(a.style, b.style)
);

function sameCursor(
  a: { x: number; y: number; r: number } | null | undefined,
  b: { x: number; y: number; r: number } | null | undefined
): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null);
  return a.x === b.x && a.y === b.y && a.r === b.r;
}

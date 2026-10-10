import { memo, type CSSProperties } from "react";
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
}: {
  spots: SpotDef[];
  selectedId: string | null;
  aspect?: number;
  style?: CSSProperties;
  hidden?: boolean;
}) {
  if (hidden || !spots.length) return null;
  const rx = (r: number) => (aspect >= 1 ? r : r / aspect) * 100;
  const ry = (r: number) => (aspect >= 1 ? r * aspect : r) * 100;
  return (
    <svg className="spot-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" style={style} aria-hidden>
      {spots.map((s) => {
        const selected = s.id === selectedId;
        return (
          <g key={s.id} className={`spot${selected ? " is-selected" : ""}`}>
            {selected && (
              <>
                <line
                  x1={s.x * 100}
                  y1={s.y * 100}
                  x2={s.src_x * 100}
                  y2={s.src_y * 100}
                  className="spot-link"
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
    sameStyle(a.style, b.style)
);

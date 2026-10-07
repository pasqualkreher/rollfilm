// The baseline's picture on the photo view's stage, for the compare group
// (CompareControls): laid over the edited photo for hold-to-compare and the
// split view, or in its own pane beside it for side by side. The same markup
// and classes as the editor's compare views (PhotoEditor's split canvas,
// divider and tags), on <img> elements instead of canvases.

import { useRef, type CSSProperties } from "react";
import type { CompareMode } from "./CompareControls";
import type { ZoomPan } from "../utils/useImageZoomPan";

interface OverlayProps {
  /** Object URL of the baseline render; nothing is drawn without one. */
  src: string | null;
  mode: CompareMode;
  holding: boolean;
  /** Split position as a fraction of the photo's width. */
  splitPos: number;
  onSplitPos: (pos: number) => void;
  /** The edited <img>'s own style (size + zoom/pan transform), shared so the
   *  two pictures stay registered under zoom and pan. */
  imageStyle: CSSProperties;
  /** The edited <img> is easing a discrete zoom: ease along, or the two drift apart for a moment. */
  zoomAnim: boolean;
  scale: number;
  pan: { x: number; y: number };
  framed: boolean;
  /** "Original" or "JPG" - the left tag in the split view. */
  label: string;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// Over the edited photo: the whole baseline while the eye is held, the part
// left of the divider in the split view. Rendered inside the fit-sized wrap
// around the edited <img>, after it.
export function CompareOverlay({ src, mode, holding, splitPos, onSplitPos, imageStyle, zoomAnim, scale, pan, framed, label }: OverlayProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dividerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef(false);
  const posRef = useRef(splitPos);
  if (!dragRef.current) posRef.current = splitPos;
  const split = mode === "split";
  const show = split || (holding && mode === "off");
  if (!show || !src) return null;

  // The clip is applied before the transform, so the line splits the *photo*;
  // the divider is NOT under the transform (it would be a fat bar at 6x), its
  // position is the split fraction pushed through the same transform by hand.
  const clipFor = (pos: number) => `inset(0 ${(1 - pos) * 100}% 0 0)`;
  const leftFor = (pos: number) => `calc(${50 + (pos - 0.5) * scale * 100}% + ${pan.x}px)`;

  return (
    <>
      <img
        ref={imgRef}
        className={`detail-photo detail-photo--baseline${framed ? " framed" : ""}${zoomAnim ? " zoom-anim" : ""}`}
        style={{ ...imageStyle, cursor: undefined, ...(split ? { clipPath: clipFor(splitPos) } : null) }}
        src={src}
        alt=""
        aria-hidden
        draggable={false}
      />
      {split && (
        <div
          ref={dividerRef}
          className="split-divider"
          style={{ left: leftFor(splitPos) }}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = true;
          }}
          onPointerMove={(e) => {
            if (!dragRef.current) return;
            // The overlay's box IS the on-screen photo (the transform moves the
            // box, the clip does not), so the fraction needs no pan/scale maths.
            const r = imgRef.current?.getBoundingClientRect();
            if (!r || r.width <= 0) return;
            const pos = clamp01((e.clientX - r.left) / r.width);
            posRef.current = pos;
            // DOM first, state on release: a 1400-line page must not re-render
            // per pointer move.
            if (imgRef.current) imgRef.current.style.clipPath = clipFor(pos);
            if (dividerRef.current) dividerRef.current.style.left = leftFor(pos);
          }}
          onPointerUp={(e) => {
            if (!dragRef.current) return;
            dragRef.current = false;
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
            onSplitPos(posRef.current);
          }}
          onPointerCancel={() => {
            dragRef.current = false;
            onSplitPos(posRef.current);
          }}
        >
          <span className="split-divider-grip" aria-hidden />
        </div>
      )}
      {split && (
        <>
          <span className="split-tag split-tag-left">{label}</span>
          <span className="split-tag split-tag-right">Edited</span>
        </>
      )}
    </>
  );
}

interface PaneProps {
  src: string | null;
  fit: { w: number; h: number };
  imageStyle: CSSProperties;
  imageHandlers: ZoomPan["imageHandlers"];
  zoomAnim: boolean;
  framed: boolean;
  label: string;
}

// Side by side: the baseline's own pane, left of the edit. Both pictures carry
// the same transform, so they zoom and pan together; each pane clips its own
// so a zoomed photo can't spill over its neighbour.
export function BaselinePane({ src, fit, imageStyle, imageHandlers, zoomAnim, framed, label }: PaneProps) {
  return (
    <div className="detail-pane" style={{ width: fit.w, height: fit.h }}>
      {src && (
        <img
          className={`detail-photo detail-photo--pane${framed ? " framed" : ""}${zoomAnim ? " zoom-anim" : ""}`}
          style={imageStyle}
          src={src}
          alt=""
          aria-hidden
          draggable={false}
          {...imageHandlers}
        />
      )}
      <span className="split-tag split-tag-left">{label}</span>
    </div>
  );
}

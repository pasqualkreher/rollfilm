import { memo, useEffect, useRef, useState } from "react";

// A colour-grading hue/saturation wheel: hue is the angle around the disc
// (0..360, red at the top, running clockwise to match the conic gradient),
// saturation is the radius (0 at the centre, 100 at the rim). The disc paints a
// conic hue ring fading to neutral grey in the middle so it reads as a real
// grading wheel. Dragging updates {hue,saturation}; double-click resets to
// neutral. The parent owns the value and writes it into adj.color_grading[range].

interface Props {
  label: string;
  hue: number; // 0..360
  saturation: number; // 0..100
  onChange: (v: { hue: number; saturation: number }) => void;
  onReset?: () => void;
}

// Memoised on the value alone: four wheels sit in the Color group and the
// editor re-renders on every slider frame. The callbacks are fresh arrows
// each render that close over nothing but the wheel's own range key, so they
// are left out of the comparison (the latest one is read through a ref).
export const ColorWheel = memo(
  ColorWheelImpl,
  (a, b) => a.label === b.label && a.hue === b.hue && a.saturation === b.saturation
);

function ColorWheelImpl({ label, hue, saturation, onChange, onReset }: Props) {
  const discRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  // One onChange per animation frame, last position wins - the same
  // coalescing the sliders do. Pointer events arrive several per frame and
  // each one was a state write that re-rendered the whole editor.
  const pendingRef = useRef<{ hue: number; saturation: number } | null>(null);
  const rafRef = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  function queueChange(v: { hue: number; saturation: number }) {
    pendingRef.current = v;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) onChangeRef.current(pending);
    });
  }

  // Pointer (client) coords -> {hue, saturation}. Angle is measured clockwise
  // from the top (atan2(dx, -dy)) so it lines up with `conic-gradient(from 0)`.
  function fromPointer(clientX: number, clientY: number) {
    const rect = discRef.current!.getBoundingClientRect();
    const r = rect.width / 2;
    const dx = clientX - (rect.left + r);
    const dy = clientY - (rect.top + r);
    const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    return {
      hue: Math.round((deg + 360) % 360),
      saturation: Math.round(Math.min(100, (Math.hypot(dx, dy) / r) * 100)),
    };
  }

  // Puck position as percentages of the disc, from the same convention as
  // fromPointer(), so the puck always sits over its own hue on the ring.
  const rad = (hue * Math.PI) / 180;
  const rr = saturation / 100;
  const puckLeft = 50 + 50 * rr * Math.sin(rad);
  const puckTop = 50 - 50 * rr * Math.cos(rad);

  function endDrag(pointerId: number) {
    draggingRef.current = false;
    setDragging(false);
    const disc = discRef.current;
    if (disc && disc.hasPointerCapture(pointerId)) disc.releasePointerCapture(pointerId);
  }

  return (
    <div className="grade-wheel">
      <div className="grade-wheel-label">{label}</div>
      <div
        ref={discRef}
        className={`grade-wheel-disc${dragging ? " dragging" : ""}`}
        onPointerDown={(e) => {
          e.preventDefault();
          draggingRef.current = true;
          setDragging(true);
          discRef.current!.setPointerCapture(e.pointerId);
          onChangeRef.current(fromPointer(e.clientX, e.clientY));
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) queueChange(fromPointer(e.clientX, e.clientY));
        }}
        onPointerUp={(e) => endDrag(e.pointerId)}
        onPointerCancel={(e) => endDrag(e.pointerId)}
        onDoubleClick={() => onResetRef.current?.()}
      >
        <span className="grade-wheel-puck" style={{ left: `${puckLeft}%`, top: `${puckTop}%` }} />
      </div>
      <div className="grade-wheel-readout">{saturation === 0 ? "Neutral" : `${Math.round(hue)}° · ${Math.round(saturation)}`}</div>
    </div>
  );
}

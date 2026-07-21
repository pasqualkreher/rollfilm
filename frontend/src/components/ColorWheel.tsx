import { useRef, useState } from "react";

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

export function ColorWheel({ label, hue, saturation, onChange, onReset }: Props) {
  const discRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);

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
          onChange(fromPointer(e.clientX, e.clientY));
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) onChange(fromPointer(e.clientX, e.clientY));
        }}
        onPointerUp={(e) => endDrag(e.pointerId)}
        onPointerCancel={(e) => endDrag(e.pointerId)}
        onDoubleClick={() => onReset?.()}
      >
        <span className="grade-wheel-puck" style={{ left: `${puckLeft}%`, top: `${puckTop}%` }} />
      </div>
      <div className="grade-wheel-readout">{saturation === 0 ? "Neutral" : `${Math.round(hue)}° · ${Math.round(saturation)}`}</div>
    </div>
  );
}

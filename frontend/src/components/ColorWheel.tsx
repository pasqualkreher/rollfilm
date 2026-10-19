import { memo, useEffect, useRef, useState } from "react";

// A colour-grading hue/saturation wheel: hue is the angle around the disc
// (0..360, red at the top, running clockwise to match the conic gradient),
// saturation is the radius (0 at the centre, 100 at the rim). The disc paints a
// conic hue ring fading to neutral grey in the middle so it reads as a real
// grading wheel. Dragging updates {hue,saturation}: the puck jumps to the
// pointer and follows it; with Shift held it starts where it is and moves at a
// quarter of the pointer's pace, for the fine placing a small disc cannot give
// otherwise. The arrow keys nudge it too (left/right turn the hue, up/down
// the saturation; Shift for a tenth of a step). Double-click resets to
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

// Values are kept to a tenth: a degree or a saturation unit is a coarse step
// on a wheel this size, and the fine drag and Shift-arrows land between them.
const tenth = (v: number) => Math.round(v * 10) / 10;
const KEY_STEP = 1;
const KEY_STEP_FINE = 0.1;
const FINE_DRAG = 0.25;
// Whole numbers stay whole in the readout; only a fine value shows its tenth.
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

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

  // The drag's own puck position in disc units (x right, y down, 100 = the
  // rim) and where the pointer last was: each move adds the pointer's travel,
  // so the pace can change mid-drag (Shift) without the puck jumping.
  const dragRef = useRef({ x: 0, y: 0, px: 0, py: 0 });

  // Disc units -> {hue, saturation}. Angle is measured clockwise from the top
  // (atan2(x, -y)) so it lines up with `conic-gradient(from 0)`.
  function toValue(x: number, y: number) {
    const deg = (Math.atan2(x, -y) * 180) / Math.PI;
    const sat = Math.min(100, Math.hypot(x, y));
    return { hue: sat === 0 ? hue : tenth((deg + 360) % 360) % 360, saturation: tenth(sat) };
  }
  function fromValue(h: number, sat: number) {
    const rad = (h * Math.PI) / 180;
    return { x: sat * Math.sin(rad), y: -sat * Math.cos(rad) };
  }
  // Pointer (client) coords -> disc units.
  function discUnits(clientX: number, clientY: number) {
    const rect = discRef.current!.getBoundingClientRect();
    const r = rect.width / 2;
    return { x: ((clientX - (rect.left + r)) / r) * 100, y: ((clientY - (rect.top + r)) / r) * 100 };
  }
  function startDrag(clientX: number, clientY: number, fine: boolean) {
    const at = fine ? fromValue(hue, saturation) : discUnits(clientX, clientY);
    dragRef.current = { ...at, px: clientX, py: clientY };
    return toValue(at.x, at.y);
  }
  function dragTo(clientX: number, clientY: number, fine: boolean) {
    const rect = discRef.current!.getBoundingClientRect();
    const r = rect.width / 2;
    const drag = dragRef.current;
    const pace = fine ? FINE_DRAG : 1;
    drag.x += ((clientX - drag.px) / r) * 100 * pace;
    drag.y += ((clientY - drag.py) / r) * 100 * pace;
    // Past the rim the puck stays on it, and the drag continues from there.
    const len = Math.hypot(drag.x, drag.y);
    if (len > 100) {
      drag.x = (drag.x / len) * 100;
      drag.y = (drag.y / len) * 100;
    }
    drag.px = clientX;
    drag.py = clientY;
    return toValue(drag.x, drag.y);
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
        tabIndex={0}
        role="group"
        aria-label={`${label} colour grade, ${saturation === 0 ? "neutral" : `hue ${fmt(hue)} degrees, saturation ${fmt(saturation)}`}. Arrow keys move it, double-click resets.`}
        title="Drag the puck. Hold Shift to move it slowly. Arrow keys: ← → hue, ↑ ↓ saturation, Shift for tenths. Double-click resets."
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.focus();
          draggingRef.current = true;
          setDragging(true);
          discRef.current!.setPointerCapture(e.pointerId);
          // The puck jumps to the pointer - except with Shift held, where
          // the drag starts from where the puck is and only nudges it.
          const start = startDrag(e.clientX, e.clientY, e.shiftKey);
          if (!e.shiftKey) onChangeRef.current(start);
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) queueChange(dragTo(e.clientX, e.clientY, e.shiftKey));
        }}
        onPointerUp={(e) => endDrag(e.pointerId)}
        onPointerCancel={(e) => endDrag(e.pointerId)}
        onDoubleClick={() => {
          pendingRef.current = null; // a queued drag value must not undo the reset
          onResetRef.current?.();
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? KEY_STEP_FINE : KEY_STEP;
          let next: { hue: number; saturation: number } | null = null;
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            const dir = e.key === "ArrowRight" ? 1 : -1;
            next = { hue: tenth((hue + dir * step + 360) % 360), saturation };
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            const dir = e.key === "ArrowUp" ? 1 : -1;
            next = { hue, saturation: tenth(Math.max(0, Math.min(100, saturation + dir * step))) };
          }
          if (!next) return;
          // The editor's own arrow handling (jump into the slider list)
          // must not also fire.
          e.preventDefault();
          e.stopPropagation();
          onChangeRef.current(next);
        }}
      >
        <span className="grade-wheel-puck" style={{ left: `${puckLeft}%`, top: `${puckTop}%` }} />
      </div>
      <div className="grade-wheel-readout">{saturation === 0 ? "Neutral" : `${fmt(hue)}° · ${fmt(saturation)}`}</div>
    </div>
  );
}

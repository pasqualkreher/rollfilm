import { memo, useEffect, useRef, useState } from "react";

// The white-balance shift grid a camera shows: one puck on a red/blue cross,
// -9..+9 on each axis. One unit is one step of the camera's grid, but the puck
// is free between the crossings (tenths) - a whole step is 3-4 % on a channel,
// too much for a fine correction. Right is more red (left: cyan), up is more
// blue (down: yellow). It sits under the Kelvin slider and is independent
// of it - the colour temperature is set first, this is the fine correction on
// top (adjustments wb_shift_r / wb_shift_b, applied as channel gains in the
// render's white-balance step).

interface Props {
  red: number;
  blue: number;
  onChange: (v: { red: number; blue: number }) => void;
}

// Steps each way on both axes, as on the camera.
const REACH = 9;
const limit = (v: number) => Math.max(-REACH, Math.min(REACH, v));
// Held in tenths of a step.
const clamp = (v: number) => Math.round(limit(v) * 10) / 10;
const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);
// The arrow keys: one step, with Shift half a step.
const KEY_STEP = 1;
const KEY_STEP_FINE = 0.5;
// A drag with Shift held moves the puck at a quarter of the pointer's pace.
const FINE_DRAG = 0.25;

// One axis as a number: typed, or stepped with the field's arrows (and the
// arrow keys while it has the focus).
function AxisField({
  label,
  name,
  value,
  onCommit,
}: {
  label: string;
  name: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  // Always one decimal, so the field's text keeps its width as the value moves.
  const shown = value.toFixed(1);
  // What is being typed, while it is being typed: "-" or "" on the way to a
  // number must not be snapped back by the value coming round again.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="wb-pad-field">
      <span>{label}</span>
      <input
        type="number"
        min={-REACH}
        max={REACH}
        step={0.1}
        aria-label={name}
        value={draft ?? shown}
        onFocus={(e) => {
          setDraft(shown);
          e.currentTarget.select();
        }}
        onBlur={() => setDraft(null)}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          const typed = Number(text.replace(",", "."));
          if (text.trim() !== "" && Number.isFinite(typed)) onCommit(clamp(typed));
        }}
        onKeyDown={(e) => {
          // The field's own keys stay the field's: Enter/Escape finish the
          // entry (and must not close the editor), the arrows step the value
          // rather than walking the editor's slider list.
          if (e.key === "Enter" || e.key === "Escape") {
            e.stopPropagation();
            e.currentTarget.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.stopPropagation();
          }
        }}
      />
    </label>
  );
}

export const WbShiftPad = memo(
  WbShiftPadImpl,
  // The callback is a fresh arrow each render that closes over nothing of its
  // own (read through a ref below) - compare the values only, as ColorWheel does.
  (a, b) => a.red === b.red && a.blue === b.blue
);

function WbShiftPadImpl({ red, blue, onChange }: Props) {
  const padRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  // One onChange per animation frame, last position wins - the same
  // coalescing the sliders and the grading wheels do.
  const pendingRef = useRef<{ red: number; blue: number } | null>(null);
  const rafRef = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const edited = red !== 0 || blue !== 0;

  // The drag's own position, unrounded, and where the pointer last was: each
  // move adds the pointer's travel to it, so the pace can change mid-drag
  // (Shift) without the puck jumping.
  const dragRef = useRef({ red: 0, blue: 0, x: 0, y: 0 });

  // Where on the cross a point of the screen is. Not snapped to the grid's
  // crossings - the puck follows the pointer.
  function fromPointer(clientX: number, clientY: number) {
    const rect = padRef.current!.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return { red: limit((2 * x - 1) * REACH), blue: limit((1 - 2 * y) * REACH) };
  }

  function dragTo(clientX: number, clientY: number, fine: boolean) {
    const rect = padRef.current!.getBoundingClientRect();
    const drag = dragRef.current;
    const pace = fine ? FINE_DRAG : 1;
    drag.red = limit(drag.red + ((clientX - drag.x) / rect.width) * 2 * REACH * pace);
    drag.blue = limit(drag.blue - ((clientY - drag.y) / rect.height) * 2 * REACH * pace);
    drag.x = clientX;
    drag.y = clientY;
    return { red: clamp(drag.red), blue: clamp(drag.blue) };
  }

  function queueChange(v: { red: number; blue: number }) {
    pendingRef.current = v;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) onChangeRef.current(pending);
    });
  }

  function endDrag(pointerId: number) {
    draggingRef.current = false;
    setDragging(false);
    const pad = padRef.current;
    if (pad && pad.hasPointerCapture(pointerId)) pad.releasePointerCapture(pointerId);
  }

  function reset() {
    pendingRef.current = null; // a queued drag value must not undo the reset
    onChangeRef.current({ red: 0, blue: 0 });
  }

  return (
    <div className="wb-pad-block">
      <div className="editor-slider-head">
        <span>
          White balance shift
          {edited && <span className="editor-edited-dot" title="Changed from its default" />}
        </span>
      </div>
      <div className="wb-pad-frame">
        <span className="wb-pad-axis wb-pad-axis--top">B</span>
        <span className="wb-pad-axis wb-pad-axis--right">R</span>
        <div
          ref={padRef}
          className={`wb-pad${dragging ? " dragging" : ""}`}
          tabIndex={0}
          role="group"
          aria-label={`White balance shift, red ${signed(clamp(red))}, blue ${signed(clamp(blue))}. Arrow keys move it, double-click resets.`}
          title="Drag: right is more red, up is more blue. Hold Shift to move it slowly. Double-click resets."
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.focus();
            draggingRef.current = true;
            setDragging(true);
            padRef.current!.setPointerCapture(e.pointerId);
            // The puck jumps to the pointer - except with Shift held, where
            // the drag starts from where the puck is and only nudges it.
            const start = e.shiftKey ? { red, blue } : fromPointer(e.clientX, e.clientY);
            dragRef.current = { ...start, x: e.clientX, y: e.clientY };
            if (!e.shiftKey) onChangeRef.current({ red: clamp(start.red), blue: clamp(start.blue) });
          }}
          onPointerMove={(e) => {
            if (draggingRef.current) queueChange(dragTo(e.clientX, e.clientY, e.shiftKey));
          }}
          onPointerUp={(e) => endDrag(e.pointerId)}
          onPointerCancel={(e) => endDrag(e.pointerId)}
          onDoubleClick={reset}
          onKeyDown={(e) => {
            const move: Record<string, [number, number]> = {
              ArrowRight: [1, 0],
              ArrowLeft: [-1, 0],
              ArrowUp: [0, 1],
              ArrowDown: [0, -1],
            };
            const delta = move[e.key];
            if (!delta) return;
            // The editor's own arrow handling (jump into the slider list)
            // must not also fire.
            e.preventDefault();
            e.stopPropagation();
            const step = e.shiftKey ? KEY_STEP_FINE : KEY_STEP;
            onChangeRef.current({ red: clamp(red + delta[0] * step), blue: clamp(blue + delta[1] * step) });
          }}
        >
          <span
            className="wb-pad-puck"
            style={{
              left: `${50 + (clamp(red) / REACH) * 50}%`,
              top: `${50 - (clamp(blue) / REACH) * 50}%`,
            }}
          />
        </div>
      </div>
      <div className="wb-pad-fields">
        <AxisField
          label="R"
          name="Red shift"
          value={clamp(red)}
          onCommit={(r) => onChangeRef.current({ red: r, blue: clamp(blue) })}
        />
        <AxisField
          label="B"
          name="Blue shift"
          value={clamp(blue)}
          onCommit={(b) => onChangeRef.current({ red: clamp(red), blue: b })}
        />
      </div>
    </div>
  );
}

import { memo, useEffect, useRef, useState } from "react";

// The white-balance shift grid a camera shows: one puck on a red/blue cross,
// in whole steps of -9..+9 on each axis. Right is more red (left: cyan), up is
// more blue (down: yellow). It sits under the Kelvin slider and is independent
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
const clamp = (v: number) => Math.max(-REACH, Math.min(REACH, Math.round(v)));
const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);

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
  const shown = String(value);
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
        step={1}
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
          const typed = Number(text);
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

  // The puck snaps to the grid's crossings: whole steps, like the camera's.
  function fromPointer(clientX: number, clientY: number) {
    const rect = padRef.current!.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return { red: clamp((2 * x - 1) * REACH), blue: clamp((1 - 2 * y) * REACH) };
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
          aria-label={`White balance shift, red ${signed(red)}, blue ${signed(blue)}. Arrow keys move it, double-click resets.`}
          title="Drag: right is more red, up is more blue. Double-click resets."
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.focus();
            draggingRef.current = true;
            setDragging(true);
            padRef.current!.setPointerCapture(e.pointerId);
            onChangeRef.current(fromPointer(e.clientX, e.clientY));
          }}
          onPointerMove={(e) => {
            if (draggingRef.current) queueChange(fromPointer(e.clientX, e.clientY));
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
            onChangeRef.current({ red: clamp(red + delta[0]), blue: clamp(blue + delta[1]) });
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

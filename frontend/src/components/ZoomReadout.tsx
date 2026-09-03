// The zoom control that sits under the photo, in every view that shows one
// big: the library's photo view, the import review's preview and the editor.
//
// It exists because zoom used to be invisible - you could scroll past 1:1 and
// had no way to tell, and double-click was the only discrete step there was.
// Naming the percentage and offering Fit / 100% / 200% makes "am I above
// 100%?" answerable, and gives the keyboard-free way to get there.
//
// Compact by design: no caption (the Fit/percent steps say what it is) and no
// hint sentence - the how-to-zoom hint rides in the percentage's tooltip - so
// the stage toolbars fit one line.

// Deliberately structural, not the whole ZoomPan: the editor drives its canvas
// with its own scale state and only implements these four.
export interface ZoomReadoutTarget {
  zoomed: boolean;
  /** Percentage of actual pixels; null while the photo's size is unknown. */
  zoomPercent: number | null;
  resetZoom: (animate?: boolean) => void;
  zoomToNative: (factor: number) => void;
}

export function ZoomReadout({ zoom }: { zoom: ZoomReadoutTarget }) {
  const percent = zoom.zoomPercent;
  const hint = zoom.zoomed ? "drag to pan, Esc to fit" : "scroll, pinch or double-click to zoom";
  return (
    <span className="zoom-readout">
      <span className="segmented" role="group" aria-label="Zoom">
        <button className={zoom.zoomed ? "" : "active"} onClick={() => zoom.resetZoom(true)}>
          Fit
        </button>
        <button
          className={percent !== null && percent >= 99 && percent <= 101 ? "active" : ""}
          onClick={() => zoom.zoomToNative(1)}
          title="Actual pixels (1:1)"
        >
          100%
        </button>
        <button
          className={percent !== null && percent >= 198 && percent <= 202 ? "active" : ""}
          onClick={() => zoom.zoomToNative(2)}
          title="Twice actual pixels"
        >
          200%
        </button>
        <button
          className={percent !== null && percent >= 396 ? "active" : ""}
          onClick={() => zoom.zoomToNative(4)}
          title="Four times actual pixels - the maximum"
        >
          400%
        </button>
      </span>
      <span className="zoom-readout-value" title={`Current zoom, in actual pixels — ${hint}`}>
        {percent === null ? "—" : `${percent}%`}
      </span>
    </span>
  );
}

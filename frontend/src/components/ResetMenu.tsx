import { useEffect, useRef, useState } from "react";
import type { BulkResetOptions } from "../api/types";
import { useWait } from "../state/wait";

interface Props {
  // How many photos are selected - shown on the apply button.
  count: number;
  onReset: (opts: BulkResetOptions) => void | Promise<unknown>;
}

// The resettable aspects, in the order they appear in the menu. `key` matches
// the BulkResetOptions / server flag names; `edits`-ish keys re-render photos.
const ASPECTS: { key: keyof BulkResetOptions; label: string }[] = [
  { key: "rating", label: "Stars" },
  { key: "color_label", label: "Colors" },
  { key: "tags", label: "Tags" },
  { key: "albums", label: "Albums" },
  { key: "develop", label: "Edits (develop)" },
  { key: "geometry", label: "Crop & geometry" },
];

// A compact "Reset…" button that opens a checkbox menu: the user ticks exactly
// which aspects to reset back to the just-imported state, then applies. Metadata
// (stars/colors/tags) is pre-checked as the common case; edits/albums are opt-in
// because they re-render or unfile photos.
export function ResetMenu({ count, onReset }: Props) {
  const { withWait } = useWait();
  const [open, setOpen] = useState(false);
  // Nothing is pre-checked - the user opts into exactly which aspects to reset.
  const [checked, setChecked] = useState<Set<keyof BulkResetOptions>>(
    () => new Set<keyof BulkResetOptions>()
  );
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Start every open with a clean slate - nothing pre-checked.
  useEffect(() => {
    if (open) setChecked(new Set());
  }, [open]);

  // Close on outside click / Escape, like a native dropdown.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle(key: keyof BulkResetOptions) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function apply() {
    if (checked.size === 0) return;
    // Send explicit false for every aspect so the server's "default true"
    // metadata flags don't reset anything the user unticked.
    const opts: BulkResetOptions = {};
    for (const { key } of ASPECTS) opts[key] = checked.has(key);
    setBusy(true);
    try {
      // The app-wide wait popup blocks everything while the server resets and
      // (for develop/geometry) re-renders the selected photos.
      await withWait(
        `Resetting ${count} photo${count === 1 ? "" : "s"}…`,
        () => Promise.resolve(onReset(opts))
      );
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="reset-menu" ref={wrapRef}>
      <button
        type="button"
        className="btn"
        onClick={() => setOpen((o) => !o)}
        title="Reset selected aspects back to the just-imported state"
      >
        Reset… <span className="reset-menu-caret">▾</span>
      </button>

      {open && (
        <div className="reset-menu-pop">
          <div className="reset-menu-list">
            {ASPECTS.map(({ key, label }) => (
              <label key={key} className="reset-menu-item">
                <input type="checkbox" checked={checked.has(key)} onChange={() => toggle(key)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <button
            type="button"
            className="btn quiet-danger reset-menu-apply"
            disabled={checked.size === 0 || busy}
            onClick={apply}
          >
            {busy ? "Resetting…" : `Reset ${count} photo${count === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
    </div>
  );
}

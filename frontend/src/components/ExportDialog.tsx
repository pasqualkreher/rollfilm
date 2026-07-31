import { useEffect, useRef, useState } from "react";
import { api, saveDownload } from "../api/client";
import { useTransientMessage } from "../utils/transientMessage";
import { Dropdown } from "./Dropdown";

// Long-edge presets for the size dropdown; null = keep the original size.
// Shared with the editor's Save-copy dialog, which offers the same choices.
export const SIZE_OPTIONS: { label: string; value: number | null }[] = [
  { label: "Original size", value: null },
  { label: "3840 px (4K)", value: 3840 },
  { label: "2048 px", value: 2048 },
  { label: "1024 px", value: 1024 },
];

// One export dialog for both entry points: the photo page passes a single id,
// the Selects toolbar the whole selection. Same options either way - the
// server answers with a plain .jpg for one photo and a zip for several.
export function ExportDialog({
  imageIds,
  singleFilename,
  onClose,
}: {
  imageIds: string[];
  // Original filename of the one photo (single-photo entry point) - drives the
  // save dialog's suggested name; omitted for multi-selections (always a zip).
  singleFilename?: string;
  onClose: () => void;
}) {
  const [quality, setQuality] = useState(90);
  const [maxSize, setMaxSize] = useState<number | null>(null);
  // "jpeg" renders the edits into fresh JPEGs; "original" hands out the
  // library files byte-for-byte (RAW stays RAW, EXIF/metadata untouched).
  const [format, setFormat] = useState<"jpeg" | "original">("jpeg");
  const [busy, setBusy] = useState(false);
  // Per-photo progress of the running export job, for the bar.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // Flash message - auto-dismisses after a moment.
  const [error, setError] = useTransientMessage();
  const jobRef = useRef<string | null>(null);
  const closedRef = useRef(false);
  useEffect(() => {
    // StrictMode's throwaway mount/unmount cycle runs the cleanup below once
    // before the real mount - undo its mark here, or every export silently
    // aborts itself right before the first progress poll and the dialog hangs
    // at "Exporting…" forever.
    closedRef.current = false;
    return () => {
      // Dialog unmounted mid-export (navigation): stop the server-side job
      // too, its result has no one left to download it.
      closedRef.current = true;
      if (jobRef.current) void api.images.exportCancel(jobRef.current).catch(() => {});
    };
  }, []);

  // Job-based export (both formats). The save-location question comes FIRST
  // (saveDownload opens the picker before running its blob callback), then the
  // server renders/zips in a worker thread while this polls the per-photo
  // counter for the progress bar, and the finished file streams into the
  // chosen target.
  async function doExport() {
    setBusy(true);
    setError(null);
    const single = imageIds.length === 1;
    const stem = singleFilename?.replace(/\.[^.]+$/, "");
    const suggestedName = !single
      ? format === "original"
        ? "photos.zip"
        : "export.zip"
      : format === "original"
        ? (singleFilename ?? "photo")
        : `${stem ?? "export"}.jpg`;
    const ext = suggestedName.includes(".") ? `.${suggestedName.split(".").pop()!.toLowerCase()}` : "";
    const accept: Record<string, string[]> =
      ext === ".zip"
        ? { "application/zip": [".zip"] }
        : ext === ".jpg" || ext === ".jpeg"
          ? { "image/jpeg": [".jpg", ".jpeg"] }
          : { "application/octet-stream": ext ? [ext] : [] };
    let started = false;
    try {
      await saveDownload(suggestedName, accept, async () => {
        started = true;
        const { job_id, total } = await api.images.exportStart(imageIds, {
          quality,
          max_size: maxSize,
          format,
        });
        jobRef.current = job_id;
        setProgress({ done: 0, total });
        for (;;) {
          await new Promise((r) => setTimeout(r, 400));
          if (closedRef.current) throw new Error("cancelled");
          const p = await api.images.exportProgress(job_id);
          if (p.state === "cancelled") throw new Error("cancelled");
          if (p.state === "error") throw new Error(p.error ?? "Export failed");
          setProgress({ done: p.done, total: p.total });
          if (p.state === "ready") {
            jobRef.current = null;
            return api.images.exportResultBlob(job_id);
          }
        }
      });
      if (!started) {
        // User dismissed the location picker - back to the options, no error.
        setBusy(false);
        setProgress(null);
        return;
      }
      onClose();
    } catch (e) {
      if (closedRef.current) return; // dialog is gone, nothing to update
      // Still mounted: always drop the busy state, whatever went wrong -
      // a swallowed error must never leave the dialog stuck at "Exporting…".
      setBusy(false);
      setProgress(null);
      jobRef.current = null;
      if ((e as Error).message !== "cancelled") setError((e as Error).message);
    }
  }

  // Cancel while a job runs aborts it server-side; otherwise just close.
  function onCancel() {
    if (busy) {
      if (jobRef.current) void api.images.exportCancel(jobRef.current).catch(() => {});
      jobRef.current = null;
      setBusy(false);
      setProgress(null);
    } else {
      onClose();
    }
  }

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal pair-delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pair-delete-body">
          <h3>{imageIds.length === 1 ? "Export photo" : `Export ${imageIds.length} photos`}</h3>
          <div className="editor-slider">
            <span className="editor-slider-head">
              <span>Format</span>
            </span>
            <Dropdown
              value={format}
              disabled={busy}
              ariaLabel="Export format"
              onChange={(v) => setFormat(v as "jpeg" | "original")}
              options={[
                { value: "jpeg", label: "JPEG - edits baked in" },
                { value: "original", label: "Original files - 1:1 with all metadata" },
              ]}
            />
          </div>
          <p className="settings-desc" style={{ margin: 0 }}>
            {format === "original"
              ? `Downloads the files exactly as they are in your library - RAW stays RAW, every meta tag kept${
                  imageIds.length === 1 ? "." : " - several photos download as a zip."
                }`
              : `Exports a JPEG with your edits baked in, rendered at full resolution${
                  imageIds.length === 1 ? "." : " - several photos download as a zip."
                }`}
          </p>
          {format === "jpeg" && (
            <>
              <label className="editor-slider">
                <span className="editor-slider-head">
                  <span>JPEG quality</span>
                  <span className="editor-slider-val">{quality}</span>
                </span>
                <input
                  type="range"
                  min={60}
                  max={100}
                  step={1}
                  value={quality}
                  disabled={busy}
                  onChange={(e) => setQuality(Number(e.target.value))}
                />
              </label>
              <div className="editor-slider">
                <span className="editor-slider-head">
                  <span>Size</span>
                </span>
                <Dropdown
                  value={String(maxSize ?? "")}
                  disabled={busy}
                  ariaLabel="Export size"
                  onChange={(v) => setMaxSize(v === "" ? null : Number(v))}
                  options={SIZE_OPTIONS.map((opt) => ({
                    value: String(opt.value ?? ""),
                    label: opt.label,
                  }))}
                />
              </div>
            </>
          )}
          {error && <span className="status-note status-note--error">{error}</span>}
          {busy && progress && (
            <div role="status" aria-live="polite">
              <div className="settings-progress">
                <div
                  className="settings-progress-fill"
                  style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
                />
              </div>
              <span className="status-note">
                {format === "original" ? "Preparing" : "Rendering"}{" "}
                {progress.total === 1
                  ? "your photo"
                  : `photo ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`}
                … please keep this window open.
              </span>
            </div>
          )}
          <div className="pair-delete-actions">
            <button className="btn primary" onClick={doExport} disabled={busy}>
              {busy ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Exporting…
                </>
              ) : (
                "Export"
              )}
            </button>
            <button className="btn ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

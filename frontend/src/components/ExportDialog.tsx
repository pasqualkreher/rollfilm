import { useEffect, useRef, useState } from "react";
import { api, saveDownload } from "../api/client";
import type {
  ExportFormat,
  ExportMetadata,
  ExportOptions,
  ExportPreset,
  ExportSharpen,
} from "../api/types";
import { useTransientMessage } from "../utils/transientMessage";
import { useEscapeToClose } from "../utils/modalKeys";
import { useAppDialogs } from "./AppDialogs";
import { Dropdown } from "./Dropdown";
import { IconExport } from "./Icons";
import { rangeFillStyle } from "../utils/rangeFill";
import { Spinner } from "./Spinner";

// Long-edge presets for the size dropdown; null = keep the original size.
// Shared with the editor's Save-copy dialog, which offers the same choices.
export const SIZE_OPTIONS: { label: string; value: number | null }[] = [
  { label: "Original size", value: null },
  { label: "3840 px (4K)", value: 3840 },
  { label: "2048 px", value: 2048 },
  { label: "1024 px", value: 1024 },
];

// The dialog as it opens before anything was ever exported.
const DEFAULT_OPTIONS: ExportOptions = {
  format: "jpeg",
  quality: 90,
  max_size: null,
  metadata: "all",
  name_template: "",
  destination: "download",
  dest_dir: null,
  sharpen: "off",
  watermark_text: "",
  watermark_corner: "br",
  watermark_size: "medium",
  watermark_opacity: 60,
};

// What a file name may ask for (mirrors backend services/name_template.py).
const PLACEHOLDERS = ["name", "date", "time", "seq", "camera", "rating"];
const PLACEHOLDER_HINT = PLACEHOLDERS.map((p) => `{${p}}`).join(" ");

// Why a typed template can't be used, or null. The server checks again; this
// is only so the dialog can say it while it is being typed.
function templateError(template: string): string | null {
  const unknown = Array.from(template.matchAll(/\{([^{}]*)\}/g))
    .map((m) => m[1])
    .find((p) => !PLACEHOLDERS.includes(p));
  if (unknown !== undefined) return `Unknown placeholder {${unknown}}.`;
  const literal = template.replace(/\{[^{}]*\}/g, "");
  if (/[{}]/.test(literal)) return "A placeholder is written like {name}.";
  if (/[<>:"/\\|?*]/.test(literal)) return 'A file name can\'t contain / \\ : * ? " < > or |.';
  return null;
}

// The last two folders of a path - enough to recognise it in a dropdown.
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

function sameOptions(a: ExportOptions, b: ExportOptions): boolean {
  return (
    a.format === b.format &&
    a.quality === b.quality &&
    a.max_size === b.max_size &&
    a.metadata === b.metadata &&
    a.name_template === b.name_template &&
    a.destination === b.destination &&
    (a.destination === "download" || a.dest_dir === b.dest_dir) &&
    a.sharpen === b.sharpen &&
    a.watermark_text === b.watermark_text &&
    // Where and how a watermark is drawn only matters when there is one.
    (!a.watermark_text.trim() ||
      (a.watermark_corner === b.watermark_corner &&
        a.watermark_size === b.watermark_size &&
        a.watermark_opacity === b.watermark_opacity))
  );
}

// Writing into a folder is the desktop app's: a browser has no folder to
// hand the server. Named after the OS's own file manager, like its menus.
const pickFolder = window.photoManager?.pickFolder;
const revealFile = window.photoManager?.revealFile;
const REVEAL_LABEL =
  window.photoManager?.platform === "darwin"
    ? "Show in Finder"
    : window.photoManager?.platform === "win32"
      ? "Show in Explorer"
      : "Show in file manager";

// Stored options as this build can use them: a remembered folder means
// nothing where there is no folder dialog to have picked it with.
function usable(stored: ExportOptions): ExportOptions {
  const options = { ...DEFAULT_OPTIONS, ...stored };
  return pickFolder && options.dest_dir ? options : { ...options, destination: "download" };
}

// One export dialog for both entry points: the photo page passes a single id,
// the grids' context menu the whole selection. Same options either way - a
// download is a plain file for one photo and a zip for several, a folder
// export writes the files side by side. Every row is always there (one that
// doesn't apply is disabled), so nothing moves as the options change.
export function ExportDialog({
  imageIds,
  singleFilename,
  onClose,
  closing = false,
}: {
  imageIds: string[];
  // Original filename of the one photo (single-photo entry point) - drives the
  // save dialog's suggested name; omitted for multi-selections (always a zip).
  singleFilename?: string;
  onClose: () => void;
  // Set by <Presence> while the dialog animates out.
  closing?: boolean;
}) {
  const dialogs = useAppDialogs();
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_OPTIONS);
  const [presets, setPresets] = useState<ExportPreset[]>([]);
  // The dialog opens the way it was last exported with - unless the user was
  // quicker than the settings request and has already changed something.
  const touchedRef = useRef(false);
  useEffect(() => {
    let alive = true;
    api.settings
      .getExport()
      .then((stored) => {
        if (!alive) return;
        setPresets(stored.presets);
        if (stored.last && !touchedRef.current) setOptions(usable(stored.last));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  function change(patch: Partial<ExportOptions>) {
    touchedRef.current = true;
    setOptions((o) => ({ ...o, ...patch }));
  }
  const { format, quality, metadata } = options;
  const maxSize = options.max_size;
  const toFolder = options.destination === "folder" && !!options.dest_dir;
  // A finished folder export: what was written where (the dialog stays to
  // say so - there is no save dialog whose closing would).
  const [written, setWritten] = useState<{
    dir: string;
    count: number;
    total: number;
    reveal: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  // Per-photo progress of the running export job, for the bar.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // Why the last export or preset change failed. Stays until the next try.
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

  const nameProblem = templateError(options.name_template);
  const single = imageIds.length === 1;
  const template = options.name_template.trim();
  // What the first photo will be called, from the server (it knows the
  // photo's date and camera). Asked again a moment after the typing stops;
  // the line under the field keeps the last answer until the next arrives.
  const [firstName, setFirstName] = useState<string | null>(null);
  const firstId = imageIds[0];
  useEffect(() => {
    if (nameProblem || !firstId) return;
    let alive = true;
    const timer = setTimeout(() => {
      api.images
        .exportNamePreview(imageIds, { format, name_template: template })
        .then((p) => alive && setFirstName(p.name))
        .catch(() => {});
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // imageIds is a fresh array on every render of some callers; its first
    // id and its length are what the preview depends on.
  }, [firstId, imageIds.length, format, template, nameProblem]);
  const matchedPreset = presets.find((p) => sameOptions(p.options, options)) ?? null;

  // Start the server-side job and poll its per-photo counter for the bar;
  // resolves with the finished job's last progress report.
  async function runJob() {
    const { job_id, total } = await api.images.exportStart(imageIds, {
      quality,
      max_size: maxSize,
      format,
      metadata,
      name_template: template,
      dest_dir: toFolder ? options.dest_dir : null,
      sharpen: options.sharpen,
      watermark_text: options.watermark_text.trim(),
      watermark_corner: options.watermark_corner,
      watermark_size: options.watermark_size,
      watermark_opacity: options.watermark_opacity,
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
        return { job_id, progress: p };
      }
    }
  }

  // Job-based export (every format). Into a folder the server writes the
  // files itself. As a download the save-location question comes FIRST
  // (saveDownload opens the picker before running its blob callback), then
  // the server renders/zips in a worker thread, and the finished file
  // streams into the chosen target.
  async function doExport() {
    setBusy(true);
    setError(null);
    // The next export opens with these choices.
    void api.settings.updateExport({ last: options }).catch(() => {});
    try {
      if (toFolder) {
        const { job_id, progress: p } = await runJob();
        // Nothing to download: drop the finished job instead of leaving it
        // to the server's clean-up.
        void api.images.exportCancel(job_id).catch(() => {});
        setBusy(false);
        setProgress(null);
        setWritten({ dir: p.dest_dir ?? options.dest_dir!, count: p.written, total: p.total, reveal: p.reveal_path });
        return;
      }
      // One photo downloads under its own (templated) name - asked fresh, the
      // shown preview may be a keystroke behind.
      const suggestedName = !single
        ? format === "original"
          ? "photos.zip"
          : "export.zip"
        : ((await api.images.exportNamePreview(imageIds, { format, name_template: template })).name ??
          singleFilename ??
          "export.jpg");
      const ext = suggestedName.includes(".") ? `.${suggestedName.split(".").pop()!.toLowerCase()}` : "";
      const accept: Record<string, string[]> =
        ext === ".zip"
          ? { "application/zip": [".zip"] }
          : ext === ".jpg" || ext === ".jpeg"
            ? { "image/jpeg": [".jpg", ".jpeg"] }
            : ext === ".tif"
              ? { "image/tiff": [".tif", ".tiff"] }
              : { "application/octet-stream": ext ? [ext] : [] };
      let started = false;
      await saveDownload(suggestedName, accept, async () => {
        started = true;
        const { job_id } = await runJob();
        return api.images.exportResultBlob(job_id);
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
      if ((e as Error).message !== "cancelled") setError((e as Error).message, { keep: true });
    }
  }

  // "Ask where to save" / the remembered folder / pick another one.
  async function chooseDestination(value: string) {
    if (value === "download") return change({ destination: "download" });
    if (value === "folder") return change({ destination: "folder" });
    const dir = await pickFolder?.({ title: "Export to folder", defaultPath: options.dest_dir ?? undefined });
    if (dir) change({ destination: "folder", dest_dir: dir });
  }

  async function savePreset() {
    const name = await dialogs.prompt({
      title: "Save export preset",
      message: "Everything in this dialog as it is set now.",
      placeholder: "Preset name",
      initial: matchedPreset?.name,
      confirmLabel: "Save",
    });
    if (!name) return;
    const next = [...presets.filter((p) => p.name !== name), { name, options }];
    setPresets(next);
    try {
      setPresets((await api.settings.updateExport({ presets: next })).presets);
    } catch (e) {
      setError((e as Error).message, { keep: true });
    }
  }

  async function deletePreset() {
    if (!matchedPreset) return;
    const next = presets.filter((p) => p.name !== matchedPreset.name);
    setPresets(next);
    try {
      setPresets((await api.settings.updateExport({ presets: next })).presets);
    } catch (e) {
      setError((e as Error).message, { keep: true });
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

  // Escape closes the dialog, but never a running export: that takes the
  // Cancel button, the way a click beside the dialog doesn't stop it either.
  useEscapeToClose(!closing, () => {
    if (!busy) onClose();
  });

  if (written) {
    const missing = written.total - written.count;
    return (
      <div className={`modal-overlay${closing ? " pm-closing" : ""}`} onClick={onClose}>
        <div
          className="modal pair-delete-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Export finished"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="pair-delete-body">
            <h3>{written.count === 1 ? "1 photo exported" : `${written.count} photos exported`}</h3>
            <p className="settings-desc export-dest-path" style={{ margin: 0 }} title={written.dir}>
              {written.dir}
            </p>
            {missing > 0 && (
              <span className="status-note status-note--error">
                {missing === 1 ? "1 photo" : `${missing} photos`} could not be rendered and{" "}
                {missing === 1 ? "was" : "were"} left out.
              </span>
            )}
            <div className="pair-delete-actions">
              {revealFile && (
                <button
                  className="btn primary"
                  onClick={() => {
                    void revealFile(written.reveal ?? written.dir);
                    onClose();
                  }}
                >
                  {REVEAL_LABEL}
                </button>
              )}
              <button className={`btn ${revealFile ? "ghost" : "primary"}`} onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const rendered = format !== "original";
  const marked = rendered && !!options.watermark_text.trim();

  return (
    <div className={`modal-overlay${closing ? " pm-closing" : ""}`} onClick={() => !busy && onClose()}>
      <div
        className="modal export-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Export"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pair-delete-body export-body">
          <h3>{single ? "Export photo" : `Export ${imageIds.length} photos`}</h3>
          <div className="export-grid">
            <div className="editor-slider export-wide">
              <span className="editor-slider-head">
                <span>Preset</span>
                <span className="export-preset-actions">
                  <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={savePreset}>
                    Save…
                  </button>
                  <button
                    type="button"
                    className="btn ghost btn-sm"
                    disabled={busy || !matchedPreset}
                    onClick={deletePreset}
                  >
                    Delete
                  </button>
                </span>
              </span>
              <Dropdown
                value={matchedPreset?.name ?? ""}
                disabled={busy}
                ariaLabel="Export preset"
                placeholder="Custom"
                emptyLabel="No presets saved"
                onChange={(name) => {
                  const preset = presets.find((p) => p.name === name);
                  if (preset) {
                    touchedRef.current = true;
                    setOptions(usable(preset.options));
                  }
                }}
                options={presets.map((p) => ({ value: p.name, label: p.name }))}
              />
            </div>
            <div className="editor-slider">
              <span className="editor-slider-head">
                <span>Format</span>
              </span>
              <Dropdown
                value={format}
                disabled={busy}
                ariaLabel="Export format"
                onChange={(v) => change({ format: v as ExportFormat })}
                options={[
                  { value: "jpeg", label: "JPEG with edits applied" },
                  { value: "tiff", label: "TIFF, 16-bit, with edits applied" },
                  { value: "original", label: "Original files, unchanged" },
                ]}
              />
            </div>
            <div className="editor-slider">
              <span className="editor-slider-head">
                <span>Size</span>
              </span>
              <Dropdown
                value={String(maxSize ?? "")}
                disabled={busy || !rendered}
                ariaLabel="Export size"
                onChange={(v) => change({ max_size: v === "" ? null : Number(v) })}
                options={SIZE_OPTIONS.map((opt) => ({
                  value: String(opt.value ?? ""),
                  label: opt.label,
                }))}
              />
            </div>
            <label className="editor-slider">
              <span className="editor-slider-head">
                <span>JPEG quality</span>
                <span className="editor-slider-val">{format === "jpeg" ? quality : "–"}</span>
              </span>
              <input
                type="range"
                min={60}
                max={100}
                step={1}
                value={quality}
                disabled={busy || format !== "jpeg"}
                style={rangeFillStyle(quality, 60, 100)}
                onChange={(e) => change({ quality: Number(e.target.value) })}
              />
            </label>
            <div className="editor-slider">
              <span className="editor-slider-head">
                <span>Sharpen for output</span>
              </span>
              <Dropdown
                value={rendered ? options.sharpen : "off"}
                disabled={busy || !rendered}
                ariaLabel="Output sharpening"
                onChange={(v) => change({ sharpen: v as ExportSharpen })}
                options={[
                  { value: "off", label: "Off" },
                  { value: "low", label: "Low" },
                  { value: "standard", label: "Standard" },
                  { value: "high", label: "High" },
                ]}
              />
            </div>
            <div className="editor-slider">
              <span className="editor-slider-head">
                <span>Metadata</span>
              </span>
              <Dropdown
                value={rendered ? metadata : "all"}
                disabled={busy || !rendered}
                ariaLabel="Metadata in the exported files"
                onChange={(v) => change({ metadata: v as ExportMetadata })}
                options={[
                  { value: "all", label: "Camera data, stars and tags" },
                  { value: "no_location", label: "The same, without the location" },
                  { value: "none", label: "None" },
                ]}
              />
            </div>
            <div className="editor-slider">
              <span className="editor-slider-head">
                <span>Save to</span>
              </span>
              <Dropdown
                value={toFolder ? "folder" : "download"}
                disabled={busy || !pickFolder}
                ariaLabel="Where the export is saved"
                title={toFolder ? (options.dest_dir ?? undefined) : undefined}
                onChange={(v) => void chooseDestination(v)}
                options={[
                  { value: "download", label: single ? "Ask where to save" : "Ask where to save (a zip)" },
                  ...(options.dest_dir ? [{ value: "folder", label: `Folder: ${shortPath(options.dest_dir)}` }] : []),
                  { value: "choose", label: options.dest_dir ? "Another folder…" : "A folder…" },
                ]}
              />
            </div>
            <label className="editor-slider export-wide">
              <span className="editor-slider-head">
                <span>File name</span>
              </span>
              <input
                type="text"
                value={options.name_template}
                placeholder="{name}"
                disabled={busy}
                spellCheck={false}
                aria-invalid={!!nameProblem}
                title={`Placeholders: ${PLACEHOLDER_HINT}`}
                onChange={(e) => change({ name_template: e.target.value })}
              />
              <span className={`status-note export-name-hint${nameProblem ? " status-note--error" : ""}`}>
                {nameProblem ?? `${firstName ?? "\u00a0"}  ·  ${PLACEHOLDER_HINT}`}
              </span>
            </label>
            <div className="editor-slider export-wide">
              <span className="editor-slider-head">
                <span>Watermark</span>
              </span>
              <div className="export-watermark">
                <input
                  type="text"
                  value={options.watermark_text}
                  placeholder="None – type a line, e.g. © your name"
                  disabled={busy || !rendered}
                  aria-label="Watermark text"
                  onChange={(e) => change({ watermark_text: e.target.value })}
                />
                <Dropdown
                  value={options.watermark_corner}
                  disabled={busy || !marked}
                  ariaLabel="Watermark corner"
                  onChange={(v) => change({ watermark_corner: v as ExportOptions["watermark_corner"] })}
                  options={[
                    { value: "br", label: "Bottom right" },
                    { value: "bl", label: "Bottom left" },
                    { value: "tr", label: "Top right" },
                    { value: "tl", label: "Top left" },
                  ]}
                />
                <Dropdown
                  value={options.watermark_size}
                  disabled={busy || !marked}
                  ariaLabel="Watermark size"
                  onChange={(v) => change({ watermark_size: v as ExportOptions["watermark_size"] })}
                  options={[
                    { value: "small", label: "Small" },
                    { value: "medium", label: "Medium" },
                    { value: "large", label: "Large" },
                  ]}
                />
                <Dropdown
                  value={String(options.watermark_opacity)}
                  disabled={busy || !marked}
                  ariaLabel="Watermark opacity"
                  onChange={(v) => change({ watermark_opacity: Number(v) })}
                  options={[30, 45, 60, 80, 100].map((n) => ({ value: String(n), label: `${n}%` }))}
                />
              </div>
            </div>
          </div>
          <div className="export-status" role="status" aria-live="polite">
            {error ? (
              <span className="status-note status-note--error">{error}</span>
            ) : busy && progress ? (
              <>
                <div className="settings-progress">
                  <div
                    className="settings-progress-fill"
                    style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
                  />
                </div>
                <span className="status-note">
                  {rendered ? "Rendering" : "Preparing"}{" "}
                  {progress.total === 1
                    ? "your photo"
                    : `photo ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`}
                  … Please keep this window open.
                </span>
              </>
            ) : null}
          </div>
          <div className="export-actions">
            <button className="btn ghost" onClick={onCancel}>
              Cancel
            </button>
            <button className="btn primary" onClick={doExport} disabled={busy || !!nameProblem}>
              {busy ? (
                <>
                  <Spinner tone="inherit" inline />
                  Exporting…
                </>
              ) : (
                <>
                  <IconExport size={13} /> Export
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { LibraryMergeSummary } from "../api/types";
import { formatEta } from "../utils/duration";
import { useTransientMessage } from "../utils/transientMessage";
import { IconFolder, IconImport, IconX } from "./Icons";
import { Spinner } from "./Spinner";

function size(bytes: number): string {
  if (bytes < 1e9) return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

// Merging a second Rollfilm library into this one - the drive that came along
// on a trip. Importing that drive as a plain folder brings the photos in too,
// but leaves every star, colour and edit made on the road behind; that is the
// whole reason this exists, so the copy says so.
//
// The merge itself runs in the backend, not in this request: it can be hours of
// copying, and the rest of Rollfilm has to stay usable meanwhile. So this
// component owns no run state of its own - it polls, which also means leaving
// the page and coming back picks the run up again exactly where it is, and the
// outcome is still here afterwards.
//
// Desktop only: it needs a native folder path to read the other library's
// database, which a browser file picker can't give.
export function ImportLibrary() {
  const electron = typeof window !== "undefined" ? window.photoManager : undefined;
  const [summary, setSummary] = useState<LibraryMergeSummary | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useTransientMessage(12000);
  const queryClient = useQueryClient();

  const { data: progress } = useQuery({
    queryKey: ["library-merge-progress"],
    queryFn: () => api.maintenance.mergeLibraryProgress(),
    enabled: Boolean(electron?.pickFolder),
    // Only while something is running - an idle merge shouldn't cost a request
    // a second forever.
    refetchInterval: (query) => (query.state.data?.active ? 1000 : false),
  });
  const running = Boolean(progress?.active);
  const result = progress?.result ?? null;

  async function inspect(path: string) {
    setSummary(null);
    try {
      setReading(true);
      setSummary(await api.maintenance.inspectLibraryMerge(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that library", { keep: true });
    } finally {
      setReading(false);
    }
  }

  async function choose() {
    const path = await electron?.pickFolder();
    if (path) await inspect(path);
  }

  // The drop zone takes a folder dragged in from the Finder. It claims the
  // drop (preventDefault) so the window's own handler does not start a photo
  // import from the same folder. A depth counter for the highlight: every
  // child under the pointer fires its own enter/leave pair.
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  function onDragEnter(e: React.DragEvent) {
    if (!hasFiles(e)) return;
    depth.current += 1;
    setOver(true);
  }
  function onDragLeave(e: React.DragEvent) {
    if (!hasFiles(e)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  }
  function onDrop(e: React.DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    if (running || reading) return;
    const item = e.dataTransfer.items[0];
    const file = e.dataTransfer.files[0];
    if (!item || !file) return;
    if (!item.webkitGetAsEntry()?.isDirectory) {
      setError("Drop the library's folder, not a file", { keep: true });
      return;
    }
    const path = electron?.pathForFile?.(file) ?? "";
    if (!path) {
      setError("Could not read the dropped folder's path", { keep: true });
      return;
    }
    void inspect(path);
  }

  async function start() {
    if (!summary) return;
    try {
      await api.maintenance.mergeLibrary(summary.library_root);
      setSummary(null);
      // Pick the running state up straight away rather than on the next tick.
      queryClient.invalidateQueries({ queryKey: ["library-merge-progress"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The import could not be started", { keep: true });
    }
  }

  async function cancel() {
    // The backend stops between two photos, so this takes a moment; the
    // progress line above the button (and the title bar's pill) runs on
    // until it has.
    await api.maintenance.cancelLibraryMerge();
    queryClient.invalidateQueries({ queryKey: ["library-merge-progress"] });
    // Whatever came across before the stop is in the library now.
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  if (!electron?.pickFolder) return null;

  return (
    <section className="settings-section">
      <p className="import-panel-desc">
        Merge another Rollfilm library into this one. Ratings, labels, edits, tags and albums come
        along. The other library is only read.
      </p>

      {running && (
        <div className="merge-summary">
          <p className="import-panel-desc">
            <Spinner inline />
            {progress!.total > 0
              ? `${progress!.done} of ${progress!.total} photos`
              : "Reading the other library…"}
            {progress!.copied_bytes > 0 && ` · ${size(progress!.copied_bytes)} copied`}
            {progress!.eta_seconds != null && ` · about ${formatEta(progress!.eta_seconds)} left`}
          </p>
          <p className="import-panel-desc">
            You can keep using Rollfilm while this runs.
          </p>
          <div className="merge-summary-actions">
            <button className="btn" onClick={cancel}>
              <IconX size={13} /> Cancel
            </button>
          </div>
        </div>
      )}

      {!running && !summary && (
        <div
          className={`import-dropzone${over ? " dragover" : ""}${reading ? " disabled" : ""}`}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={(e) => {
            if (hasFiles(e)) e.preventDefault();
          }}
          onDrop={onDrop}
        >
          {reading ? <Spinner /> : <IconFolder size={22} />}
          <strong>{reading ? "Reading the library…" : "Drop a Rollfilm library folder here"}</strong>
          <div className="control-group import-dropzone-actions">
            {!reading && (
              <button className="btn primary btn-sm" onClick={choose} title="Choose the other library's folder">
                <span className="btn-label"><IconFolder size={13} /> Choose library folder…</span>
              </button>
            )}
          </div>
          <span>The folder that holds the other library's photos and its Rollfilm data.</span>
        </div>
      )}

      {!running && summary && (
        <div className="merge-summary">
          <p className="import-panel-desc">
            <strong>{summary.library_root}</strong>
          </p>
          <ul className="merge-summary-list">
            <li>
              <strong>{summary.new_photos}</strong> photo{summary.new_photos === 1 ? "" : "s"} to
              copy over ({size(summary.bytes_to_copy)})
            </li>
            {summary.known_photos > 0 && (
              <li>
                <strong>{summary.known_photos}</strong> already in this library. Only their ratings
                and edits are updated.
              </li>
            )}
            {summary.albums > 0 && (
              <li>
                {summary.albums} album{summary.albums === 1 ? "" : "s"} and {summary.tags} tag
                {summary.tags === 1 ? "" : "s"}, merged by name
              </li>
            )}
          </ul>
          <div className="merge-summary-actions">
            <button className="btn primary" onClick={start} disabled={summary.photos === 0}>
              <IconImport size={13} /> {summary.photos === 0 ? "Nothing to import" : "Import into this library"}
            </button>
            <button className="btn" onClick={() => setSummary(null)}>
              <IconX size={13} /> Cancel
            </button>
          </div>
        </div>
      )}

      {!running && result && (
        <p className="status-note">
          {result.canceled ? "Stopped" : "Done"}: {result.added} photo
          {result.added === 1 ? "" : "s"} added
          {result.updated > 0 && `, ${result.updated} updated`}
          {result.skipped > 0 && `, ${result.skipped} skipped (file missing)`}.
          {result.canceled && " Run it again to continue where it stopped."}
        </p>
      )}

      {progress?.error && <p className="status-note status-note--error">{progress.error}</p>}
      {error && <p className="status-note status-note--error">{error}</p>}
    </section>
  );
}

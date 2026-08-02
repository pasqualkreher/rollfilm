import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { LibraryMergeSummary } from "../api/types";
import { useWait } from "../state/wait";
import { formatEta } from "../utils/duration";
import { useTransientMessage } from "../utils/transientMessage";

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
  const { withWait } = useWait();
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

  async function choose() {
    const path = await electron?.pickFolder();
    if (!path) return;
    setSummary(null);
    try {
      setReading(true);
      setSummary(await api.maintenance.inspectLibraryMerge(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that library");
    } finally {
      setReading(false);
    }
  }

  async function start() {
    if (!summary) return;
    try {
      await api.maintenance.mergeLibrary(summary.library_root);
      setSummary(null);
      // Pick the running state up straight away rather than on the next tick.
      queryClient.invalidateQueries({ queryKey: ["library-merge-progress"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The import could not be started");
    }
  }

  async function cancel() {
    // The backend stops between two photos, so this takes a moment - hold the
    // screen until it has actually stopped rather than leaving a button that
    // looks like it did nothing.
    await withWait("Stopping the import…", async () => {
      await api.maintenance.cancelLibraryMerge();
      for (let i = 0; i < 60; i++) {
        const p = await api.maintenance.mergeLibraryProgress();
        if (!p.active) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    });
    queryClient.invalidateQueries({ queryKey: ["library-merge-progress"] });
    // Whatever came across before the stop is in the library now.
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  if (!electron?.pickFolder) return null;

  return (
    <div className="import-panel">
      <h3 className="import-panel-title">Import a library</h3>
      <p className="import-panel-desc">
        Took a second drive travelling and worked on the photos there? Point Rollfilm at that
        library and it folds into this one — <strong>with</strong> the stars, colour labels,
        edits, tags and albums you gave them on the trip. Nothing here is removed, and the other
        drive is only read.
      </p>

      {running && (
        <div className="merge-summary">
          <p className="import-panel-desc">
            <span className="btn-spinner" aria-hidden="true" />{" "}
            {progress!.total > 0
              ? `${progress!.done} of ${progress!.total} photos`
              : "Reading the other library…"}
            {progress!.copied_bytes > 0 && ` · ${size(progress!.copied_bytes)} copied`}
            {progress!.eta_seconds != null && ` · about ${formatEta(progress!.eta_seconds)} left`}
          </p>
          <p className="import-panel-desc">
            You can keep using Rollfilm while this runs — browse, edit, even import a card.
          </p>
          <div className="merge-summary-actions">
            <button className="btn" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {!running && !summary && (
        <button className="btn" onClick={choose} disabled={reading}>
          {reading ? "Reading…" : "Choose library folder…"}
        </button>
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
                <strong>{summary.known_photos}</strong> already here — the file stays as it is,
                only the ratings and edits from the trip come across
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
              {summary.photos === 0 ? "Nothing to import" : "Import into this library"}
            </button>
            <button className="btn" onClick={() => setSummary(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {!running && result && (
        <p className="status-note">
          {result.canceled ? "Stopped" : "Done"} — {result.added} photo
          {result.added === 1 ? "" : "s"} added
          {result.updated > 0 && `, ${result.updated} updated from the trip`}
          {result.skipped > 0 && `, ${result.skipped} skipped (file missing)`}.
          {result.canceled && " Running it again picks up where this left off."}
        </p>
      )}

      {progress?.error && <p className="status-note status-note--error">{progress.error}</p>}
      {error && <p className="status-note status-note--error">{error}</p>}
    </div>
  );
}

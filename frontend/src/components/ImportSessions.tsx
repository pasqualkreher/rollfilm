import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ImportSessionSummary } from "../api/types";
import { useImportSession } from "../state/importSession";
import { useAppDialogs } from "./AppDialogs";
import { useWait } from "../state/wait";
import { IconTrash } from "./Icons";

function lastWorkedOn(s: ImportSessionSummary): string {
  return new Date(s.updated_at ?? s.created_at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

// Import sessions live until the user ends them - a card culled a hundred
// photos a day stays open with the rest, and continuing it brings the review
// back as it was left and copies whatever of the card isn't copied yet.
// Nothing here when no session is open.
export function ImportSessions() {
  const { continueSession, isUploading } = useImportSession();
  const dialogs = useAppDialogs();
  const { withWait } = useWait();
  const queryClient = useQueryClient();
  const { data: sessions } = useQuery({
    queryKey: ["import-sessions"],
    queryFn: () => api.import.sessions(),
    // Picks up a card being plugged in while the page is open.
    refetchInterval: 10000,
  });

  if (!sessions || sessions.length === 0) return null;

  async function discard(s: ImportSessionSummary) {
    const confirmed = await dialogs.confirm({
      title: `Discard the session “${s.source_path}”?`,
      message:
        (s.imported_count > 0
          ? `The ${plural(s.imported_count, "photo", "photos")} already added from it stay in your library. `
          : "Nothing from it is in your library yet. ") +
        "Its review, selection and copied files are removed. The original files stay where they are.",
      confirmLabel: "Discard session",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await withWait("Discarding this import…", () => api.import.discard(s.id));
    } finally {
      queryClient.invalidateQueries({ queryKey: ["import-sessions"] });
    }
  }

  return (
    <section className="import-panel">
      <h3 className="section-title">Open import sessions</h3>
      <p className="import-panel-desc">
        Continue where you left off. Your selection and ratings are kept, and only photos that
        aren't copied yet are copied.
      </p>
      <div className="source-list">
        {sessions.map((s) => {
          // A session collects from one or more folders; each is continued on
          // its own, so each says for itself whether it is reachable and what
          // it still holds.
          const waiting = s.sources.filter((src) => !src.available && src.remaining !== 0);
          const remaining = s.sources.reduce((sum, src) => sum + (src.remaining ?? 0), 0);
          const toReview = s.file_count - s.imported_count - s.duplicate_count;
          return (
            <div key={s.id} className={`source-row${waiting.length > 0 ? " disconnected" : ""}`}>
              <div className="source-row-main">
                <span className="source-name">
                  {s.source_path}
                  {waiting.length > 0 && (
                    <span className="source-disconnected-badge">Not connected</span>
                  )}
                </span>
                <span className="source-meta">
                  {plural(toReview, "photo", "photos")} to review
                  {s.imported_count > 0 && ` · ${s.imported_count.toLocaleString()} in library`}
                  {remaining > 0 && ` · ${remaining.toLocaleString()} not copied yet`}
                  {` · last worked on ${lastWorkedOn(s)}`}
                </span>
                {s.sources.length > 0 && (
                  <span className="source-meta">
                    {s.sources.map((src, i) => (
                      <span key={src.id}>
                        {i > 0 && " · "}
                        {src.label}
                        {!src.available
                          ? " (not connected)"
                          : src.remaining
                            ? ` (${src.remaining.toLocaleString()} to copy)`
                            : ""}
                      </span>
                    ))}
                  </span>
                )}
              </div>
              <div className="source-row-actions">
                <button
                  className="btn primary btn-sm"
                  onClick={() => continueSession(s)}
                  disabled={isUploading}
                  title={
                    isUploading
                      ? "Available when the running import has finished copying"
                      : "Open this session where you left off"
                  }
                >
                  Continue
                </button>
                <button
                  className="btn btn-sm quiet-danger"
                  aria-label={`Discard session "${s.source_path}"`}
                  title="Discard this session. Photos already added to the library stay."
                  onClick={() => discard(s)}
                  disabled={isUploading}
                >
                  <IconTrash size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

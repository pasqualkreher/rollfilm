import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ImportSessionSummary } from "../api/types";
import { useImportSession } from "../state/importSession";
import { useAppDialogs } from "./AppDialogs";
import { useWait } from "../state/wait";
import { IconFolder, IconLeave, IconRename, IconResume } from "./Icons";

function lastWorkedOn(s: ImportSessionSummary): string {
  return new Date(s.updated_at ?? s.created_at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

// Closing a session ends it for good: what was added stays in the library, the
// review goes. A copy session's collection folder is the user's call - kept
// with the copies that weren't added, or deleted with them. Null when the user
// backs out.
export async function askToCloseSession(
  dialogs: ReturnType<typeof useAppDialogs>,
  label: string,
  importedCount: number,
  collectionFolder: string | null
): Promise<{ keepFolder: boolean } | null> {
  const title = `Close the session “${label}”?`;
  const added =
    importedCount > 0
      ? `The ${plural(importedCount, "photo", "photos")} you added stay in your library. `
      : "Nothing was added to your library. ";
  if (!collectionFolder) {
    const ok = await dialogs.confirm({
      title,
      message: added + "Your original files are not touched.",
      confirmLabel: "Close session",
      danger: true,
    });
    return ok ? { keepFolder: false } : null;
  }
  const choice = await dialogs.choose({
    title,
    message:
      added +
      `Keep the folder ${collectionFolder} with the rest of the copies, or delete it? ` +
      "Your original files are not touched.",
    altLabel: "Keep folder",
    confirmLabel: "Delete folder",
    danger: true,
  });
  return choice === null ? null : { keepFolder: choice === "alt" };
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

  async function close(s: ImportSessionSummary) {
    const answer = await askToCloseSession(dialogs, s.source_path, s.imported_count, s.staging_dir);
    if (!answer) return;
    try {
      await withWait("Closing this session…", () => api.import.discard(s.id, answer.keepFolder));
    } finally {
      queryClient.invalidateQueries({ queryKey: ["import-sessions"] });
    }
  }

  async function rename(s: ImportSessionSummary) {
    const next = await dialogs.prompt({
      title: "Rename this session",
      initial: s.source_path,
      confirmLabel: "Rename",
    });
    const trimmed = next?.trim();
    if (!trimmed || trimmed === s.source_path) return;
    try {
      // Renames a copy session's collection folder too.
      await api.import.rename(s.id, trimmed);
    } catch (e) {
      await dialogs.alert({
        title: "Could not rename this session",
        message: e instanceof Error ? e.message : String(e),
      });
    }
    queryClient.invalidateQueries({ queryKey: ["import-sessions"] });
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
            // The actions stay on the right whatever the text does: the row
            // must not wrap them under a long collection-folder path.
            <div
              key={s.id}
              className={`source-row${waiting.length > 0 ? " disconnected" : ""}`}
              style={{ flexWrap: "nowrap" }}
            >
              <div className="source-row-main" style={{ flex: 1, minWidth: 0 }}>
                <span className="source-name">
                  {s.source_path}
                  {s.mode === "reference" && (
                    <span className="badge-inline" title="Photos are added from where they are, nothing is copied">
                      In place
                    </span>
                  )}
                  {waiting.length > 0 && (
                    <span className="source-disconnected-badge">Not connected</span>
                  )}
                </span>
                <span className="source-meta">
                  {plural(toReview, "photo", "photos")} to review
                  {s.imported_count > 0 && ` · ${s.imported_count.toLocaleString()} in library`}
                  {remaining > 0 &&
                    ` · ${remaining.toLocaleString()} not ${s.mode === "reference" ? "added" : "copied"} yet`}
                  {` · last worked on ${lastWorkedOn(s)}`}
                </span>
                {s.staging_dir && (
                  <span className="source-path" title="This session's collection folder">
                    {s.staging_dir}
                  </span>
                )}
                {s.sources.length > 0 && (
                  // Said outright: once the session has a name of its own, a bare
                  // folder name here read like a leftover second title.
                  <span className="source-meta">
                    <IconFolder size={12} /> {s.sources.length === 1 ? "Source: " : "Sources: "}
                    {s.sources.map((src, i) => (
                      <span key={src.id} title={src.current_root ?? src.root}>
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
                  <IconResume size={14} /> Continue
                </button>
                <button
                  className="btn btn-sm"
                  aria-label={`Rename session "${s.source_path}"`}
                  title="Rename this session"
                  onClick={() => rename(s)}
                  disabled={isUploading}
                >
                  <IconRename size={14} />
                </button>
                <button
                  className="btn btn-sm quiet-danger"
                  title="Close this session. Photos already added stay in your library; a collection folder can be kept or deleted."
                  onClick={() => close(s)}
                  disabled={isUploading}
                >
                  <IconLeave size={14} /> Close session
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ImportMode, ImportSessionSummary } from "../api/types";
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

// What "Close session" does, said on the button: what was added stays in the
// library, and the session's files go the way it was set up at its start.
export function closeSessionTitle(
  mode: ImportMode | null,
  folder: string | null,
  keepBackup: boolean
): string {
  const added = "Close this session. Photos you added stay in your library";
  if (mode === "reference") return `${added}; no file is touched.`;
  if (!folder) return `${added}; the copies you didn't add are deleted.`;
  return keepBackup
    ? `${added}, and the import folder stays as your backup.`
    : `${added}; the import folder and the photos you didn't add are deleted.`;
}

// Closing a session ends it for good: what was added stays in the library, the
// review goes. What happens to its files was decided when it started, so
// nothing is asked - except to confirm when closing deletes copies of photos
// that were never added (`leftover` of them; null = not known yet, so ask).
// False when the user backs out.
export async function confirmCloseSession(
  dialogs: ReturnType<typeof useAppDialogs>,
  session: {
    label: string;
    mode: ImportMode | null;
    folder: string | null;
    keepBackup: boolean;
    leftover: number | null;
  }
): Promise<boolean> {
  const { label, mode, folder, keepBackup, leftover } = session;
  if (mode === "reference" || (folder && keepBackup) || leftover === 0) return true;
  const notAdded =
    leftover == null
      ? "Photos in this session may not have been added to your library. "
      : `${plural(leftover, "photo", "photos")} in this session ${leftover === 1 ? "was" : "were"} not added to your library. `;
  return dialogs.confirm({
    title: `Close the session “${label}”?`,
    message: folder
      ? notAdded +
        `Closing deletes the import folder ${folder}. ` +
        "Files on your card or source are not touched."
      : notAdded + "Closing deletes their copies. Originals are not touched.",
    confirmLabel: folder ? "Close and delete folder" : "Close session",
    danger: true,
  });
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
    const ok = await confirmCloseSession(dialogs, {
      label: s.source_path,
      mode: s.mode,
      folder: s.staging_dir,
      keepBackup: s.keep_backup,
      leftover: s.file_count - s.imported_count - s.duplicate_count,
    });
    if (!ok) return;
    try {
      // No folder flag: the server keeps a backup folder and deletes any other.
      await withWait("Closing this session…", () => api.import.discard(s.id));
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
        Continue where you left off. Selection and ratings are kept; only missing copies are made.
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
                  title={closeSessionTitle(s.mode, s.staging_dir, s.keep_backup)}
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

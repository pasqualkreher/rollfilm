import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ImportMode, ImportSessionSummary } from "../api/types";
import { useImportSession } from "../state/importSession";
import { useAppDialogs } from "./AppDialogs";
import { useTasks } from "../state/tasks";
import { IconFolder, IconLeave, IconRename, IconResume } from "./Icons";

function lastWorkedOn(s: ImportSessionSummary): string {
  return new Date(s.updated_at ?? s.created_at).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

// "42 GB", "850 MB": enough to say whether a session is worth closing.
function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} kB`;
}

// Where a session's photos are and what closing it does to them, in one
// sentence - the same fate the start dialog announced.
function folderSentence(s: ImportSessionSummary): string {
  if (s.mode === "reference") return "The photos stay where they are. Closing the session touches no files.";
  if (!s.staging_dir) {
    return "The photos are held inside the app. What you didn't add is deleted when you close the session.";
  }
  return s.keep_backup
    ? `Photos are in ${s.staging_dir}. The folder stays as a backup when you close the session.`
    : `Photos are in ${s.staging_dir}. The folder is deleted when you close the session.`;
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
export function ImportSessions({
  currentSessionId = null,
  onContinue,
}: {
  // The session whose review is open behind this page (the Import tab's step
  // up from the review): its row is marked, and Continue on it is handed to
  // the page, which brings the review back instead of re-continuing.
  currentSessionId?: string | null;
  onContinue?: (s: ImportSessionSummary) => void;
} = {}) {
  const { continueSession, isUploading } = useImportSession();
  const dialogs = useAppDialogs();
  const { runTask } = useTasks();
  const queryClient = useQueryClient();
  const { data: sessions } = useQuery({
    queryKey: ["import-sessions"],
    queryFn: () => api.import.sessions(),
    // Picks up a card being plugged in while the page is open.
    refetchInterval: 10000,
  });

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
      await runTask({ kind: "plain", label: "Closing this session…" }, () => api.import.discard(s.id));
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
      // Renames a copy session's import folder too.
      await api.import.rename(s.id, trimmed);
    } catch (e) {
      await dialogs.alert({
        title: "Could not rename this session",
        message: e instanceof Error ? e.message : String(e),
      });
    }
    queryClient.invalidateQueries({ queryKey: ["import-sessions"] });
  }

  const open = sessions ?? [];
  const heldBytes = open.reduce((sum, s) => sum + (s.folder_bytes ?? 0), 0);

  // The panel stays whether or not a session is open, so the page beside it
  // never jumps when the last one closes.
  return (
    <section className="settings-section">
      <h3 className="settings-section-header">
        Open sessions
        {open.length > 0 && (
          <span
            className="count-pill"
            title={heldBytes > 0 ? `${formatBytes(heldBytes)} in import folders` : undefined}
          >
            {open.length}
          </span>
        )}
      </h3>
      {open.length === 0 ? (
        <p className="import-panel-desc">No open sessions.</p>
      ) : (
        <div className="source-list">
          {open.map((s) => {
            // A session collects from one or more folders; each is continued on
            // its own, so each says for itself whether it is reachable and what
            // it still holds.
            const waiting = s.sources.filter((src) => !src.available && src.remaining !== 0);
            const remaining = s.sources.reduce((sum, src) => sum + (src.remaining ?? 0), 0);
            const toReview = s.file_count - s.imported_count - s.duplicate_count;
            // The sources are named only where the name doesn't already say
            // it: several of them, or one called differently from the session.
            const namedSources = s.sources.filter((src) => s.sources.length > 1 || src.label !== s.source_path);
            return (
              // Two lines and the buttons under them: the name, then the
              // figures. Where the photos are and what closing does is the
              // row's tip, and the Close button's.
              <div
                key={s.id}
                className={`source-row source-row--nowrap${waiting.length > 0 ? " disconnected" : ""}${
                  s.id === currentSessionId ? " source-row--current" : ""
                }`}
                title={folderSentence(s)}
              >
                <div className="source-row-main">
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
                    {remaining > 0 && ` · ${remaining.toLocaleString()} to ${s.mode === "reference" ? "add" : "copy"}`}
                    {` · ${lastWorkedOn(s)}`}
                  </span>
                  {namedSources.length > 0 && (
                    <span className="source-meta">
                      <IconFolder size={12} />{" "}
                      {namedSources.map((src, i) => (
                        <span key={src.id} title={src.current_root ?? src.root}>
                          {i > 0 && " · "}
                          {src.label}
                          {!src.available ? " (not connected)" : ""}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <div className="source-row-actions">
                  <button
                    className="btn primary btn-sm"
                    onClick={() => (onContinue ? onContinue(s) : continueSession(s))}
                    disabled={isUploading && s.id !== currentSessionId}
                    title={
                      s.id === currentSessionId
                        ? "Back to this session's review"
                        : isUploading
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
                    aria-label={`Close session "${s.source_path}"`}
                    title={closeSessionTitle(s.mode, s.staging_dir, s.keep_backup)}
                    onClick={() => close(s)}
                    disabled={isUploading}
                  >
                    <IconLeave size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

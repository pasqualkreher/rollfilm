import { useState } from "react";
import type { ImportChoice, ImportMode } from "../api/types";
import { IconDisk, IconFolder } from "./Icons";

type Outcome = "backup" | "copy" | "reference";

// What each answer does to the files, start to finish. All three are laid
// out on top of each other (see .import-start-steps) so switching the answer
// never changes the dialog's height.
const WHAT_HAPPENS: Record<Outcome, [string, string, string]> = {
  backup: [
    "All photos are copied to the import folder.",
    "The photos you add are copied into your library.",
    "When you close the session, the folder stays as your backup.",
  ],
  copy: [
    "All photos are copied to the import folder.",
    "The photos you add are moved into your library.",
    "When you close the session, the folder is deleted, with the photos you didn't add.",
  ],
  reference: [
    "Nothing is copied. The photos stay where they are.",
    "The photos you add are listed in your library from there.",
    "When you close the session, no file is touched.",
  ],
};
const OUTCOMES = Object.keys(WHAT_HAPPENS) as Outcome[];

// Asked once per import, right after the photos are picked and before anything
// is read - and everything about the session is decided here, so nothing is
// asked later: copy the photos into an import folder of the session's own
// (inside the library's Import folder, or wherever the user says) or leave
// them where they are, and for a copy whether that folder is kept as a backup
// or goes when the session closes. "Don't ask again" stores the answers as
// the default; Settings bring the question back.
export function ImportModeDialog({
  libraryRoot,
  defaultName,
  defaultBackup,
  onClose,
  onChoose,
  closing = false,
}: {
  // What the session is called unless the user types a name: the picked
  // folder's name, or "N selected files".
  defaultName: string;
  // The remembered backup answer, as the checkbox's starting state.
  defaultBackup: boolean;
  // The library folder; a session's import folder goes into its "Import"
  // folder by default. Null when the desktop bridge hasn't answered (yet).
  libraryRoot: string | null;
  onClose: () => void;
  onChoose: (choice: ImportChoice, remember: boolean) => void;
  // Set by <Presence> while the dialog animates out.
  closing?: boolean;
}) {
  const [mode, setMode] = useState<ImportMode>("copy");
  // Where the session's import folder is created; null = <library>/Import.
  const [stagingFolder, setStagingFolder] = useState<string | null>(null);
  const [keepBackup, setKeepBackup] = useState(defaultBackup);
  const [remember, setRemember] = useState(false);
  const [name, setName] = useState(defaultName);
  const desktop = typeof window !== "undefined" ? window.photoManager : undefined;
  const copy = mode === "copy";
  const outcome: Outcome = !copy ? "reference" : keepBackup ? "backup" : "copy";

  async function pickFolder() {
    const chosen = await desktop?.pickFolder?.();
    if (chosen) setStagingFolder(chosen);
  }
  const defaultBase = libraryRoot ? `${libraryRoot.replace(/\/+$/, "")}/Import` : null;
  const base = stagingFolder ?? defaultBase;
  // The session gets a folder of its own in there, named after it.
  const sessionName = name.trim() || defaultName;
  const baseDir = base ? `${base.replace(/\/+$/, "")}/` : "…";

  return (
    <div className={`modal-overlay${closing ? " pm-closing" : ""}`} onClick={onClose}>
      <div className="modal pair-delete-modal import-start-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pair-delete-body">
          <h3>New import session</h3>
          <label className="filter-field filter-field-inline" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span>Name</span>
            <input
              type="text"
              value={name}
              placeholder={defaultName}
              onChange={(e) => setName(e.target.value)}
              style={{ flex: 1 }}
              autoFocus
            />
          </label>
          <p className="settings-desc" style={{ margin: 0 }}>Where do the photos go?</p>
          <div className="copy-kind-choice" role="radiogroup" aria-label="Where the photos go">
            <button
              type="button"
              role="radio"
              aria-checked={copy}
              className={`copy-kind${copy ? " is-selected" : ""}`}
              onClick={() => setMode("copy")}
            >
              <span className="copy-kind-icon" aria-hidden="true">
                <IconDisk size={16} />
              </span>
              <span className="copy-kind-text">
                <strong>Copy to an import folder</strong>
                <span>All photos are copied first, so you can remove the card afterwards.</span>
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!copy}
              className={`copy-kind${!copy ? " is-selected" : ""}`}
              onClick={() => setMode("reference")}
            >
              <span className="copy-kind-icon" aria-hidden="true">
                <IconFolder size={16} />
              </span>
              <span className="copy-kind-text">
                <strong>Leave them where they are</strong>
                <span>Nothing is copied. For an archive or a NAS, not for a memory card.</span>
              </span>
            </button>
          </div>
          {/* Only a copy has an import folder - but its controls stay in
              place, switched off, so the dialog doesn't jump between modes. */}
          <div className={`import-start-folder${copy ? "" : " is-off"}`}>
            <div className="import-start-folder-row">
              <span className="import-start-folder-label">Import folder</span>
              {/* A long path gives way in the middle: the session's own
                  folder name at the end is the part worth reading. */}
              <span
                className="import-start-folder-path"
                title={copy && base ? baseDir + sessionName : undefined}
              >
                <span>{baseDir}</span>
                {base && <span>{sessionName}</span>}
              </span>
              <button
                type="button"
                className="btn btn-slim"
                title="Put the import folder somewhere else, for example on a bigger disk"
                onClick={pickFolder}
                disabled={!copy || !desktop?.pickFolder}
              >
                Change…
              </button>
              <button
                type="button"
                className="btn btn-slim"
                title="Use the Import folder in your library"
                onClick={() => setStagingFolder(null)}
                disabled={!copy || stagingFolder == null}
              >
                Use default
              </button>
            </div>
            <label className="filter-field filter-field-inline import-start-backup">
              <input
                type="checkbox"
                checked={keepBackup}
                disabled={!copy}
                onChange={(e) => setKeepBackup(e.target.checked)}
              />
              <span>
                Keep this folder as a backup
                <span className="import-start-hint">
                  Every photo stays in the import folder. The ones you add take up space twice.
                </span>
              </span>
            </label>
          </div>
          <div className="import-start-summary">
            <span className="settings-subhead">What happens</span>
            <div className="import-start-steps">
              {OUTCOMES.map((key) => (
                <ol key={key} className={key === outcome ? "is-active" : undefined} aria-hidden={key !== outcome}>
                  {WHAT_HAPPENS[key].map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              ))}
            </div>
          </div>
          <label className="filter-field filter-field-inline">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{" "}
            Don't ask again, always import like this (you can change this in Settings)
          </label>
          <div className="import-start-actions">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() =>
                onChoose(
                  {
                    mode,
                    stagingFolder: copy ? stagingFolder : null,
                    keepBackup: copy && keepBackup,
                    name: sessionName,
                  },
                  remember
                )
              }
            >
              Start import
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

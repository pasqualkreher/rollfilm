import { useState } from "react";
import type { ImportChoice, ImportMode } from "../api/types";
import { IconDisk, IconFolder } from "./Icons";

// Asked once per import, right after the photos are picked and before anything
// is read: collect the cards in a folder of the session's own (inside the
// library's Import folder, or wherever the user says) and sort the keepers
// into the library at commit - or leave them where they are and add the
// chosen ones from there. "Don't ask again" stores the mode as the default;
// Settings → Library brings the question back.
export function ImportModeDialog({
  libraryRoot,
  defaultName,
  onClose,
  onChoose,
  closing = false,
}: {
  // What the session is called unless the user types a name: the picked
  // folder's name, or "N selected files".
  defaultName: string;
  // The library folder; a session's collection folder goes into its "Import"
  // folder by default. Null when the desktop bridge hasn't answered (yet).
  libraryRoot: string | null;
  onClose: () => void;
  onChoose: (choice: ImportChoice, remember: boolean) => void;
  // Set by <Presence> while the dialog animates out.
  closing?: boolean;
}) {
  const [mode, setMode] = useState<ImportMode>("copy");
  // Where the session's collection folder is created; null = <library>/Import.
  const [stagingFolder, setStagingFolder] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);
  const [name, setName] = useState(defaultName);
  const desktop = typeof window !== "undefined" ? window.photoManager : undefined;
  const copy = mode === "copy";

  async function pickFolder() {
    const chosen = await desktop?.pickFolder?.();
    if (chosen) setStagingFolder(chosen);
  }
  const defaultFolder = libraryRoot ? `${libraryRoot.replace(/\/+$/, "")}/Import` : null;

  return (
    <div className={`modal-overlay${closing ? " pm-closing" : ""}`} onClick={onClose}>
      <div className="modal pair-delete-modal" onClick={(e) => e.stopPropagation()}>
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
          <p className="settings-desc" style={{ margin: 0 }}>How do you want to import?</p>
          <div className="copy-kind-choice" role="radiogroup" aria-label="How to import">
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
                <strong>Collect and copy to…</strong>
                <span>
                  The photos are copied into a folder first, so you can put the card away right
                  away. The ones you keep go into your library. When you're done, you decide whether
                  to keep the folder.
                </span>
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
                <span>
                  Nothing is copied. The photos you keep are added from where they are. Good for an
                  archive or a NAS, not for a memory card.
                </span>
              </span>
            </button>
          </div>
          {copy && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className="settings-path" style={{ margin: 0, flex: 1, minWidth: 0 }}>
                {stagingFolder ?? defaultFolder ?? "…"}
                {stagingFolder == null && defaultFolder != null && (
                  <span style={{ fontFamily: "inherit" }}> (in the library)</span>
                )}
              </span>
              {desktop?.pickFolder && (
                <button
                  type="button"
                  className="btn btn-slim"
                  title="Put the folder somewhere else, e.g. on a bigger disk"
                  onClick={pickFolder}
                >
                  Choose folder…
                </button>
              )}
              {stagingFolder != null && (
                <button
                  type="button"
                  className="btn btn-slim"
                  onClick={() => setStagingFolder(null)}
                  title="Use the Import folder in your library instead"
                >
                  Use library folder
                </button>
              )}
            </div>
          )}
          <label className="filter-field filter-field-inline">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{" "}
            Don't ask again (you can change this in Settings)
          </label>
          <div className="pair-delete-actions">
            <button
              className="btn primary"
              onClick={() =>
                onChoose(
                  { mode, stagingFolder: copy ? stagingFolder : null, name: name.trim() || defaultName },
                  remember
                )
              }
            >
              Continue
            </button>
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

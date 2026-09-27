import { useState } from "react";
import type { ImportAfterCommit } from "../api/types";

// Asked right after photos were added to the library: does the session stay
// open (to add more of the card later, or another card) or is it closed now?
// "Don't ask again" stores the answer; Settings → Library brings the question
// back. Backing out (overlay, Escape via the caller) counts as keeping the
// session - nothing is lost that way.
export function ImportAfterCommitDialog({
  added,
  collectionFolder,
  onChoose,
  onClose,
  closing = false,
}: {
  // How many photos this import just added.
  added: number;
  // A copy session's collection folder, when it has one: closing then asks
  // whether to keep it, and the dialog says so.
  collectionFolder: string | null;
  onChoose: (choice: Exclude<ImportAfterCommit, "ask">, remember: boolean) => void;
  onClose: () => void;
  // Set by <Presence> while the dialog animates out.
  closing?: boolean;
}) {
  const [remember, setRemember] = useState(false);
  const count = `${added.toLocaleString()} ${added === 1 ? "photo" : "photos"}`;
  return (
    <div className={`modal-overlay${closing ? " pm-closing" : ""}`} onClick={onClose}>
      <div className="modal pair-delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pair-delete-body">
          <h3>{count} added to your library</h3>
          <p className="settings-desc" style={{ margin: 0 }}>
            Keep this session open to add more later, or close it now? What you added stays in
            your library either way.
            {collectionFolder && " Closing asks whether to keep the collection folder."}
          </p>
          <label className="filter-field filter-field-inline">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{" "}
            Don't ask again (you can change this in Settings)
          </label>
          <div className="pair-delete-actions">
            <button className="btn primary" autoFocus onClick={() => onChoose("keep", remember)}>
              Keep session open
            </button>
            <button className="btn" onClick={() => onChoose("close", remember)}>
              Close session
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

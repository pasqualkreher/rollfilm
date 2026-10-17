import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ImportSettings } from "../api/types";
import { Desc, OptionRow } from "./SettingsControls";
import { IconFolder, IconRestore } from "./Icons";
import { useEscapeToClose } from "../utils/modalKeys";

// The import settings: what a new session does unless the start dialog says
// otherwise, and how a review starts out. Shown under Settings → Library →
// Import and, as a dialog, from the Import page's "Import settings…".
export function ImportSettingsPanel() {
  const queryClient = useQueryClient();
  const { data: importSettings } = useQuery({
    queryKey: ["import-settings"],
    queryFn: () => api.settings.getImport(),
  });
  const update = useMutation({
    mutationFn: (patch: Partial<Omit<ImportSettings, "staging_folder">> & { staging_folder?: string }) =>
      api.settings.updateImport(patch),
    onSuccess: (result) => queryClient.setQueryData(["import-settings"], result),
  });
  const busy = update.isPending;
  const ready = !!importSettings;

  // The copy options only mean something when photos are copied: with
  // "leave them where they are" they are hidden, keeping their values for
  // when copying is chosen again.
  const copyOff = importSettings?.mode_default === "reference";
  // With "ask every time" the start dialog asks for folder and backup at
  // each import, so they are not shown here. Verification is not in the
  // dialog and stays.
  const askedInDialog = (importSettings?.mode_default ?? "ask") === "ask";
  // A fixed import folder needs the desktop's folder dialog to choose it.
  const pickFolder = window.photoManager?.pickFolder;
  const fixedFolder = importSettings?.staging_folder ?? null;
  async function chooseFolder() {
    const chosen = await pickFolder?.({ title: "Import folder", defaultPath: fixedFolder ?? undefined });
    if (chosen) update.mutate({ staging_folder: chosen });
  }

  return (
    <>
      <div className="settings-subgroup">
        <h4 className="settings-subhead">When starting an import</h4>
        <Desc>Copy photos into an import folder first, or add them from where they are.</Desc>
        {(
          [
            ["ask", "Ask every time", "A dialog asks each time."],
            ["copy", "Always copy to an import folder", "Into the folder below, or asked for each session."],
            ["reference", "Always leave photos where they are", "Nothing is copied."],
          ] as const
        ).map(([value, title, desc]) => (
          <OptionRow
            key={value}
            type="radio"
            name="import-mode"
            checked={(importSettings?.mode_default ?? "ask") === value}
            disabled={!ready}
            busy={busy}
            onChange={() => update.mutate({ mode_default: value })}
            title={title}
            desc={desc}
          />
        ))}
        {/* Only what applies to the chosen answer is shown: nothing of this
            when photos stay where they are, and no folder or backup with "ask
            every time" (the start dialog asks for both). */}
        {ready && !copyOff && (
          <div className="settings-subgroup--indent">
            <h4 className="settings-subhead">When photos are copied</h4>
            {pickFolder && !askedInDialog && (
              <div className="import-folder-setting">
                <span className="import-folder-setting-label">Import folder</span>
                <span className="import-folder-setting-path" title={fixedFolder ?? undefined}>
                  {fixedFolder ?? "Asked for each session"}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void chooseFolder()}
                  disabled={busy}
                  title="Always copy into this folder, without asking"
                >
                  <IconFolder size={12} /> Choose…
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => update.mutate({ staging_folder: "" })}
                  disabled={busy || fixedFolder == null}
                  title="Ask for the folder again at every import"
                >
                  <IconRestore size={12} /> Ask each time
                </button>
              </div>
            )}
            {update.isError && <p className="import-folder-setting-error">{(update.error as Error).message}</p>}
            {!askedInDialog && (
              <OptionRow
                type="checkbox"
                checked={(importSettings?.backup_default ?? "keep") === "keep"}
                busy={busy}
                onChange={(keep) => update.mutate({ backup_default: keep ? "keep" : "delete" })}
                title="Keep the import folder as a backup"
                desc="Keeps every copied photo in the import folder after the session. Uses space twice."
              />
            )}
            <OptionRow
              type="checkbox"
              checked={importSettings?.verify_copies ?? false}
              busy={busy}
              onChange={(on) => update.mutate({ verify_copies: on })}
              title="Verify every copy"
              desc="Reads each copy back and compares checksums. Slower, but proves the card can be formatted."
            />
          </div>
        )}
      </div>
      <div className="settings-subgroup">
        <h4 className="settings-subhead">New photos in a review</h4>
        {(
          [
            ["select", "Selected", "Every new photo starts selected."],
            ["deselect", "Not selected", "You select the ones you want."],
          ] as const
        ).map(([value, title, desc]) => (
          <OptionRow
            key={value}
            type="radio"
            name="import-select-default"
            checked={(importSettings?.select_default ?? "deselect") === value}
            disabled={!ready}
            busy={busy}
            onChange={() => update.mutate({ select_default: value })}
            title={title}
            desc={desc}
          />
        ))}
      </div>
      <div className="settings-subgroup">
        <h4 className="settings-subhead">What the files already say</h4>
        <OptionRow
          type="checkbox"
          checked={importSettings?.read_file_metadata ?? true}
          disabled={!ready}
          busy={busy}
          onChange={(on) => update.mutate({ read_file_metadata: on })}
          title="Take over stars, labels, keywords and captions"
          desc="From other programs or .xmp sidecars. Keywords become tags; stars given in the review win."
        />
      </div>
    </>
  );
}

// The same panel as a dialog, for the Import page. Every change is saved as
// it is made, so the only button is Done.
export function ImportSettingsDialog({
  closing = false,
  onClose,
}: {
  // Set by <Presence> while the dialog fades out.
  closing?: boolean;
  onClose: () => void;
}) {
  useEscapeToClose(!closing, onClose);
  return (
    <div className={`modal-overlay${closing ? " pm-closing" : ""}`}>
      <div
        className="modal pair-delete-modal import-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Import settings"
      >
        <div className="pair-delete-body">
          <div className="import-settings-head">
            <h3>Import settings</h3>
          </div>
          <div className="import-settings-scroll">
            <ImportSettingsPanel />
          </div>
          <div className="import-settings-foot">
            <button className="btn primary" onClick={onClose} autoFocus>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ImportSettings } from "../api/types";
import { Desc, OptionRow } from "./SettingsControls";
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
    mutationFn: (patch: Partial<ImportSettings>) => api.settings.updateImport(patch),
    onSuccess: (result) => queryClient.setQueryData(["import-settings"], result),
  });
  const busy = update.isPending;
  const ready = !!importSettings;

  return (
    <>
      <div className="settings-subgroup">
        <h4 className="settings-subhead">When starting an import</h4>
        <Desc>
          Photos you import are either copied into an import folder and then sorted into the
          library, or added from where they are. Choose whether to ask each time.
        </Desc>
        {(
          [
            ["ask", "Ask every time", "A dialog asks before anything is read."],
            [
              "copy",
              "Always copy to an import folder",
              "Copies into the library's Import folder, then sorts added photos by date.",
            ],
            [
              "reference",
              "Always leave photos where they are",
              "Nothing is copied. Added photos stay in their folder.",
            ],
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
        <OptionRow
          type="checkbox"
          checked={(importSettings?.backup_default ?? "keep") === "keep"}
          disabled={!ready}
          busy={busy}
          onChange={(keep) => update.mutate({ backup_default: keep ? "keep" : "delete" })}
          title="Keep the import folder as a backup"
          desc="The folder keeps every photo and stays when you close the session. Photos you add take up space twice. Off, closing deletes the folder with the photos you did not add."
        />
      </div>
      <div className="settings-subgroup">
        <h4 className="settings-subhead">New photos in a review</h4>
        {(
          [
            ["select", "Selected", "Every new photo is marked for import; you deselect the ones you don't want."],
            ["deselect", "Not selected", "Nothing is marked for import; you select the ones you want."],
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
          title="Take over stars, labels, keywords and captions from the files"
          desc="Stars, labels, keywords and captions written by other programs or an .xmp sidecar come in with the photo. Keywords become tags. Stars you give in the review are kept."
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
          <h3>Import settings</h3>
          <ImportSettingsPanel />
          <div className="pair-delete-actions">
            <button className="btn primary" onClick={onClose} autoFocus>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

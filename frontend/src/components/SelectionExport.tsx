import { useState } from "react";
import { ExportDialog } from "./ExportDialog";
import { SaveCopyDialog } from "./SaveCopyDialog";
import { MenuButton } from "./MenuButton";
import { Presence } from "./Presence";
import { MOTION } from "../utils/usePresence";
import { useTasks } from "../state/tasks";
import { useSaveCopies } from "../utils/useSaveCopies";
import { IconExport, IconSaveCopy } from "./Icons";

// What leaves a grid's selection as files: ONE "Export…" menu for the
// selection bar, the counterpart of "Add to…" - the export itself and a copy
// of every photo (a real file or a virtual copy, SaveCopyDialog) - plus the
// dialogs, and open() for the menu bar's File → Export… (⇧⌘E), which goes
// straight to the export. The right-click menu has its own rows; this is the
// one the bar and the menu bar share.
export function useSelectionExport(ids: string[], singleFilename?: string) {
  const [open, setOpen] = useState<"export" | "copy" | null>(null);
  const { notify } = useTasks();
  const saveCopies = useSaveCopies((message) => notify({ label: message, error: true }));
  const button = (
    <MenuButton
      className="btn"
      disabled={ids.length === 0}
      title="Export the selected photos, or save a copy of each (⇧⌘E exports)"
      ariaLabel="Save as: export or save copies"
      entries={[
        {
          id: "export",
          label: (
            <>
              <IconExport size={13} /> Export…
            </>
          ),
          search: "export",
        },
        {
          id: "copy",
          label: (
            <>
              <IconSaveCopy size={13} /> Save copy…
            </>
          ),
          search: "save copy",
        },
      ]}
      onPick={(id) => setOpen(id === "copy" ? "copy" : "export")}
    >
      <span className="btn-label">
        <IconExport size={13} /> Save as…
      </span>
    </MenuButton>
  );
  const dialog = (
    <>
      <Presence open={open === "export" && ids.length > 0} ms={MOTION.modal}>
        {open === "export" && ids.length > 0 && (
          <ExportDialog
            imageIds={ids}
            singleFilename={ids.length === 1 ? singleFilename : undefined}
            onClose={() => setOpen(null)}
          />
        )}
      </Presence>
      <Presence open={open === "copy" && ids.length > 0} ms={MOTION.modal}>
        {open === "copy" && ids.length > 0 && (
          <SaveCopyDialog
            count={ids.length}
            onClose={() => setOpen(null)}
            onSave={(req) => {
              setOpen(null);
              void saveCopies(ids, req);
            }}
          />
        )}
      </Presence>
    </>
  );
  return { button, dialog, open: () => ids.length > 0 && setOpen("export") };
}

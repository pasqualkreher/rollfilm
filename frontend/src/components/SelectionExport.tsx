import { useState } from "react";
import { ExportDialog } from "./ExportDialog";
import { Presence } from "./Presence";
import { MOTION } from "../utils/usePresence";
import { IconExport } from "./Icons";

// Export for a grid's selection: the button for the selection bar, the
// dialog, and open() for the menu bar's File → Export… (⇧⌘E). The right-click
// menu has its own; this is the one the bar and the menu share.
export function useSelectionExport(ids: string[], singleFilename?: string) {
  const [open, setOpen] = useState(false);
  const button = (
    <button
      className="btn"
      disabled={ids.length === 0}
      onClick={() => setOpen(true)}
      title="Export the selected photos (⇧⌘E)"
    >
      <span className="btn-label">
        <IconExport size={13} /> Export…
      </span>
    </button>
  );
  const dialog = (
    <Presence open={open && ids.length > 0} ms={MOTION.modal}>
      {open && ids.length > 0 && (
        <ExportDialog
          imageIds={ids}
          singleFilename={ids.length === 1 ? singleFilename : undefined}
          onClose={() => setOpen(false)}
        />
      )}
    </Presence>
  );
  return { button, dialog, open: () => ids.length > 0 && setOpen(true) };
}

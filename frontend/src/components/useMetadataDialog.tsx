import { lazy, Suspense, useState } from "react";
import { api } from "../api/client";
import type { MetadataSource } from "./MetadataDialog";
import { Presence } from "./Presence";
import { MOTION } from "../utils/usePresence";

// Loaded when first opened: the dialog brings the map (Leaflet) along, and
// the right-click menu that offers it is part of the first screen.
const MetadataDialog = lazy(() => import("./MetadataDialog").then((m) => ({ default: m.MetadataDialog })));

// <Presence> hands `closing` to its child; this passes it on through Suspense.
function LazyMetadataDialog(props: {
  ids: string[];
  focus?: "location";
  source?: MetadataSource;
  onClose: () => void;
  closing?: boolean;
}) {
  return (
    <Suspense fallback={null}>
      <MetadataDialog {...props} />
    </Suspense>
  );
}

/**
 * The metadata dialog (components/MetadataDialog.tsx) with its own open
 * state, for a page's selection bar, the right-click menu and the photo
 * view: `open(ids)` shows it for those photos, `dialog` is rendered once.
 */
export function useMetadataDialog(source?: MetadataSource) {
  const [target, setTarget] = useState<{ ids: string[]; focus?: "location" } | null>(null);
  const dialog = (
    <Presence open={target !== null} ms={MOTION.modal}>
      {target && (
        <LazyMetadataDialog ids={target.ids} focus={target.focus} source={source} onClose={() => setTarget(null)} />
      )}
    </Presence>
  );
  return {
    open: (ids: string[], focus?: "location") => {
      if (ids.length > 0) setTarget({ ids, focus });
    },
    dialog,
  };
}

/**
 * The dialog on the files of an import review: the edit is kept with the
 * review and applied when the photos are imported. `onDone` refreshes the
 * review's list.
 */
export function importMetadataSource(sessionId: string, onDone: () => void): MetadataSource {
  return {
    key: `import:${sessionId}`,
    summary: (ids) => api.import.stagedMetadataSummary(sessionId, ids),
    edit: (ids, fields, shift) => api.import.editStagedMetadata(sessionId, ids, fields, shift),
    revert: (ids) => api.import.revertStagedMetadata(sessionId, ids).then(() => 0),
    refresh: () => onDone(),
    note: "Applied when the photos are imported. The original files stay unchanged.",
  };
}

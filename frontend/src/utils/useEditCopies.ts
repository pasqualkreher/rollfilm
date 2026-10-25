// "Edit a copy": a copy of every photo with an edit on it - the automatic
// edit or a preset - while the originals stay exactly as they are. The
// counterpart of "Apply … and save copy", which edits the originals too.
// SaveCopyDialog asks which kind of copy; this runs the answer:
// - a real file: one copy job on the server, rendering each source with the
//   look in place of its saved edit (the title bar counts it down);
// - a virtual copy: a second catalog entry per photo, then the edit applied
//   to those entries the way the bar applies it, their pictures counted in
//   "Rendering". Editable afterwards like any photo.

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useTasks } from "../state/tasks";
import { plural } from "./plural";
import type { SaveCopyRequest } from "../components/SaveCopyDialog";

export type CopyEdit = { kind: "auto" } | { kind: "preset"; name: string; look: Record<string, unknown> };

export function useEditCopies() {
  const queryClient = useQueryClient();
  const { trackCopyJob, trackRenders, runBatches, notify } = useTasks();
  return useCallback(
    async (ids: string[], edit: CopyEdit, req: SaveCopyRequest) => {
      if (ids.length === 0) return;
      const what = edit.kind === "auto" ? "the auto edit" : `“${edit.name}”`;
      const skippedNote = (n: number) => (n > 0 ? ` Skipped ${n} with no similar edits to learn from.` : "");
      try {
        if (req.kind === "physical") {
          const { job_id, total } = await api.images.copyJobStart(ids, {
            quality: req.quality,
            max_size: req.maxSize,
            ...(edit.kind === "auto" ? { auto: true } : { look: edit.look }),
          });
          if (total === 0) {
            notify({ label: "No copies made: none of the photos had similar edits to learn from.", error: true });
            return;
          }
          trackCopyJob(job_id, total);
          notify({ label: `Saving ${plural(total, "copy", "copies")} with ${what} in the background.${skippedNote(ids.length - total)}` });
          return;
        }
        const made = await runBatches(
          { id: "batch:edit-copies", kind: "batch", label: "Creating virtual copies…" },
          ids,
          (slice) => Promise.all(slice.map((id) => api.images.virtualCopy(id)))
        );
        const copyIds = made.results.flat().map((im) => im.id);
        if (copyIds.length === 0) return;
        let skipped = 0;
        if (edit.kind === "auto") {
          const r = await runBatches(
            { id: "batch:edit-copies", kind: "batch", label: "Auto-developing the copies…" },
            copyIds,
            (slice) => api.images.bulkAutoDevelop(slice)
          );
          skipped = r.results.reduce((n, x) => n + x.skipped, 0);
        } else {
          await runBatches(
            { id: "batch:edit-copies", kind: "batch", label: "Applying the preset to the copies…" },
            copyIds,
            (slice) => api.images.bulkDevelop(slice, edit.look)
          );
        }
        trackRenders(copyIds);
        queryClient.invalidateQueries({ queryKey: ["images"] });
        queryClient.invalidateQueries({ queryKey: ["tags"] });
        notify({
          label: `Made ${plural(copyIds.length, "virtual copy", "virtual copies")} with ${what}.${skippedNote(skipped)}${made.cancelled ? " Stopped." : ""}`,
        });
      } catch (e) {
        queryClient.invalidateQueries({ queryKey: ["images"] });
        queryClient.invalidateQueries({ queryKey: ["tags"] });
        notify({ label: (e as Error).message || "Could not edit the copies.", error: true });
      }
    },
    [notify, queryClient, runBatches, trackCopyJob, trackRenders]
  );
}

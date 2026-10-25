// Copies of several photos at once - the right-click menu's "Save copy of N
// photos" and the selection bar's "Save copy…" share this. The dialog
// (SaveCopyDialog) only asks; this runs the answer as a task in the title bar:
// physical copies are one background job on the server (counted down there,
// with a Stop between photos), virtual copies are made from here in slices
// (there is nothing to render). With several copies there is no single one
// to land on, so they simply appear in the grid next to their originals once
// the queries refresh. Whatever was made before an error shows up too.

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useTasks } from "../state/tasks";
import type { SaveCopyRequest } from "../components/SaveCopyDialog";

export function useSaveCopies(onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const { trackCopyJob, runBatches } = useTasks();
  return useCallback(
    async (ids: string[], req: SaveCopyRequest) => {
      if (ids.length === 0) return;
      try {
        if (req.kind === "physical") {
          const { job_id, total } = await api.images.copyJobStart(ids, { quality: req.quality, max_size: req.maxSize });
          trackCopyJob(job_id, total);
          return;
        }
        const { done } = await runBatches(
          { id: "batch:virtual-copies", kind: "batch", label: "Creating virtual copies…" },
          ids,
          (slice) => Promise.all(slice.map((id) => api.images.virtualCopy(id)))
        );
        if (done.length > 0) {
          queryClient.invalidateQueries({ queryKey: ["images"] });
          queryClient.invalidateQueries({ queryKey: ["tags"] });
        }
      } catch (e) {
        queryClient.invalidateQueries({ queryKey: ["images"] });
        queryClient.invalidateQueries({ queryKey: ["tags"] });
        onError((e as Error).message || "Could not save the copies.");
      }
    },
    [onError, queryClient, runBatches, trackCopyJob]
  );
}

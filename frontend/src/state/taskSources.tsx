import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { SourceRoot } from "../api/types";
import { useImportSession } from "./importSession";
import { useExternalTask, useTasks } from "./tasks";
import { nudgeWaitingThumbs } from "../utils/thumbNudge";

// Work whose state lives elsewhere - an import session, the Immich sync, a
// library merge, a source folder's scan - mirrored into the title bar's task
// dock (state/tasks, App.tsx TaskDock) so it shows and stops in the one place
// everything else does. Mounted once, in App; renders nothing.
export function TaskSources() {
  return (
    <>
      <ImportSource />
      <ImmichSource />
      <MergeSource />
      <ScanSources />
      <BackgroundSource />
    </>
  );
}

// An import copying (or reading) photos in: counted down while the session
// knows how many, a percentage before that. Stop is the wizard's "Stop &
// keep" - no more photos are asked for, the ones staged so far go to review.
// The wizard's own buttons and the Import tab's count stay.
function ImportSource() {
  const {
    isUploading,
    totalFileCount,
    liveStagedCount,
    effectiveUploadPct,
    canStopStaging,
    stagingStopped,
    stopStaging,
  } = useImportSession();
  const counted = liveStagedCount != null && totalFileCount != null && totalFileCount > 0;
  useExternalTask(
    isUploading
      ? {
          id: "import",
          kind: "import",
          label: counted ? "Importing" : effectiveUploadPct != null ? `Importing ${effectiveUploadPct}%` : "Importing",
          done: counted ? liveStagedCount : undefined,
          total: counted ? totalFileCount : undefined,
          cancel: canStopStaging ? stopStaging : null,
          cancelLabel: "Stop & keep",
          cancelling: stagingStopped,
          stopTitle: "Stop copying and review the photos copied so far.",
          title: "Photos are being brought into the library. You can keep working.",
        }
      : null
  );
  return null;
}

// Immich uploads running in the background, so the user knows a sync is
// happening (and why quitting would interrupt something) even though nothing
// blocks. Polls faster while active, lazily when idle. Stop pauses the sync:
// the upload in flight finishes, the rest wait until it is resumed in
// Settings - which is why a paused sync shows no pill.
function ImmichSource() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["immich-activity"],
    queryFn: () => api.settings.immichActivity(),
    refetchInterval: (query) => ((query.state.data?.pending_uploads ?? 0) > 0 ? 3000 : 20000),
  });
  const pending = data?.pending_uploads ?? 0;
  const paused = Boolean(data?.paused);
  const [pausing, setPausing] = useState(false);
  useEffect(() => {
    if (paused || pending === 0) setPausing(false);
  }, [paused, pending]);
  useExternalTask(
    pending > 0 && !paused
      ? {
          id: "immich:sync",
          kind: "immich",
          label: `Immich sync · ${pending} left`,
          cancel: async () => {
            setPausing(true);
            const next = await api.settings.setImmichPaused(true);
            queryClient.setQueryData(["immich-activity"], next);
          },
          cancelLabel: "Pause",
          cancelling: pausing,
          stopTitle: "Pause. The upload in flight finishes; resume in Settings.",
          title: "Photos are uploading to Immich in the background. You will be asked before quitting interrupts this.",
        }
      : null
  );
  return null;
}

// Another library being merged in (Settings › Import a library). Followed
// every second while it runs and now and then otherwise, so a merge that was
// running when the window reloaded is picked up again. Stop ends it between
// two photos; what came across stays, and running it again continues.
function MergeSource() {
  const { data } = useQuery({
    queryKey: ["library-merge-progress"],
    queryFn: () => api.maintenance.mergeLibraryProgress(),
    enabled: Boolean(window.photoManager?.pickFolder),
    refetchInterval: (query) => (query.state.data?.active ? 1000 : 15000),
  });
  const active = Boolean(data?.active);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!active) setStopping(false);
  }, [active]);
  useExternalTask(
    data && active
      ? {
          id: "merge",
          kind: "merge",
          label: "Importing library",
          done: data.total > 0 ? data.done : undefined,
          total: data.total > 0 ? data.total : undefined,
          cancel: async () => {
            setStopping(true);
            await api.maintenance.cancelLibraryMerge();
          },
          cancelling: stopping,
          stopTitle: "Stop after the photo being copied. What came across stays; run it again to continue.",
          title: "Another library is being merged into this one. You can keep working.",
        }
      : null
  );
  return null;
}

// Thumbnails the backend renders on its own, which no button started and so
// nothing else showed - though the quit dialog waits for them: an import's,
// the unfinished ones a last run left. Those of photos a bulk edit is being
// followed for already count in "Rendering" (per photo, whatever render it
// waits for) and are left out here, so nothing shows twice. (A library sync
// is Settings' button and has its task there.)
function BackgroundSource() {
  const { trackedPlainPending } = useTasks();
  const { data } = useQuery({
    queryKey: ["background-activity"],
    queryFn: () => api.maintenance.backgroundActivity(),
    refetchInterval: (query) => ((query.state.data?.thumbnails_pending ?? 0) > 0 ? 2000 : 15_000),
  });
  const thumbnails = Math.max(0, (data?.thumbnails_pending ?? 0) - trackedPlainPending);
  // Tiles still waiting for their picture ask again once the queue is through.
  const hadThumbnails = useRef(false);
  useEffect(() => {
    if (thumbnails > 0) hadThumbnails.current = true;
    else if (hadThumbnails.current) {
      hadThumbnails.current = false;
      nudgeWaitingThumbs();
    }
  }, [thumbnails]);
  useExternalTask(
    thumbnails > 0
      ? {
          id: "thumbnails",
          kind: "renders",
          label: `Thumbnails · ${thumbnails} left`,
          cancel: null,
          title: "Missing thumbnails are being rendered. You can keep working.",
        }
      : null
  );
  return null;
}

// A source folder being scanned (Settings › Sources, or the startup scan of a
// plugged-in drive): one task per folder, as long as it runs. The list is the
// same query SourceScanWatcher (App.tsx) polls, so this costs no request.
function ScanSources() {
  const { data: sources } = useQuery({
    queryKey: ["sources"],
    queryFn: () => api.sources.list(),
    refetchInterval: (query) => ((query.state.data ?? []).some((s) => s.scanning) ? 1500 : 10_000),
  });
  return (
    <>
      {(sources ?? [])
        .filter((s) => s.scanning)
        .map((s) => (
          <ScanSource key={s.id} source={s} />
        ))}
    </>
  );
}

function ScanSource({ source }: { source: SourceRoot }) {
  useExternalTask({
    id: `scan:${source.id}`,
    kind: "scan",
    label: `Scanning ${source.name}`,
    cancel: null,
    title: "The folder is being read for new photos. You can keep working.",
  });
  return null;
}

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

interface ImportSessionState {
  sessionId: string | null;
  sourceLabel: string;
  uploadProgress: number | null;
  uploadError: string | null;
  isUploading: boolean;
  // A folder import opens the review as soon as its first batch is staged and
  // keeps staging the rest in the background (best-practice incremental
  // import). While that background staging runs, `isUploading` stays true even
  // though `sessionId` is already set - the wizard uses that to keep the grid
  // refreshing and to keep the commit button disabled until everything landed.
  // `stagingError` carries a failure that happened *after* the review already
  // opened, so it can be shown without throwing away the photos already staged.
  stagingError: string | null;
  // Which kind of import is in flight - the folder import surfaces richer
  // live progress (per-photo counts via the backend's /progress endpoint).
  importMode: "upload" | "folder" | null;
  // Session id while a folder import is still staging (sessionId itself is
  // only set at the end, since setting it flips the wizard into review).
  stagingSessionId: string | null;
  // Folder import only: how many photos the scan found / are fully staged.
  totalFileCount: number | null;
  stagedFileCount: number;
  // Folder import: live per-photo count of files fully *copied* into staging
  // (backend poll), so counters tick per file instead of jumping per batch.
  liveStagedCount: number | null;
  // THE display percentage for this import - photo-count based for folder
  // imports (live), byte-based for browser uploads. Every progress readout
  // (nav tab, wizard button) must use this one number so they never disagree.
  effectiveUploadPct: number | null;
  // Copying is done but the backend is still analyzing files in the background
  // (thumbnails, EXIF, duplicate detection). Review is fully usable meanwhile;
  // committing stays blocked until this clears.
  analysisPending: boolean;
  analysisProcessed: number;
  analysisTotal: number;
  // A staging run is far enough along to be stopped *gracefully*: the session
  // exists, so the photos copied so far can be reviewed and imported. Unlike
  // cancelUpload (which aborts and throws the batch away), stopStaging lets the
  // batch in flight finish and then simply stops asking for more.
  canStopStaging: boolean;
  // The user pressed Stop: true from the click until the next import starts, so
  // the review screen can explain why the batch is short.
  stagingStopped: boolean;
  stopStaging: () => void;
  startUpload: (files: File[], label: string) => void;
  // Desktop-only: import a folder by absolute path - the backend reads the
  // files itself (no browser upload). Same progress/cancel plumbing.
  startFolderImport: (folderPath: string) => void;
  // Desktop-only: import individually picked files by absolute path, through
  // the same incremental staging pipeline as a folder import.
  startFilesImport: (files: { path: string; size: number }[], label: string) => void;
  cancelUpload: () => void;
  reset: () => void;
}

const ImportSessionContext = createContext<ImportSessionState | null>(null);

/**
 * Lives above <Routes> in App.tsx so it survives switching nav tabs mid-upload
 * (e.g. clicking "Library" while an SD card is still uploading). The browser
 * keeps the XHR running regardless of which component is mounted, but without
 * this, the *tracking* of it (session id, progress) would be lost the moment
 * ImportWizard unmounts - the import would look "stopped" even though the
 * backend received and staged everything.
 */
export function ImportSessionProvider({ children }: { children: ReactNode }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [stagingError, setStagingError] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<"upload" | "folder" | null>(null);
  const [stagingSessionId, setStagingSessionId] = useState<string | null>(null);
  const [totalFileCount, setTotalFileCount] = useState<number | null>(null);
  const [stagedFileCount, setStagedFileCount] = useState(0);
  // Held for the lifetime of an in-flight upload so cancelUpload() can abort the
  // XHRs; the created staging session id is captured so a mid-upload cancel can
  // clean up whatever was already staged on the backend.
  const abortRef = useRef<AbortController | null>(null);
  const uploadSessionRef = useRef<string | null>(null);
  // Graceful stop: read between batches by both staging loops. A ref, not
  // state, because the loops are plain async functions that would otherwise
  // close over a stale value.
  const stopRef = useRef(false);
  const [stagingStopped, setStagingStopped] = useState(false);
  const [canStopStaging, setCanStopStaging] = useState(false);

  function startUpload(files: File[], label: string) {
    const controller = new AbortController();
    abortRef.current = controller;
    uploadSessionRef.current = null;
    stopRef.current = false;
    setStagingStopped(false);
    setCanStopStaging(false);
    setImportMode("upload");
    setIsUploading(true);
    setUploadError(null);
    setUploadProgress(0);
    api.import
      .upload(
        files,
        label,
        setUploadProgress,
        controller.signal,
        (id) => {
          uploadSessionRef.current = id;
          // The session now exists on the backend, so a stop leaves something
          // reviewable behind - offer the graceful stop from here on.
          setCanStopStaging(true);
        },
        () => stopRef.current
      )
      .then((session) => {
        setSourceLabel(session.source_path);
        setSessionId(session.id);
      })
      .catch((err: Error) => {
        // A user cancel isn't a failure: drop the partially-staged session on
        // the backend (best effort) and clear the screen instead of erroring.
        if (controller.signal.aborted || err.name === "AbortError") {
          const staged = uploadSessionRef.current;
          if (staged) api.import.discard(staged).catch(() => {});
          reset();
        } else {
          setUploadError(err.message);
        }
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null;
        setIsUploading(false);
        setUploadProgress(null);
        setImportMode(null);
        setCanStopStaging(false);
      });
  }

  function startFolderImport(folderPath: string) {
    const label = folderPath.split("/").filter(Boolean).pop() || folderPath;
    runPathsImport(label, async (signal) => {
      const scan = await api.import.scanFolder(folderPath, signal);
      if (scan.files.length === 0) {
        throw new Error("No importable photos found in this folder");
      }
      return scan.files;
    });
  }

  // Desktop-only: import individually picked files by absolute path - the exact
  // same incremental staging pipeline as a folder import (review opens after
  // the first batch, live per-photo progress), just without the folder scan.
  function startFilesImport(files: { path: string; size: number }[], label: string) {
    runPathsImport(label, async () => files);
  }

  function runPathsImport(
    label: string,
    getFiles: (signal: AbortSignal) => Promise<{ path: string; size: number }[]>
  ) {
    const controller = new AbortController();
    abortRef.current = controller;
    uploadSessionRef.current = null;
    stopRef.current = false;
    setStagingStopped(false);
    setCanStopStaging(false);
    setImportMode("folder");
    setStagingSessionId(null);
    setTotalFileCount(null);
    setStagedFileCount(0);
    setIsUploading(true);
    setUploadError(null);
    setStagingError(null);
    setUploadProgress(0);

    const BATCH_PATHS = 100;
    // The first batch is deliberately tiny: its response carries the staging
    // session id, and the wizard/nav percent can't poll live progress until it
    // has that id. A full-size first batch on a slow disk (RAW files can take
    // seconds each) left the percent frozen at 0% for many minutes - staging
    // was running, but nothing on screen moved. A short prime returns the id
    // in seconds, so the per-photo /progress poll starts almost immediately.
    const PRIME_PATHS = 8;

    (async () => {
      const files = await getFiles(controller.signal);
      setTotalFileCount(files.length);
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0) || 1;
      let stagedBytes = 0;
      let stagedFiles = 0;
      let session: Awaited<ReturnType<typeof api.import.stagePaths>> | null = null;
      let reviewOpened = false;
      let i = 0;
      while (i < files.length) {
        if (controller.signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
        const size = i === 0 ? PRIME_PATHS : BATCH_PATHS;
        const batch = files.slice(i, i + size);
        i += size;
        session = await api.import.stagePaths(
          batch.map((f) => f.path),
          label,
          session?.id ?? null,
          totalBytes,
          controller.signal
        );
        if (!uploadSessionRef.current) {
          uploadSessionRef.current = session.id;
          setStagingSessionId(session.id);
          setCanStopStaging(true);
        }
        stagedBytes += batch.reduce((sum, f) => sum + f.size, 0);
        stagedFiles += batch.length;
        setStagedFileCount(stagedFiles);
        setUploadProgress(Math.min(100, Math.round((stagedBytes / totalBytes) * 100)));
        // Incremental import: open the review as soon as the first batch is
        // staged, then keep staging the remaining batches in the background.
        // The user starts culling immediately instead of staring at a bar
        // through a slow copy; the grid refreshes as more photos land, and the
        // commit button stays disabled (isUploading) until staging finishes.
        if (!reviewOpened) {
          reviewOpened = true;
          setSourceLabel(session.source_path);
          setSessionId(session.id);
        }
        // "Stop copying, keep these": checked here rather than at the top of
        // the loop so the batch already on its way always lands - stopping
        // mid-batch would leave half-copied files behind. Everything staged so
        // far stays; the loop just never asks for the next batch, so the run
        // ends the same way a completed one does and the review unlocks.
        if (stopRef.current) break;
      }
      return { reviewOpened };
    })()
      .catch((err: Error) => {
        if (controller.signal.aborted || err.name === "AbortError") {
          const staged = uploadSessionRef.current;
          if (staged) api.import.discard(staged).catch(() => {});
          reset();
        } else if (uploadSessionRef.current) {
          // The review was already open (at least one batch staged): keep those
          // photos and surface the failure as a banner instead of discarding.
          setStagingError(err.message);
        } else {
          setUploadError(err.message);
        }
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null;
        setIsUploading(false);
        setUploadProgress(null);
        setImportMode(null);
        setStagingSessionId(null);
        setTotalFileCount(null);
        setStagedFileCount(0);
        setCanStopStaging(false);
      });
  }

  // Poll the backend's per-photo staging progress while a folder import runs
  // AND while the background analysis is still catching up after the copy.
  // Lives HERE (not in the wizard) so the nav tab shows the same live number
  // even when the wizard is unmounted - previously the tab lagged a whole
  // batch behind on a byte-based percentage while the wizard counted photos.
  const progressPollId = sessionId ?? stagingSessionId;
  const { data: importProgress } = useQuery({
    queryKey: ["import-progress", progressPollId],
    queryFn: () => api.import.progress(progressPollId!),
    enabled: !!progressPollId,
    refetchInterval: (query) => {
      const d = query.state.data;
      const pending = !!d && d.phase === "staging" && d.processed < d.total;
      return isUploading || pending ? 500 : false;
    },
  });
  const folderImportActive = importMode === "folder" && isUploading;
  // Files fully copied into staging - the backend counts them one by one, so
  // this ticks per photo. The client-side per-batch count is the fallback
  // while the first poll is still on its way.
  const liveStagedCount =
    folderImportActive && totalFileCount
      ? Math.min(
          totalFileCount,
          Math.max(stagedFileCount, importProgress?.phase === "staging" ? importProgress.copied : 0)
        )
      : null;
  const effectiveUploadPct =
    folderImportActive && totalFileCount && liveStagedCount !== null
      ? Math.round((liveStagedCount / totalFileCount) * 100)
      : uploadProgress;
  // Background analysis still running (or not yet caught up). While uploading
  // this is folded into the normal progress display; afterwards the wizard
  // uses it to keep the grid refreshing and the commit button locked.
  const analysisPending =
    !!importProgress &&
    importProgress.phase === "staging" &&
    importProgress.processed < importProgress.total;
  const analysisProcessed = importProgress?.phase === "staging" ? importProgress.processed : 0;
  const analysisTotal = importProgress?.phase === "staging" ? importProgress.total : 0;

  function cancelUpload() {
    abortRef.current?.abort();
  }

  // Stop copying but KEEP what already landed - the opposite of cancelUpload,
  // which aborts the transfer and discards the half-staged session. Nothing is
  // aborted here: the batch in flight finishes, the staging loop then stops,
  // and the review screen is left holding exactly the photos that made it in.
  function stopStaging() {
    if (!abortRef.current) return;
    stopRef.current = true;
    setStagingStopped(true);
  }

  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    uploadSessionRef.current = null;
    stopRef.current = false;
    setStagingStopped(false);
    setCanStopStaging(false);
    setSessionId(null);
    setSourceLabel("");
    setUploadError(null);
    setStagingError(null);
    setImportMode(null);
    setStagingSessionId(null);
    setTotalFileCount(null);
    setStagedFileCount(0);
  }

  return (
    <ImportSessionContext.Provider
      value={{
        sessionId,
        sourceLabel,
        uploadProgress,
        uploadError,
        isUploading,
        stagingError,
        importMode,
        stagingSessionId,
        totalFileCount,
        stagedFileCount,
        liveStagedCount,
        effectiveUploadPct,
        analysisPending,
        analysisProcessed,
        analysisTotal,
        canStopStaging,
        stagingStopped,
        stopStaging,
        startUpload,
        startFolderImport,
        startFilesImport,
        cancelUpload,
        reset,
      }}
    >
      {children}
    </ImportSessionContext.Provider>
  );
}

export function useImportSession(): ImportSessionState {
  const ctx = useContext(ImportSessionContext);
  if (!ctx) throw new Error("useImportSession must be used within ImportSessionProvider");
  return ctx;
}

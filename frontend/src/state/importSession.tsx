import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

interface ImportSessionState {
  sessionId: string | null;
  sourceLabel: string;
  uploadProgress: number | null;
  uploadError: string | null;
  isUploading: boolean;
  // Which kind of import is in flight - the folder import surfaces richer
  // live progress (per-photo counts via the backend's /progress endpoint).
  importMode: "upload" | "folder" | null;
  // Session id while a folder import is still staging (sessionId itself is
  // only set at the end, since setting it flips the wizard into review).
  stagingSessionId: string | null;
  // Folder import only: how many photos the scan found / are fully staged.
  totalFileCount: number | null;
  stagedFileCount: number;
  // Folder import: live per-photo count including the batch currently being
  // analyzed (backend poll), so counters tick instead of jumping per batch.
  liveStagedCount: number | null;
  // THE display percentage for this import - photo-count based for folder
  // imports (live), byte-based for browser uploads. Every progress readout
  // (nav tab, wizard button) must use this one number so they never disagree.
  effectiveUploadPct: number | null;
  startUpload: (files: File[], label: string) => void;
  // Desktop-only: import a folder by absolute path - the backend reads the
  // files itself (no browser upload). Same progress/cancel plumbing.
  startFolderImport: (folderPath: string) => void;
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
  const [importMode, setImportMode] = useState<"upload" | "folder" | null>(null);
  const [stagingSessionId, setStagingSessionId] = useState<string | null>(null);
  const [totalFileCount, setTotalFileCount] = useState<number | null>(null);
  const [stagedFileCount, setStagedFileCount] = useState(0);
  // Held for the lifetime of an in-flight upload so cancelUpload() can abort the
  // XHRs; the created staging session id is captured so a mid-upload cancel can
  // clean up whatever was already staged on the backend.
  const abortRef = useRef<AbortController | null>(null);
  const uploadSessionRef = useRef<string | null>(null);

  function startUpload(files: File[], label: string) {
    const controller = new AbortController();
    abortRef.current = controller;
    uploadSessionRef.current = null;
    setImportMode("upload");
    setIsUploading(true);
    setUploadError(null);
    setUploadProgress(0);
    api.import
      .upload(files, label, setUploadProgress, controller.signal, (id) => {
        uploadSessionRef.current = id;
      })
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
      });
  }

  function startFolderImport(folderPath: string) {
    const controller = new AbortController();
    abortRef.current = controller;
    uploadSessionRef.current = null;
    setImportMode("folder");
    setStagingSessionId(null);
    setTotalFileCount(null);
    setStagedFileCount(0);
    setIsUploading(true);
    setUploadError(null);
    setUploadProgress(0);

    const label = folderPath.split("/").filter(Boolean).pop() || folderPath;
    const BATCH_PATHS = 250;

    (async () => {
      const scan = await api.import.scanFolder(folderPath, controller.signal);
      if (scan.files.length === 0) {
        throw new Error("No importable photos found in this folder");
      }
      setTotalFileCount(scan.files.length);
      const totalBytes = scan.total_bytes || 1;
      let stagedBytes = 0;
      let stagedFiles = 0;
      let session: Awaited<ReturnType<typeof api.import.stagePaths>> | null = null;
      for (let i = 0; i < scan.files.length; i += BATCH_PATHS) {
        if (controller.signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
        const batch = scan.files.slice(i, i + BATCH_PATHS);
        session = await api.import.stagePaths(
          batch.map((f) => f.path),
          label,
          session?.id ?? null,
          totalBytes,
          controller.signal
        );
        if (!uploadSessionRef.current) {
          uploadSessionRef.current = session.id;
          // Published separately from sessionId: the review screen must not
          // open yet, but the wizard needs the id to poll live per-photo
          // progress of the batch currently staging.
          setStagingSessionId(session.id);
        }
        stagedBytes += batch.reduce((sum, f) => sum + f.size, 0);
        stagedFiles += batch.length;
        setStagedFileCount(stagedFiles);
        setUploadProgress(Math.min(100, Math.round((stagedBytes / totalBytes) * 100)));
      }
      return session!;
    })()
      .then((session) => {
        setSourceLabel(session.source_path);
        setSessionId(session.id);
      })
      .catch((err: Error) => {
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
        setStagingSessionId(null);
        setTotalFileCount(null);
        setStagedFileCount(0);
      });
  }

  // Poll the backend's per-photo staging progress while a folder import runs.
  // Lives HERE (not in the wizard) so the nav tab shows the same live number
  // even when the wizard is unmounted - previously the tab lagged a whole
  // batch behind on a byte-based percentage while the wizard counted photos.
  const progressPollId = sessionId ?? stagingSessionId;
  const { data: importProgress } = useQuery({
    queryKey: ["import-progress", progressPollId],
    queryFn: () => api.import.progress(progressPollId!),
    enabled: !!progressPollId && isUploading,
    refetchInterval: 500,
  });
  const folderImportActive = importMode === "folder" && isUploading;
  const liveStagedCount =
    folderImportActive && totalFileCount
      ? Math.min(
          totalFileCount,
          stagedFileCount + (importProgress?.phase === "staging" ? importProgress.processed : 0)
        )
      : null;
  const effectiveUploadPct =
    folderImportActive && totalFileCount && liveStagedCount !== null
      ? Math.round((liveStagedCount / totalFileCount) * 100)
      : uploadProgress;

  function cancelUpload() {
    abortRef.current?.abort();
  }

  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    uploadSessionRef.current = null;
    setSessionId(null);
    setSourceLabel("");
    setUploadError(null);
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
        importMode,
        stagingSessionId,
        totalFileCount,
        stagedFileCount,
        liveStagedCount,
        effectiveUploadPct,
        startUpload,
        startFolderImport,
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

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ImportSessionSummary } from "../api/types";

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
  // The open session was started on a folder, so whatever of that folder it
  // hasn't copied yet can be copied later (see continueSession).
  sessionResumable: boolean;
  // Why a continued session can't copy the rest right now (its card isn't
  // connected) - a banner over the review.
  sourceNotice: string | null;
  // Sessions live until the user ends them. Open one from the Import page's
  // list: the review comes back as it was left, and if its folder is
  // reachable, whatever of it isn't copied yet is copied now.
  continueSession: (s: ImportSessionSummary) => void;
  // "Continue later": close the review and leave the session as it is. A copy
  // still running finishes the batch in flight and stops.
  leaveSession: () => void;
  // Add more to the open session: another folder (which becomes a source of
  // its own, continued like the first) or individually picked photos.
  addFolderToSession: (folderPath: string) => void;
  addFilesToSession: (files: { path: string; size: number }[]) => void;
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
  const queryClient = useQueryClient();
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
  const [sessionResumable, setSessionResumable] = useState(false);
  const [sourceNotice, setSourceNotice] = useState<string | null>(null);
  // The session on screen, for async work that must not act on a session the
  // user has left in the meantime (continueSession's scan).
  const activeSessionRef = useRef<string | null>(null);
  useEffect(() => {
    activeSessionRef.current = sessionId;
  }, [sessionId]);

  function startUpload(files: File[], label: string) {
    const controller = new AbortController();
    abortRef.current = controller;
    uploadSessionRef.current = null;
    stopRef.current = false;
    // A browser upload has no path to come back to.
    setSessionResumable(false);
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
      // Every file of the folder is staged here, so its own count is the
      // source's total - no sourceCounts override needed.
      return scan.files.map((f) => ({ ...f, root: folderPath }));
    });
  }

  // Desktop-only: import individually picked files by absolute path - the exact
  // same incremental staging pipeline as a folder import (review opens after
  // the first batch, live per-photo progress), just without the folder scan.
  function startFilesImport(files: { path: string; size: number }[], label: string) {
    runPathsImport(label, async () => files);
  }

  // `opts.sessionId` continues an existing session (appending to it) instead
  // of creating one. Each file carries the folder it sits under (`root`), and
  // `opts.sourceCounts` says how many importable files each of those folders
  // holds - together that records the folders as the session's sources, to be
  // continued from later.
  function runPathsImport(
    label: string,
    getFiles: (
      signal: AbortSignal
    ) => Promise<{ path: string; size: number; root?: string | null }[]>,
    opts: { sessionId?: string; sourceCounts?: Record<string, number> } = {}
  ) {
    const controller = new AbortController();
    abortRef.current = controller;
    const resuming = opts.sessionId != null;
    uploadSessionRef.current = opts.sessionId ?? null;
    stopRef.current = false;
    setStagingStopped(false);
    // A continued session exists already, so stopping keeps something.
    setCanStopStaging(resuming);
    setImportMode("folder");
    setStagingSessionId(opts.sessionId ?? null);
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
      // How many importable files each folder holds, so the session records it
      // as a source with its total. Staging everything a folder has (a fresh
      // folder import) makes that the count of the files themselves;
      // continuing a source passes its scanned total, which also covers what
      // was copied from it before.
      const counts: Record<string, number> = {};
      for (const f of files) if (f.root) counts[f.root] = (counts[f.root] ?? 0) + 1;
      Object.assign(counts, opts.sourceCounts ?? {});
      if (!resuming) setSessionResumable(files.some((f) => f.root));
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0) || 1;
      let stagedBytes = 0;
      let stagedFiles = 0;
      let runSessionId: string | null = opts.sessionId ?? null;
      // A continued session's review is already on screen.
      let reviewOpened = resuming;
      // Folders whose file count has been sent - it only creates the source.
      const countedRoots = new Set<string>();
      let i = 0;
      while (i < files.length) {
        if (controller.signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
        const size = i === 0 ? PRIME_PATHS : BATCH_PATHS;
        // A batch never mixes sources: one staging request carries the one
        // folder its paths are under, which each file's recorded place on
        // that source is relative to.
        let batch = files.slice(i, i + size);
        const root = batch[0].root ?? null;
        const mixedAt = batch.findIndex((f) => (f.root ?? null) !== root);
        if (mixedAt > 0) batch = batch.slice(0, mixedAt);
        i += batch.length;
        const session = await api.import.stagePaths(
          batch.map((f) => f.path),
          label,
          runSessionId,
          totalBytes,
          controller.signal,
          root ? { root, fileCount: countedRoots.has(root) ? undefined : counts[root] } : undefined
        );
        if (root) countedRoots.add(root);
        runSessionId = session.id;
        if (!uploadSessionRef.current) {
          uploadSessionRef.current = session.id;
          setStagingSessionId(session.id);
          setCanStopStaging(true);
        }
        stagedBytes += batch.reduce((sum, f) => sum + f.size, 0);
        stagedFiles += batch.length;
        setStagedFileCount(stagedFiles);
        setUploadProgress(Math.min(100, Math.round((stagedBytes / totalBytes) * 100)));
        // The review polls while a copy runs, but only on a timer: a few
        // photos added to an open session are copied before that timer fires
        // once, and the grid then sat on its old list until something else
        // (a tab switch) refetched it. Refresh right as each batch lands.
        queryClient.invalidateQueries({ queryKey: ["import-files", session.id] });
        queryClient.invalidateQueries({ queryKey: ["import-progress", session.id] });
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
          // Cancel throws away a session this run created - never one it was
          // only continuing, which can hold days of culling.
          const staged = uploadSessionRef.current;
          if (staged && !resuming) api.import.discard(staged).catch(() => {});
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
        // Once more at the end: the last batch's analysis flags land after its
        // copy, and the session list's counts have changed either way.
        const id = uploadSessionRef.current;
        if (id) {
          queryClient.invalidateQueries({ queryKey: ["import-files", id] });
          queryClient.invalidateQueries({ queryKey: ["import-progress", id] });
        }
        queryClient.invalidateQueries({ queryKey: ["import-sessions"] });
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

  async function continueSession(s: ImportSessionSummary) {
    if (abortRef.current) return; // one copy at a time
    // Set here as well as by the effect below: the scan starts before React
    // has re-rendered, and it checks this to see whether the session is still
    // the one on screen when it comes back.
    activeSessionRef.current = s.id;
    setSessionId(s.id);
    setSourceLabel(s.source_path);
    setSessionResumable(s.sources.length > 0);
    setUploadError(null);
    setStagingError(null);
    setSourceNotice(null);
    setStagingStopped(false);
    if (s.sources.length === 0) return;
    try {
      const found = await api.import.rescan(s.id);
      // Left again (or another copy started) while the scan ran.
      if (activeSessionRef.current !== s.id || abortRef.current) return;

      // Sources that aren't there right now, and still hold photos: say which,
      // rather than silently copying only part of the session.
      const remainingOf = new Map(s.sources.map((x) => [x.id, x.remaining]));
      const missing = found.sources.filter(
        (src) => !src.available && remainingOf.get(src.id ?? "") !== 0
      );
      if (missing.length > 0) {
        const names = missing.map((m) => `“${m.label}”`).join(", ");
        setSourceNotice(
          `${names} ${missing.length === 1 ? "is" : "are"} not connected. Everything copied so ` +
            `far is here. Connect ${missing.length === 1 ? "it" : "them"} and continue this ` +
            "session again to copy the rest."
        );
      }

      const toCopy = found.sources.flatMap((src) =>
        src.available ? src.files.map((f) => ({ ...f, root: src.root })) : []
      );
      if (toCopy.length === 0) return;
      const counts: Record<string, number> = {};
      for (const src of found.sources) {
        if (src.available && src.file_count != null) counts[src.root] = src.file_count;
      }
      runPathsImport(s.source_path, async () => toCopy, { sessionId: s.id, sourceCounts: counts });
    } catch (err) {
      if (activeSessionRef.current === s.id) setStagingError((err as Error).message);
    }
  }

  // Collect from more than one place in one session: another card, another
  // folder. The folder becomes a source of its own, continued like any other -
  // and a folder the session already has only contributes what is new.
  async function addFolderToSession(folderPath: string) {
    const id = activeSessionRef.current;
    if (!id || abortRef.current) return;
    setSourceNotice(null);
    setStagingError(null);
    try {
      const [source] = (await api.import.rescan(id, folderPath)).sources;
      if (activeSessionRef.current !== id || abortRef.current) return;
      if (!source || source.files.length === 0) {
        setSourceNotice("Every photo in that folder is already in this session.");
        return;
      }
      setSessionResumable(true);
      runPathsImport(
        source.label,
        async () => source.files.map((f) => ({ ...f, root: source.root })),
        {
          sessionId: id,
          sourceCounts: { [source.root]: source.file_count ?? source.files.length },
        }
      );
    } catch (err) {
      if (activeSessionRef.current === id) setStagingError((err as Error).message);
    }
  }

  // Individually picked photos go into the session as they are - no folder to
  // come back to, so they add no source.
  function addFilesToSession(files: { path: string; size: number }[]) {
    const id = activeSessionRef.current;
    if (!id || abortRef.current || files.length === 0) return;
    setSourceNotice(null);
    runPathsImport(`${files.length} selected files`, async () => files, { sessionId: id });
  }

  function leaveSession() {
    // Same as "Stop copying": the batch in flight lands, nothing is left
    // half-copied, and what the copy didn't reach waits for the next continue.
    if (abortRef.current) {
      stopRef.current = true;
      setStagingStopped(true);
    }
    activeSessionRef.current = null;
    setSessionId(null);
    setSourceLabel("");
    setSessionResumable(false);
    setStagingError(null);
    setSourceNotice(null);
  }

  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    uploadSessionRef.current = null;
    stopRef.current = false;
    setStagingStopped(false);
    setCanStopStaging(false);
    activeSessionRef.current = null;
    setSessionId(null);
    setSourceLabel("");
    setSessionResumable(false);
    setSourceNotice(null);
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
        sessionResumable,
        sourceNotice,
        continueSession,
        leaveSession,
        addFolderToSession,
        addFilesToSession,
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

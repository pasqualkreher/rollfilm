import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type {
  ColorLabel,
  Facet,
  ImportChoice,
  ImportSessionSummary,
  StagedFileOut,
  ViewMode,
} from "../api/types";
import { PhotoFilters } from "../components/PhotoFilters";
import { ImportLightbox } from "../components/ImportLightbox";
import { ImportReviewGrid, dayLabel, isDuplicate } from "../components/ImportReviewGrid";
import { ExternalSources } from "../components/ExternalSources";
import { ImportLibrary } from "../components/ImportLibrary";
import { ImportSessions, closeSessionTitle, confirmCloseSession } from "../components/ImportSessions";
import { ImportModeDialog } from "../components/ImportModeDialog";
import { ImmichSyncToggle } from "../components/ImmichSyncToggle";
import { ImportAlbumPicker } from "../components/ImportAlbumPicker";
import { collapsePairsBy, groupPairsAdjacent } from "../utils/pairing";
import { pickImportableFiles, sourceLabelFor } from "../utils/folderPick";
import { useImportSession } from "../state/importSession";
import { useAppDialogs } from "../components/AppDialogs";
import { useWait } from "../state/wait";
import { useMergePairs } from "../state/viewPrefs";
import { formatEta } from "../utils/duration";
import { modKeyLabel, takesTyping, useSelectionKeys } from "../utils/selection";
import { selectionSharedMeta } from "../utils/selectionMeta";
import { RatingStars } from "../components/RatingStars";
import { ColorLabelPicker } from "../components/ColorLabelPicker";
import { useTransientMessage } from "../utils/transientMessage";
import {
  clearReviewState,
  readReviewState,
  updateReviewState,
  type ReviewScrollAnchor,
} from "../utils/importReviewState";
import {
  IconCheck,
  IconChevronDown,
  IconFolder,
  IconImage,
  IconBookmark,
  IconImport,
  IconLeave,
} from "../components/Icons";
import { Presence } from "../components/Presence";
import { MOTION } from "../utils/usePresence";
import { Spinner } from "../components/Spinner";

// What a single-file edit in the review grid can change.
type StagedPatch = {
  selected?: boolean;
  rating?: number;
  color_label?: ColorLabel;
  immich_sync?: boolean;
};

// Shots where exactly one half of a RAW+JPEG pair is selected - used to ask
// "did you mean to leave the other one out?" before committing.
function findIncompletePairs(files: StagedFileOut[]): StagedFileOut[] {
  const byId = new Map(files.map((f) => [f.id, f]));
  const seen = new Set<string>();
  const missingHalf: StagedFileOut[] = [];
  for (const f of files) {
    if (!f.paired_staged_file_id || seen.has(f.id)) continue;
    const partner = byId.get(f.paired_staged_file_id);
    seen.add(f.id);
    if (partner) seen.add(partner.id);
    if (partner && f.selected !== partner.selected) {
      missingHalf.push(f.selected ? partner : f);
    }
  }
  return missingHalf;
}

// The import always flows Choose → Review (staging) → Library. Showing the
// three steps up front is what makes the staging area self-explanatory:
// nothing reaches the library until step 3.
function ImportSteps({ current }: { current: 1 | 2 }) {
  const steps = ["Choose photos", "Review & select", "Added to library"];
  return (
    <ol className="import-steps" aria-label="Import steps">
      {steps.map((label, i) => {
        const n = i + 1;
        const state = n === current ? " active" : n < current ? " done" : "";
        return (
          <li key={label} className={`import-step${state}`}>
            <span className="import-step-num" aria-hidden>
              {n < current ? <IconCheck size={11} /> : n}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

// "Show in Finder" is the desktop app's: the web build has no file manager
// to open. Named after the OS's own, like its menus.
const revealFile = window.photoManager?.revealFile;
const REVEAL_LABEL =
  window.photoManager?.platform === "darwin"
    ? "Show in Finder"
    : window.photoManager?.platform === "win32"
      ? "Show in Explorer"
      : "Show in file manager";

// Where a copying session keeps its files, in the row under the review text
// (beside the Add buttons): the path and what closing the session does to it. In the
// desktop app the label and path are the way to open it - one click shows
// the folder in the file manager, no button of its own beside them.
function ImportFolder({ folder, backup }: { folder: string; backup: boolean }) {
  // A long path gives way in the middle: the session's own folder name at
  // the end is the part worth reading.
  const cut = Math.max(folder.lastIndexOf("/"), folder.lastIndexOf("\\")) + 1;
  const where = (
    <>
      <span className="import-folder-label">
        <IconFolder size={12} /> Import folder
      </span>
      <span className="import-start-folder-path import-folder-path" title={revealFile ? undefined : folder}>
        <span>{folder.slice(0, cut)}</span>
        <span>{folder.slice(cut)}</span>
      </span>
    </>
  );
  return (
    <>
      {revealFile ? (
        <button
          className="import-folder-reveal"
          onClick={() => void revealFile(folder)}
          title={`${REVEAL_LABEL}: ${folder}`}
        >
          {where}
        </button>
      ) : (
        where
      )}
      <span className="import-add-hint">
        {backup ? "Kept as a backup." : "Deleted when the session closes."}
      </span>
    </>
  );
}

export function ImportWizard() {
  const {
    sessionId,
    sourceLabel,
    uploadProgress,
    uploadError,
    isUploading,
    stagingError,
    importMode,
    stagingSessionId,
    totalFileCount,
    liveStagedCount,
    effectiveUploadPct,
    analysisPending,
    analysisProcessed,
    analysisTotal,
    startUpload,
    startFolderImport,
    startFilesImport,
    sessionMode,
    sessionFolder,
    sessionBackup,
    cancelUpload,
    canStopStaging,
    stagingStopped,
    stopStaging,
    reset,
    sessionResumable,
    sourceNotice,
    continueSession,
    leaveSession,
    addFolderToSession,
    addFilesToSession,
  } = useImportSession();
  // The native pickers: adding to a session needs paths the backend can read,
  // which a browser file input can't give.
  const nativePick = typeof window !== "undefined" ? window.photoManager : undefined;
  // The session leaves its photos where they are: nothing is copied, so the
  // review says "reading"/"adding" where it otherwise says "copying".
  const inPlace = sessionMode === "reference";
  // Review is open (sessionId set) but the remaining batches are still copying
  // in the background: keep the grid refreshing and block commit until done.
  const stagingInBackground = !!sessionId && isUploading;
  // Copying is done but the background analysis (thumbnails, EXIF, duplicate
  // detection) hasn't caught up yet - reviewing works, committing is blocked.
  const analyzingInBackground = !!sessionId && !isUploading && analysisPending;
  // The user pressed "Stop copying" and the staging loop has since wound down:
  // the batch is deliberately short, so say so instead of leaving them to
  // wonder where the rest of the card went.
  const stoppedEarly = !!sessionId && stagingStopped && !isUploading;
  // Filters, open preview and commit options are remembered per session
  // (utils/importReviewState): leaving for another tab unmounts this page,
  // and coming back used to reset all of them. Seeded from the record at
  // mount for the session already open; a session opened later while this
  // page is mounted (from the list, or a fresh import) is loaded below.
  const restoredFor = useRef<string | null>(sessionId);
  const initial = useRef(sessionId ? readReviewState(sessionId) : null);
  const [hideDuplicates, setHideDuplicates] = useState(initial.current?.hideDuplicates ?? true);
  const [viewMode, setViewMode] = useState<ViewMode>(initial.current?.viewMode ?? "combined");
  const [ratingMin, setRatingMin] = useState(initial.current?.ratingMin ?? 0);
  const [colorFilter, setColorFilter] = useState<ColorLabel>(initial.current?.colorFilter ?? "none");
  // The library's EXIF filters, read from the staged files' own analysis.
  const [camera, setCamera] = useState(initial.current?.camera ?? "");
  const [lens, setLens] = useState(initial.current?.lens ?? "");
  const [focalMin, setFocalMin] = useState(initial.current?.focalMin ?? "");
  const [focalMax, setFocalMax] = useState(initial.current?.focalMax ?? "");
  const [dateFrom, setDateFrom] = useState<string | null>(initial.current?.dateFrom ?? null);
  const [dateTo, setDateTo] = useState<string | null>(initial.current?.dateTo ?? null);
  // Flash message - auto-dismisses after a moment.
  const [pickError, setPickError] = useTransientMessage(8000);
  // "N photos added" after a partial import that leaves the session open.
  const [commitNote, setCommitNote] = useTransientMessage(12000);
  // The open preview follows the FILE, not its position in the list. An import
  // re-sorts under the user for as long as it runs - every file whose EXIF is
  // read joins its capture day and shifts everything after it - so an
  // index-keyed preview silently swapped to a different photo mid-review.
  const [lightboxFileId, setLightboxFileId] = useState<string | null>(
    initial.current?.lightboxFileId ?? null
  );
  // Where it last sat, for the case where the file leaves the visible list
  // altogether (a filter, or "Merge RAW+JPG" swallowing the RAW half): the
  // preview then stays put at that position instead of closing.
  const lightboxFallback = useRef(0);
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  // Cards picked the way the library picks photos (Cmd/Ctrl-click,
  // Shift-click, Cmd/Ctrl+A). Not the import choice: it only says which cards
  // the selection row in the bottom bar - and the import checkbox of a picked
  // card - acts on, so a handful of photos can be included, excluded, rated
  // or labelled in one go.
  const [marked, setMarked] = useState<Set<string>>(() => new Set());
  const [uploadToImmich, setUploadToImmich] = useState(initial.current?.uploadToImmich ?? false);
  // Selective sync: flag *everything* imported for Immich sync at commit.
  const [syncAllToImmich, setSyncAllToImmich] = useState(initial.current?.syncAllToImmich ?? false);
  // The grid's scroll position when it was last unmounted, handed back to it
  // as its starting point. A ref, not state: it changes on every scroll.
  const savedScroll = useRef<ReviewScrollAnchor | null>(initial.current?.scroll ?? null);
  // A session that was committed or discarded: its record is cleared, and the
  // grid reports its scroll position once more as it unmounts right after -
  // which would bring the record straight back. "Continue later" is NOT an
  // end: that last report is exactly what the session comes back to.
  const endedSession = useRef<string | null>(null);

  // A different session came up while this page stayed mounted (opened from
  // the list, or a fresh import): load its record - or the defaults for a
  // brand-new one. Done during render rather than in an effect so the grid
  // never mounts against one frame of the previous session's filters, which
  // would count as a filter change and throw the restored scroll away.
  if (sessionId && restoredFor.current !== sessionId) {
    restoredFor.current = sessionId;
    const st = readReviewState(sessionId);
    setHideDuplicates(st.hideDuplicates);
    setViewMode(st.viewMode);
    setRatingMin(st.ratingMin);
    setColorFilter(st.colorFilter);
    setCamera(st.camera);
    setLens(st.lens);
    setFocalMin(st.focalMin);
    setFocalMax(st.focalMax);
    setDateFrom(st.dateFrom);
    setDateTo(st.dateTo);
    setUploadToImmich(st.uploadToImmich);
    setSyncAllToImmich(st.syncAllToImmich);
    setLightboxFileId(st.lightboxFileId);
    savedScroll.current = st.scroll;
    setMarked(new Set());
    setLastIndex(null);
  }

  // A selection belongs to the list it was made in: the set-narrowing filters
  // (the same ones that reset the grid's scroll) drop it, so a bulk change
  // never acts on cards picked under a different filter.
  useEffect(() => {
    setMarked(new Set());
    setLastIndex(null);
  }, [hideDuplicates, ratingMin, colorFilter, camera, lens, focalMin, focalMax, dateFrom, dateTo]);

  // Keep the record current. Skipped until the session's own values are in
  // place, or the defaults of the previous render would overwrite them.
  useEffect(() => {
    if (!sessionId || restoredFor.current !== sessionId) return;
    updateReviewState(sessionId, {
      hideDuplicates,
      viewMode,
      ratingMin,
      colorFilter,
      camera,
      lens,
      focalMin,
      focalMax,
      dateFrom,
      dateTo,
      uploadToImmich,
      syncAllToImmich,
      lightboxFileId,
    });
  }, [
    sessionId,
    hideDuplicates,
    viewMode,
    ratingMin,
    colorFilter,
    camera,
    lens,
    focalMin,
    focalMax,
    dateFrom,
    dateTo,
    uploadToImmich,
    syncAllToImmich,
    lightboxFileId,
  ]);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);
  const importMenuRef = useRef<HTMLDivElement | null>(null);
  // Date-scrubber wiring for the review grid (same pattern as ThumbnailGrid's
  // groupByDate timeline): the grid root to find the scroller from, one DOM
  // node per day section, and the fixed bottom action bar whose height the
  // rail must stay clear of.
  const actionBarRef = useRef<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  // Cancel throws away everything this run has copied - one click on a button
  // that sits right beside "Stop & keep" must not be all it takes. The copy
  // carries on while the question is up.
  async function confirmCancelUpload() {
    const ok = await dialogs.confirm({
      title: "Discard this import?",
      message: canStopStaging
        ? "Everything copied so far is discarded. To review the photos already copied instead, choose Stop & keep."
        : "Everything copied so far is discarded.",
      confirmLabel: "Discard",
      cancelLabel: "Keep importing",
      danger: true,
    });
    if (ok) cancelUpload();
  }

  const { data: immich } = useQuery({
    queryKey: ["immich-settings"],
    queryFn: () => api.settings.getImmich(),
  });
  const immichConfigured = Boolean(immich?.base_url && immich?.api_key_set && immich.enabled);
  const immichMode = immich?.sync_mode ?? "manual";

  const mergePairs = useMergePairs();
  // Declared up here because both the commit and the discard below wrap
  // themselves in it.
  const { withWait } = useWait();

  // Patches that have been painted into the grid but whose request hasn't come
  // back yet (see updateStaged). A list poll in flight at that moment still
  // carries the pre-patch value, and letting it land would flip the checkbox
  // back for a second - so it is re-applied on top of whatever the server says
  // until the request settles.
  const pendingPatches = useRef(new Map<string, StagedPatch>());

  const { data: files, isLoading } = useQuery({
    queryKey: ["import-files", sessionId],
    queryFn: async () => {
      const data = await api.import.files(sessionId!);
      const pending = pendingPatches.current;
      if (pending.size === 0) return data;
      return data.map((f) => (pending.has(f.id) ? { ...f, ...pending.get(f.id) } : f));
    },
    enabled: !!sessionId,
    // While background copying/analysis is still running, refetch so newly
    // copied photos appear and analyzed ones swap their placeholder for the
    // real thumbnail + duplicate badge as they finish. Also keep polling while
    // the *fetched data itself* still contains unprocessed files: the 500ms
    // progress poll can report "done" a beat before the last files' processed
    // flag reached this query, which used to stop the interval with stale data
    // - those cards' spinners then spun until some incidental refetch (window
    // focus) picked up the final state. Polling /files also drives the
    // backend's self-healing re-enqueue for files whose analysis job was lost.
    refetchInterval: (query) => {
      const data = query.state.data ?? [];
      const active = stagingInBackground || analysisPending || data.some((f) => !f.processed);
      if (!active) return false;
      // While files are still landing, poll at a fixed short cadence no matter
      // how big the grid has grown. This is the interval at which new photos
      // can possibly appear, so anything longer shows them in clumps of
      // "whatever was copied since the last poll" instead of one by one - and
      // the backend now commits each file the moment its bytes are down
      // (_COPY_COMMIT_CHUNK), so a card really is available that quickly.
      if (stagingInBackground) return 1000;
      // Nothing new is arriving any more - only analysis flags flipping on
      // files that are already on screen. Each poll still ships (and re-renders)
      // the ENTIRE staged list, which at a 1s cadence with thousands of files
      // becomes real backend + SQLite load, so ease off with the grid size here.
      return Math.min(5000, Math.max(1000, data.length));
    },
  });

  const filesById = useMemo(() => new Map((files ?? []).map((f) => [f.id, f])), [files]);


  // Merged view shows only the JPEG of a pair, so a change mirrors onto the
  // hidden RAW partner - selecting/rating the one card affects both files.
  const partnerOf = useCallback(
    (fileId: string) => (mergePairs ? filesById.get(fileId)?.paired_staged_file_id : undefined),
    [mergePairs, filesById]
  );

  const updateStaged = useMutation({
    mutationFn: async ({ fileId, patch }: { fileId: string; patch: StagedPatch }) => {
      const partnerId = partnerOf(fileId);
      // Both halves go out at once - awaiting them one after the other doubled
      // the round trip behind every keystroke on a merged card.
      await Promise.all([
        api.import.updateStagedFile(sessionId!, fileId, patch),
        ...(partnerId ? [api.import.updateStagedFile(sessionId!, partnerId, patch)] : []),
      ]);
    },
    // Paint the change immediately instead of after the round trip: a toggle
    // used to wait for the PATCH *and* a full refetch of the entire staged list
    // before the checkbox moved, which is why holding Space felt laggy - during
    // an import that list query competes with the copy for the same disk. The
    // request still runs; the cache carries the new value meanwhile.
    onMutate: async ({ fileId, patch }) => {
      const key = ["import-files", sessionId];
      const partnerId = partnerOf(fileId);
      const ids = partnerId != null ? [fileId, partnerId] : [fileId];
      for (const id of ids) {
        pendingPatches.current.set(id, { ...pendingPatches.current.get(id), ...patch });
      }
      // Stop an in-flight list refetch from landing on top of the new value.
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<StagedFileOut[]>(key);
      queryClient.setQueryData<StagedFileOut[]>(key, (old) =>
        (old ?? []).map((f) => (ids.includes(f.id) ? { ...f, ...patch } : f))
      );
      return { previous, ids };
    },
    // Some patches are legitimately refused (re-selecting an exact duplicate
    // 400s), so a failure has to put the grid back and resync with the server.
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["import-files", sessionId], context.previous);
      }
      queryClient.invalidateQueries({ queryKey: ["import-files", sessionId] });
    },
    onSettled: (_data, _err, _vars, context) => {
      for (const id of context?.ids ?? []) pendingPatches.current.delete(id);
    },
  });

  // The remembered answer to the question the Import page asks when photos
  // are picked: copy (with or without a backup) or leave in place - see
  // askImportMode below.
  const { data: importSettings } = useQuery({
    queryKey: ["import-settings"],
    queryFn: () => api.settings.getImport(),
  });
  // The album "Add to library" also puts the photos in (the picker next to
  // the button). Kept across commits of the session: a card of one trip goes
  // in a hundred at a time, into the same album each time.
  const [targetAlbumId, setTargetAlbumId] = useState<string | null>(null);
  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });
  const targetAlbum = albums?.find((a) => a.id === targetAlbumId) ?? null;

  const commit = useMutation({
    // Blocking wait overlay, like saving or resetting edits and like Discard:
    // the commit moves every selected photo into the library and there is
    // nothing sensible to do in this screen while that happens - least of all
    // clicking the button again.
    mutationFn: () =>
      withWait("Adding photos to your library…", () =>
        api.import.commit(
          sessionId!,
          uploadToImmich && immichConfigured,
          syncAllToImmich && immichConfigured && immichMode === "selective",
          // The server leaves the session open even when nothing is left in
          // it: it lives until the user closes it.
          true
        )
      ),
    onSuccess: async (added) => {
      // The freshly-imported photos won't appear on the Library until its
      // ["images"] query refetches - invalidate so they show up immediately
      // instead of only after a manual page refresh. The Trash too: importing
      // a copy of a trashed photo restores it, so its thumb must leave the
      // Trash grid right away.
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["trash"] });
      // Trashing or restoring photos changes which tags live photos carry.
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      queryClient.invalidateQueries({ queryKey: ["import-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["import-files", sessionId] });
      // Into the chosen album too. The commit returned the photos it added
      // (both halves of a RAW+JPEG pair), so they go in by id - through the
      // same call as the library's "Add to album", Immich album mirror and
      // album tags included. The photos are in the library by now either way.
      let albumName: string | null = null;
      if (targetAlbum && added.length > 0) {
        try {
          await withWait(`Adding photos to “${targetAlbum.name}”…`, () =>
            api.albums.addImages(
              targetAlbum.id,
              added.map((image) => image.id)
            )
          );
          albumName = targetAlbum.name;
          queryClient.invalidateQueries({ queryKey: ["albums"] });
          queryClient.invalidateQueries({ queryKey: ["image"] });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await dialogs.alert({
            title: "Could not add the photos to the album",
            message: `${added.length.toLocaleString()} photo(s) were added to your library but not to “${targetAlbum.name}”: ${message}\n\nAdd them from the Library with “Add to…”.`,
          });
        }
      }
      const inAlbum = albumName ? ` and to “${albumName}”` : "";
      // A session outlives an import until the user ends it: what wasn't
      // added - and what of its card isn't copied yet - stays for another
      // day, and another card can join it. Nothing is asked here; Close
      // session ends it, the way the session was set up at its start.
      setCommitNote(
        `${added.length.toLocaleString()} photo(s) added to your library${inAlbum}. This session stays open until you close it.`
      );
    },
    // A failed commit used to be completely invisible (no state change, no
    // message) - the button just looked dead. Staged files survive a failed
    // commit server-side, so tell the user retrying is safe.
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      void dialogs.alert({
        title: "Import failed",
        message: `${message}\n\nYour photos are still in this session. Nothing was lost. Please try again.`,
      });
    },
  });

  // Poll the backend's staging/commit progress while an import is in flight, so
  // the otherwise feature-less "Processing…/Importing…" spinners can show a live
  // count and estimated time remaining. During a folder import the review
  // session isn't published yet - poll via the staging session id instead.
  // (The staging-phase percentage itself - effectiveUploadPct/liveStagedCount -
  // comes from the import-session context, shared with the nav tab so the two
  // readouts always agree; this query re-uses the same key/cache and only
  // extends the polling into the commit phase, which the context doesn't track.)
  const progressPollId = sessionId ?? stagingSessionId;
  const { data: importProgress } = useQuery({
    queryKey: ["import-progress", progressPollId],
    queryFn: () => api.import.progress(progressPollId!),
    enabled: !!progressPollId && (isUploading || commit.isPending),
    refetchInterval: 500,
  });

  const folderImportActive = importMode === "folder" && isUploading;

  const progressSuffix = useMemo(() => {
    if (!importProgress || importProgress.total === 0 || importProgress.phase === "idle") return "";
    const eta =
      importProgress.eta_seconds != null ? ` · ~${formatEta(importProgress.eta_seconds)} left` : "";
    return ` ${importProgress.processed}/${importProgress.total}${eta}`;
  }, [importProgress]);

  // Estimate the upload's own time remaining from how fast the byte-percentage
  // is climbing (the backend ETA above only covers the staging phase that
  // follows). Timed from when the upload starts so the projection settles
  // quickly, and cleared as soon as bytes are done / the upload ends.
  const uploadStartRef = useRef<number | null>(null);
  const [uploadEta, setUploadEta] = useState<number | null>(null);
  useEffect(() => {
    if (!isUploading) {
      uploadStartRef.current = null;
      setUploadEta(null);
      return;
    }
    if (uploadStartRef.current === null) uploadStartRef.current = Date.now();
    const pct = effectiveUploadPct ?? 0;
    const elapsed = (Date.now() - uploadStartRef.current) / 1000;
    // Only project once there's a real sample to extrapolate from: the first
    // few percent (or first second) give a division-by-tiny-number estimate
    // that swings wildly, which read as the ETA "crashing". Guard against a
    // non-finite result too, so the label never shows NaN/Infinity.
    if (pct >= 3 && pct < 100 && elapsed >= 1) {
      const eta = (elapsed / pct) * (100 - pct);
      setUploadEta(Number.isFinite(eta) ? eta : null);
    } else {
      setUploadEta(null);
    }
  }, [isUploading, effectiveUploadPct]);
  const uploadEtaSuffix = uploadEta != null ? ` · ~${formatEta(uploadEta)} left` : "";

  // Same projection for the review screen's "still copying" banner, but from
  // the staged-file counter instead of byte percent: rate = files landed since
  // the banner appeared / elapsed time. Waits for a handful of files and a
  // couple of seconds so the first samples don't produce a wild estimate.
  const copyStartRef = useRef<{ t: number; count: number } | null>(null);
  const [copyEta, setCopyEta] = useState<number | null>(null);
  useEffect(() => {
    if (!stagingInBackground || liveStagedCount == null || totalFileCount == null) {
      copyStartRef.current = null;
      setCopyEta(null);
      return;
    }
    if (copyStartRef.current === null) {
      copyStartRef.current = { t: Date.now(), count: liveStagedCount };
      return;
    }
    const elapsed = (Date.now() - copyStartRef.current.t) / 1000;
    const landed = liveStagedCount - copyStartRef.current.count;
    if (elapsed >= 2 && landed >= 5) {
      const eta = ((totalFileCount - liveStagedCount) * elapsed) / landed;
      setCopyEta(Number.isFinite(eta) && eta >= 0 ? eta : null);
    }
  }, [stagingInBackground, liveStagedCount, totalFileCount]);

  // Discarding deletes every staged copy - tens of gigabytes off the library
  // disk for a big card, which takes long enough that the button label alone
  // read as a hang. Block the screen with the same wait overlay as saving edits
  // or resetting them, so it's clear the app is working and nothing else can be
  // clicked into the half-deleted session meanwhile.
  const discard = useMutation({
    // No folder flag: the server does what the session was started with (a
    // backup folder stays, any other import folder goes).
    mutationFn: () => withWait("Closing this session…", () => api.import.discard(sessionId!)),
    // Always reset locally, even if the delete itself failed (e.g. the
    // session was already committed/discarded) - the point of Discard is to
    // get back to a clean import screen, and a stale server-side session is
    // exactly the case where that recovery matters most.
    onSettled: () => {
      if (sessionId) clearReviewState(sessionId);
      endedSession.current = sessionId;
      reset();
      queryClient.invalidateQueries({ queryKey: ["import-sessions"] });
    },
  });

  // A file's capture date, falling back to its RAW/JPEG partner's (same shot,
  // same moment). Mid-analysis one half of a pair can have its EXIF read while
  // the other hasn't - without the fallback, pair-adjacent grouping would drag
  // an undated file into a dated month run and split the section in two.
  // Sorting, section labels and the date filter MUST all use this, never raw
  // taken_at.
  const effectiveTakenAt = useCallback(
    (f: StagedFileOut): string | null =>
      f.taken_at ??
      (f.paired_staged_file_id ? filesById.get(f.paired_staged_file_id)?.taken_at ?? null : null),
    [filesById]
  );

  // The whole filter set as one predicate, with one EXIF dimension optionally
  // lifted - the same cross-filtering as the library's facets: the camera list
  // is counted under every filter but the camera itself, so picking a camera
  // narrows the lenses and focal lengths while its alternatives stay listed.
  const passesFilters = useCallback(
    (f: StagedFileOut, without?: "camera" | "lens" | "focal") => {
      // Trash-restores stay visible even under "Hide duplicates": unlike
      // blocked duplicates they actively do something on import (restore
      // the photo). What an earlier partial import added hides with them.
      if (hideDuplicates && isDuplicate(f)) return false;
      if (viewMode === "jpeg_only" && f.file_type !== "jpeg") return false;
      if (viewMode === "raw_only" && f.file_type !== "raw") return false;
      if (ratingMin > 0 && f.rating < ratingMin) return false;
      if (colorFilter !== "none" && f.color_label !== colorFilter) return false;
      if (without !== "camera" && camera && f.camera_model !== camera) return false;
      if (without !== "lens" && lens && f.lens_model !== lens) return false;
      if (without !== "focal" && (focalMin || focalMax)) {
        // 0.05mm either side, the library's tolerance for its rounded stops.
        if (f.focal_length == null) return false;
        if (focalMin && f.focal_length < parseFloat(focalMin) - 0.05) return false;
        if (focalMax && f.focal_length > parseFloat(focalMax) + 0.05) return false;
      }
      if (dateFrom || dateTo) {
        const day = effectiveTakenAt(f)?.slice(0, 10);
        if (!day) return false;
        if (dateFrom && day < dateFrom) return false;
        if (dateTo && day > dateTo) return false;
      }
      return true;
    },
    [hideDuplicates, viewMode, ratingMin, colorFilter, camera, lens, focalMin, focalMax, dateFrom, dateTo, effectiveTakenAt]
  );

  // Memoized as one unit: the review grid lays out (and re-anchors) whenever
  // this array's identity changes, so rebuilding it on every unrelated render
  // would have the grid correcting its own scroll position under the user.
  const filteredFiles: StagedFileOut[] = useMemo(
    () => (files ?? []).filter((f) => passesFilters(f)),
    [files, passesFilters]
  );

  // Camera, lens and focal-length options for the filter menu, built from the
  // staged files the way the library's /images/facets builds them: most-used
  // first, focal lengths rounded to 0.1mm and in numeric order.
  const facets = useMemo(() => {
    const count = (without: "camera" | "lens" | "focal", key: (f: StagedFileOut) => string | null) => {
      const counts = new Map<string, number>();
      for (const f of files ?? []) {
        const v = key(f);
        if (v && passesFilters(f, without)) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      return [...counts].map(([value, n]) => ({ value, count: n }));
    };
    const byCount = (a: Facet, b: Facet) => b.count - a.count;
    return {
      cameras: count("camera", (f) => f.camera_model).sort(byCount),
      lenses: count("lens", (f) => f.lens_model).sort(byCount),
      focalLengths: count("focal", (f) =>
        f.focal_length && f.focal_length > 0 ? String(Math.round(f.focal_length * 10) / 10) : null
      ).sort((a, b) => parseFloat(a.value) - parseFloat(b.value)),
    };
  }, [files, passesFilters]);

  // Chronological review, OLDEST first (shooting order, like a culling app) -
  // deliberately the reverse of the library timeline: files stage in roughly
  // capture order, so ascending dates mean every incoming batch and every
  // still-analyzing file appends at the BOTTOM of the grid instead of
  // reshuffling what's already on screen. Files whose EXIF hasn't been read
  // yet have no date and wait at the end in staging order (the sort is
  // stable); when their analysis lands they join their day - which, files
  // arriving in capture order, is usually right where they already sit.
  // In combined view, either merge each pair into one JPEG card (mergePairs) or
  // keep the two halves adjacent. Other view modes show a flat list.
  const visibleFiles = useMemo(() => {
    const dateSorted = [...filteredFiles].sort((a, b) => {
      const ia = effectiveTakenAt(a);
      const ib = effectiveTakenAt(b);
      const ta = ia ? Date.parse(ia) : NaN;
      const tb = ib ? Date.parse(ib) : NaN;
      const aOk = Number.isFinite(ta);
      const bOk = Number.isFinite(tb);
      if (aOk && bOk) return ta - tb;
      if (aOk !== bOk) return aOk ? -1 : 1;
      return 0;
    });
    if (viewMode !== "combined") return dateSorted;
    return mergePairs
      ? collapsePairsBy(dateSorted, (f) => f.file_type, (f) => f.paired_staged_file_id)
      : groupPairsAdjacent(dateSorted, (f) => f.file_type, (f) => f.paired_staged_file_id);
  }, [filteredFiles, effectiveTakenAt, viewMode, mergePairs]);
  const lightboxIndex = useMemo(() => {
    if (lightboxFileId === null || visibleFiles.length === 0) return null;
    const found = visibleFiles.findIndex((f) => f.id === lightboxFileId);
    return found >= 0 ? found : Math.min(lightboxFallback.current, visibleFiles.length - 1);
  }, [lightboxFileId, visibleFiles]);

  // Keep the remembered position current, and adopt whatever file the fallback
  // landed on so the next arrow-key step continues from there.
  useEffect(() => {
    if (lightboxFileId === null) return;
    if (lightboxIndex === null) {
      // A preview restored from the session record (see restoredFor) has no
      // index until the file list has loaded - keep it until then.
      if (files) setLightboxFileId(null);
      return;
    }
    lightboxFallback.current = lightboxIndex;
    const shown = visibleFiles[lightboxIndex];
    if (shown && shown.id !== lightboxFileId) setLightboxFileId(shown.id);
  }, [lightboxIndex, lightboxFileId, visibleFiles, files]);

  const openLightboxAt = useCallback(
    (index: number) => {
      const file = visibleFiles[index];
      if (file) setLightboxFileId(file.id);
    },
    [visibleFiles]
  );

  const selectedCount = (files ?? []).filter((f) => f.selected).length;
  // Added by earlier partial imports of this session.
  const importedCount = (files ?? []).filter((f) => f.imported).length;

  // Opening a card shows the full-size preview, which is a different (much
  // larger) image than the grid thumbnail - so without this, every click
  // started its request only once the lightbox was already open, and the photo
  // arrived a beat later. Warm the preview of every card the user is currently
  // looking at, so clicking one has nothing left to fetch.
  //
  // Deliberately after scrolling settles: these are a few hundred KB each, and
  // firing them mid-scroll would compete with the thumbnails the grid is still
  // filling in. Cache-warming only (preloadImage), not pinned pixels - the
  // lightbox pins what it actually displays, and doing both would double the
  // renderer's image memory for the same photos.
  // Held back while the import is still copying or analyzing: until the
  // background pass has produced a file's preview, asking for one makes the
  // server render it on the spot, and a screenful of those at once would take
  // worker threads away from the very import that is producing them. Once the
  // import is done every preview is a plain file read and warming is cheap.
  const previewsAreCheap = !stagingInBackground && !analysisPending;

  // Day sections over the visible files (already date-sorted, so labels are
  // contiguous and unique), each entry keeping its index into visibleFiles -
  // the lightbox and shift-range selection keep addressing the flat list.
  // Days rather than the library's months: an import typically spans one trip
  // or shoot, where month granularity would collapse the whole batch into a
  // single section and the scrubber into a single useless marker.
  // label null = the dateless tail (files still being analyzed, or genuinely
  // without a capture date): shown as a plain grid with NO header and no
  // scrubber marker, rather than shouting "Unknown date" at every mid-import
  // state.
  const daySections: {
    label: string | null;
    date: Date | null;
    items: { file: StagedFileOut; index: number }[];
  }[] = [];
  visibleFiles.forEach((file, index) => {
    const iso = effectiveTakenAt(file);
    const parsed = iso ? new Date(iso) : null;
    const date = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
    const label = date ? dayLabel(iso) : null;
    const last = daySections[daySections.length - 1];
    if (last && last.label === label) last.items.push({ file, index });
    else daySections.push({ label, date, items: [{ file, index }] });
  });
  // The scrubber's big ticks are months, its small ticks day numbers. Month
  // ticks carry the year only when the import actually spans more than one.
  const importSpansYears =
    new Set(daySections.filter((s) => s.date).map((s) => s.date!.getFullYear())).size > 1;
  // Built here (not in the grid) because only the wizard knows whether the
  // batch spans years; the labels come from the same dayLabel() the grid
  // sections by, so every tick finds its section.
  const scrubberSections = daySections.flatMap((s) =>
    s.label && s.date
      ? [
          {
            label: s.label,
            tickGroup: `${s.date.getFullYear()}-${s.date.getMonth()}`,
            tickPrimary: s.date.toLocaleDateString(
              undefined,
              importSpansYears ? { month: "short", year: "numeric" } : { month: "short" }
            ),
            tickSecondary: String(s.date.getDate()),
          },
        ]
      : []
  );

  // When merged, a visible card stands in for both halves - expand a set of
  // visible files to also include each one's hidden RAW/JPEG partner so bulk
  // select/deselect acts on the whole pair, not just the shown JPEG.
  function withPartners(list: StagedFileOut[]): StagedFileOut[] {
    if (!mergePairs) return list;
    const out: StagedFileOut[] = [];
    const seen = new Set<string>();
    for (const f of list) {
      if (!seen.has(f.id)) {
        out.push(f);
        seen.add(f.id);
      }
      const partner = f.paired_staged_file_id ? filesById.get(f.paired_staged_file_id) : undefined;
      if (partner && !seen.has(partner.id)) {
        out.push(partner);
        seen.add(partner.id);
      }
    }
    return out;
  }

  // The library's selection: Cmd/Ctrl-click a card (or its corner checkbox,
  // once one is picked) to pick or drop it, shift-click to apply that to the
  // whole range since the last click. It leaves the import choice alone -
  // what happens to the picked cards is decided in the bottom bar and by its
  // keys (applyToMarked), never on a card. Exact duplicates can't be
  // imported, so there is nothing picking one could do.
  function toggleMark(index: number, shiftKey: boolean) {
    const target = visibleFiles[index];
    if (!target || isDuplicate(target)) return;
    setMarked((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastIndex !== null) {
        const unmark = next.has(target.id);
        const [start, end] = lastIndex < index ? [lastIndex, index] : [index, lastIndex];
        for (const f of visibleFiles.slice(start, end + 1)) {
          if (unmark) next.delete(f.id);
          else if (!isDuplicate(f)) next.add(f.id);
        }
      } else if (next.has(target.id)) {
        next.delete(target.id);
      } else {
        next.add(target.id);
      }
      return next;
    });
    setLastIndex(index);
  }

  // The import checkbox in a card's footer: that photo, in or out - picked or
  // not. A card's footer is always about its own photo; the picked cards as a
  // whole are decided in the bottom bar. (Exact duplicates can't be imported,
  // so they're skipped.)
  function toggleStagedSelect(index: number) {
    const target = visibleFiles[index];
    if (!target || isDuplicate(target)) return;
    updateStaged.mutate({ fileId: target.id, patch: { selected: !target.selected } });
  }

  // The picked cards that are on screen right now. A card the view mode has
  // since hidden no longer counts, so a bulk change never reaches a photo that
  // isn't shown as picked.
  const markedFiles = useMemo(() => visibleFiles.filter((f) => marked.has(f.id)), [visibleFiles, marked]);
  // The selection row's stars and swatches mirror the picked cards, exactly
  // as the library's bulk bar does.
  const markedMeta = selectionSharedMeta(markedFiles, marked);

  // One change for every picked card (and each one's hidden pair partner).
  async function applyToMarked(patch: { selected?: boolean; rating?: number; color_label?: ColorLabel }) {
    if (!sessionId || markedFiles.length === 0) return;
    const ids = withPartners(markedFiles)
      .filter((f) => !patch.selected || !isDuplicate(f))
      .map((f) => f.id);
    await api.import.bulkUpdateStagedFiles(sessionId, ids, patch);
    queryClient.invalidateQueries({ queryKey: ["import-files", sessionId] });
  }

  // Whether the picked cards are imported, for the bar's one checkbox: all of
  // them, none, or a mix (drawn as the dash). Same rule as a day heading's
  // box - a click takes them all, and clears them once they all are in.
  const markedImport = useMemo<"none" | "some" | "all">(() => {
    const ticked = markedFiles.filter((f) => f.selected).length;
    return ticked === 0 ? "none" : ticked === markedFiles.length ? "all" : "some";
  }, [markedFiles]);

  function toggleMarkedImport() {
    void applyToMarked({ selected: markedImport !== "all" });
  }

  // Selection state per day / month / year of the review grid, counted once per
  // render pass instead of per section header: the grid keeps a header mounted
  // for every day in the batch, and re-deriving three counts inside each of
  // them would walk the whole batch dozens of times on every poll of a running
  // import. Duplicates are left out entirely - they can never be selected, so
  // counting them would pin every section at "partly selected" forever.
  const sectionCounts = useMemo(() => {
    const days = new Map<string, { monthKey: string; yearKey: string; monthLabel: string; yearLabel: string }>();
    const counts = new Map<string, { total: number; selected: number }>();
    const months = new Set<string>();
    const years = new Set<string>();
    const bump = (key: string, selected: boolean) => {
      const c = counts.get(key) ?? { total: 0, selected: 0 };
      c.total += 1;
      if (selected) c.selected += 1;
      counts.set(key, c);
    };
    for (const f of visibleFiles) {
      if (isDuplicate(f)) continue;
      const iso = effectiveTakenAt(f);
      if (!iso) continue;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) continue;
      const label = dayLabel(iso);
      const yearKey = `y:${d.getFullYear()}`;
      const monthKey = `m:${d.getFullYear()}-${d.getMonth()}`;
      months.add(monthKey);
      years.add(yearKey);
      if (!days.has(label)) {
        days.set(label, {
          monthKey,
          yearKey,
          monthLabel: d.toLocaleDateString(undefined, { month: "long" }),
          yearLabel: String(d.getFullYear()),
        });
      }
      bump(`d:${label}`, f.selected);
      bump(monthKey, f.selected);
      bump(yearKey, f.selected);
    }
    // A batch shot on one day has exactly one month and one year, where those
    // buttons would just repeat what "Select all" already reaches - only offer a
    // wider scope when the batch actually spans one.
    return { days, counts, hasMonths: months.size > 1, hasYears: years.size > 1 };
  }, [visibleFiles, effectiveTakenAt]);

  // Which bucket a file belongs to, in the same keys sectionCounts uses.
  const scopeKeysOf = useCallback(
    (f: StagedFileOut): { day: string; month: string; year: string } | null => {
      const iso = effectiveTakenAt(f);
      if (!iso) return null;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return null;
      return {
        day: `d:${dayLabel(iso)}`,
        month: `m:${d.getFullYear()}-${d.getMonth()}`,
        year: `y:${d.getFullYear()}`,
      };
    },
    [effectiveTakenAt]
  );

  // Tick a whole day, month or year from its section header. Toggles: a scope
  // that is already fully selected clears instead, so the same control both
  // adds and removes - matching what shift-click now does.
  async function toggleSectionSelect(label: string, scope: "day" | "month" | "year") {
    const meta = sectionCounts.days.get(label);
    if (!meta || !sessionId) return;
    const key = scope === "day" ? `d:${label}` : scope === "month" ? meta.monthKey : meta.yearKey;
    const counted = sectionCounts.counts.get(key);
    if (!counted || counted.total === 0) return;
    const selected = counted.selected < counted.total;
    const inScope = visibleFiles.filter((f) => scopeKeysOf(f)?.[scope] === key);
    const ids = withPartners(inScope)
      .filter((f) => !isDuplicate(f))
      .map((f) => f.id);
    if (ids.length === 0) return;
    await api.import.bulkUpdateStagedFiles(sessionId, ids, { selected });
    queryClient.invalidateQueries({ queryKey: ["import-files", sessionId] });
  }

  // Handed to the grid so each day header can draw its own tri-state checkbox
  // (and, for a batch spanning more than one, the wider month/year toggles).
  const sectionSelect = {
    infoOf(label: string) {
      const meta = sectionCounts.days.get(label);
      if (!meta) return null;
      const stateOf = (key: string): "none" | "some" | "all" => {
        const c = sectionCounts.counts.get(key);
        if (!c || c.total === 0) return "none";
        return c.selected === 0 ? "none" : c.selected === c.total ? "all" : "some";
      };
      return {
        day: stateOf(`d:${label}`),
        month: sectionCounts.hasMonths ? stateOf(meta.monthKey) : null,
        year: sectionCounts.hasYears ? stateOf(meta.yearKey) : null,
        monthLabel: meta.monthLabel,
        yearLabel: meta.yearLabel,
      };
    },
    onToggle: toggleSectionSelect,
  };

  // Cmd/Ctrl+A picks every card shown and Escape drops the selection, as in
  // the library. Neither touches what gets imported - that is the whole point
  // of the review, not something to change with a stray key. Escape is left
  // to the preview while one is open (there it closes the preview).
  useSelectionKeys({
    onSelectAll: markAll,
    onClear: () => setMarked(new Set()),
    hasSelection: marked.size > 0 && lightboxIndex === null,
  });

  // With cards picked, the preview's two culling keys work on all of them:
  // 0-5 sets their stars, Space takes them in or leaves them out - the same
  // as the bar's stars and its import checkbox. The preview keeps both keys
  // for its own photo while it is open, a dialog keeps them for its buttons,
  // and a text box for typing. Read through a ref so the window listeners
  // aren't torn down on every render (as in useSelectionKeys).
  const markedKeys = useRef({ active: false, rate: (_rating: number) => {}, toggleImport: () => {} });
  markedKeys.current = {
    active: markedFiles.length > 0 && lightboxIndex === null,
    rate: (rating) => void applyToMarked({ rating }),
    toggleImport: toggleMarkedImport,
  };
  useEffect(() => {
    function claims(e: KeyboardEvent): "rate" | "import" | null {
      if (!markedKeys.current.active || document.querySelector(".modal-overlay")) return null;
      const target = e.target as HTMLElement | null;
      if (target && takesTyping(target)) return null;
      if (e.metaKey || e.ctrlKey || e.altKey) return null;
      if (e.key === " " || e.code === "Space") return "import";
      return e.key >= "0" && e.key <= "5" && e.key.length === 1 ? "rate" : null;
    }
    function onKeyDown(e: KeyboardEvent) {
      const what = claims(e);
      if (!what) return;
      e.preventDefault();
      if (e.repeat) return;
      if (what === "rate") markedKeys.current.rate(Number(e.key));
      else markedKeys.current.toggleImport();
    }
    // A checkbox or button that still has the focus from the last click (a
    // card's selection box, say) is activated by Space on key-UP - without
    // this the press would toggle the import and that control as well.
    function onKeyUp(e: KeyboardEvent) {
      if (claims(e) === "import") e.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // Every card shown (the filtered view - select exactly what you see), minus
  // the exact duplicates nothing can be done with.
  function markAll() {
    setMarked(new Set(visibleFiles.filter((f) => !isDuplicate(f)).map((f) => f.id)));
  }

  // The whole batch in or out, from the bar's two standing buttons - the one
  // visible way to take a card as it is, without knowing about selections.
  // Taking acts on the filtered view (exactly what you see); dropping acts on
  // the WHOLE batch. Filters hide files that are still ticked - Trash-restores
  // under the default "Hide duplicates", the other half of the type filter -
  // and a drop scoped to the visible ones left those invisibly ticked: the
  // count stayed above zero and they would have been imported.
  async function importAll(selected: boolean) {
    if (!sessionId) return;
    const scope = selected ? withPartners(visibleFiles) : files ?? [];
    const ids = scope.filter((f) => !selected || !isDuplicate(f)).map((f) => f.id);
    await api.import.bulkUpdateStagedFiles(sessionId, ids, { selected });
    queryClient.invalidateQueries({ queryKey: ["import-files", sessionId] });
  }
  // Nothing left for "Import all" to do: every card shown that can be imported
  // already is.
  const allShownTicked = visibleFiles.every((f) => f.selected || isDuplicate(f));

  async function handleCommitClick() {
    // Never commit a session whose background copying or analysis hasn't
    // finished - some photos aren't on disk / deduped yet. The button is
    // disabled in this state too; this is the belt-and-braces guard (and the
    // backend refuses with a 409 as the final line of defense).
    if (stagingInBackground || analysisPending) return;
    // Exact duplicates can't be selected (the backend 400s), so never offer to
    // auto-include one as a pair's "missing half" - and even if a select still
    // fails, the commit below must run regardless (allSettled, not all): a
    // rejected select used to abort this handler silently, making the import
    // button appear dead.
    const missingHalf = findIncompletePairs(files ?? []).filter((f) => !isDuplicate(f));
    if (missingHalf.length > 0) {
      const one = missingHalf.length === 1;
      const includeBoth = await dialogs.confirm({
        title: one ? "Import the matching file too?" : "Import the matching files too?",
        message: one
          ? "This photo exists as RAW and JPEG, but only one is selected. " +
            "Importing both keeps them as one photo."
          : `${missingHalf.length} of these photos exist as RAW and JPEG, but only one of each ` +
            "is selected. Importing both keeps each pair as one photo.",
        confirmLabel: "Import both files",
        cancelLabel: "Import only the selected",
      });
      if (includeBoth) {
        await Promise.allSettled(
          missingHalf.map((f) => api.import.updateStagedFile(sessionId!, f.id, { selected: true }))
        );
        queryClient.invalidateQueries({ queryKey: ["import-files", sessionId] });
      }
    }
    commit.mutate();
  }

  // Shared: filter a picked FileList down to importable photos and kick off the
  // upload. Used by both the folder picker and the individual-files picker.
  const stageFileList = useCallback(
    (fileList: FileList, label: string, emptyMessage: string) => {
      // input.files is a *live* FileList - snapshot what we need (pickImportableFiles
      // reads it) before the caller clears target.value, which empties that list.
      const picked = pickImportableFiles(fileList);
      if (picked.length === 0) {
        setPickError(emptyMessage, { keep: true });
        return;
      }
      setPickError(null);
      startUpload(picked, label);
    },
    [startUpload]
  );

  // Copy into an import folder (kept as a backup or not), or leave the photos
  // where they are? Asked once per fresh import (appends follow the session),
  // unless Settings remember an answer. The dialog is a promise the choose
  // screen renders; it resolves null when the user cancels, and nothing is
  // read then.
  const [modeAsk, setModeAsk] = useState<{
    defaultName: string;
    resolve: (choice: ImportChoice | null) => void;
  } | null>(null);
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);
  useEffect(() => {
    nativePick?.getLibraryRoot?.().then(setLibraryRoot).catch(() => {});
  }, [nativePick]);

  function askImportMode(defaultName: string): Promise<ImportChoice | null> {
    const remembered = importSettings?.mode_default;
    // A remembered copy collects in the library's Import folder; choosing
    // another place per session (and naming it) is what the dialog is for.
    if (remembered === "copy" || remembered === "reference") {
      return Promise.resolve({
        mode: remembered,
        stagingFolder: null,
        keepBackup: remembered === "copy" && importSettings?.backup_default === "keep",
        name: defaultName,
      });
    }
    return new Promise((resolve) => setModeAsk({ defaultName, resolve }));
  }

  function chooseImportMode(choice: ImportChoice, remember: boolean) {
    modeAsk?.resolve(choice);
    setModeAsk(null);
    if (remember) {
      api.settings
        .updateImport(
          // The backup answer belongs to a copy; leaving photos in place
          // says nothing about it.
          choice.mode === "copy"
            ? { mode_default: "copy", backup_default: choice.keepBackup ? "keep" : "delete" }
            : { mode_default: choice.mode }
        )
        .then((saved) => queryClient.setQueryData(["import-settings"], saved))
        .catch(() => {});
    }
  }

  // Add another card or folder to the session on screen. Each folder becomes
  // a source of its own, so it can be continued later like the first one;
  // individually picked photos just join the review.
  async function addFolderToOpenSession() {
    const folder = await nativePick?.pickFolder?.();
    if (folder) addFolderToSession(folder);
  }

  async function addFilesToOpenSession() {
    const picked = await nativePick?.pickFiles?.();
    if (picked && picked.length > 0) addFilesToSession(picked);
  }

  // The picked folder already has an open session: continuing it keeps the
  // culling done so far and copies only what's new, where a second session
  // would copy the whole card again.
  async function importFolder(folder: string) {
    setPickError(null);
    const open = await queryClient
      .fetchQuery({ queryKey: ["import-sessions"], queryFn: () => api.import.sessions() })
      .catch((): ImportSessionSummary[] => []);
    const same = open.find((s) =>
      s.sources.some((src) => src.root === folder || src.current_root === folder)
    );
    if (
      same &&
      (await dialogs.confirm({
        title: "Continue the open session?",
        message:
          `An import session for “${same.source_path}” is already open. Continuing it ` +
          "keeps your selection and ratings.",
        confirmLabel: "Continue session",
        cancelLabel: "Start a new session",
      }))
    ) {
      continueSession(same);
      return;
    }
    const choice = await askImportMode(folder.split("/").filter(Boolean).pop() || folder);
    if (choice) startFolderImport(folder, choice);
  }

  // File inputs use plain native listeners, not React's onChange: React's
  // synthetic event system has known quirks around file inputs where its
  // internal value-tracking can silently swallow the change event, so we talk
  // to the DOM directly. The folder input additionally gets webkitdirectory.
  useEffect(() => {
    const el = folderInputRef.current;
    if (!el) return;
    el.setAttribute("webkitdirectory", "");
    el.setAttribute("directory", "");
    function onChange(e: Event) {
      const target = e.target as HTMLInputElement;
      const fileList = target.files;
      if (!fileList || fileList.length === 0) {
        target.value = "";
        return;
      }
      const label = sourceLabelFor(fileList);
      stageFileList(fileList, label, "No JPEG or RAW photos found in that folder.");
      target.value = ""; // allow re-picking the same folder later
    }
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, [stageFileList]);

  useEffect(() => {
    const el = filesInputRef.current;
    if (!el) return;
    function onChange(e: Event) {
      const target = e.target as HTMLInputElement;
      const fileList = target.files;
      if (!fileList || fileList.length === 0) {
        target.value = "";
        return;
      }
      const label =
        fileList.length === 1 ? fileList[0].name : `${fileList.length} selected files`;
      stageFileList(fileList, label, "None of the selected files are JPEG or RAW photos.");
      target.value = ""; // allow re-picking the same files later
    }
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, [stageFileList]);

  // Close the import dropdown on an outside click or Escape.
  useEffect(() => {
    if (!importMenuOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (importMenuRef.current && !importMenuRef.current.contains(e.target as Node)) {
        setImportMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setImportMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [importMenuOpen]);

  if (!sessionId) {
    return (
      <div className="page">
        <h2 className="section-title">Import photos</h2>
        <ImportSteps current={1} />
        <p className="import-intro">
          <strong>Import</strong> copies photos into your library or adds them in place; you are
          asked which. An <strong>external source</strong> shows a folder without copying.
        </p>
        <input ref={folderInputRef} type="file" multiple style={{ display: "none" }} />
        <input ref={filesInputRef} type="file" multiple style={{ display: "none" }} />
        <Presence open={modeAsk !== null} ms={MOTION.modal}>
          {modeAsk && (
            <ImportModeDialog
              libraryRoot={libraryRoot}
              defaultName={modeAsk.defaultName}
              defaultBackup={importSettings?.backup_default === "keep"}
              onChoose={chooseImportMode}
              onClose={() => {
                modeAsk.resolve(null);
                setModeAsk(null);
              }}
            />
          )}
        </Presence>

        <div className="import-panels">
          <ImportSessions />

          <div className="import-panel import-panel--menu">
            <h3 className="section-title">Import into library</h3>
            <p className="import-panel-desc">
              Bring photos from an SD card, camera, or folder into your library.
            </p>
            <div className="import-menu" ref={importMenuRef}>
              <button
                className="btn primary"
                onClick={() => setImportMenuOpen((v) => !v)}
                disabled={isUploading}
                aria-haspopup="menu"
                aria-expanded={importMenuOpen}
              >
                {/* Working: the count can sit at 0 for a while on a slow
                    card, so the spinner is what says it hasn't hung. */}
                {isUploading && <Spinner tone="inherit" inline />}
                {!isUploading
                  ? <><IconImport size={13} /> Import photos <IconChevronDown size={12} /></>
                  : folderImportActive
                    ? totalFileCount
                      ? `Importing… ${effectiveUploadPct ?? 0}% · ${(liveStagedCount ?? 0).toLocaleString()} / ${totalFileCount.toLocaleString()} photos${uploadEtaSuffix}`
                      : "Scanning folder…"
                    : (uploadProgress ?? 0) >= 100
                      ? `Processing files…${progressSuffix}`
                      : `Importing… ${uploadProgress ?? 0}%${uploadEtaSuffix}`}
              </button>
              {/* Bail out of a long SD-card upload without waiting for it to
                  finish - aborts the in-flight request and clears the screen.
                  Hidden once the server is past receiving bytes ("Processing"),
                  since at that point the batch is already staging server-side. */}
              {isUploading && (uploadProgress ?? 0) < 100 && (
                <button
                  className="btn danger"
                  style={{ marginLeft: 8 }}
                  onClick={() => void confirmCancelUpload()}
                  title="Stop and discard everything copied so far"
                >
                  Cancel
                </button>
              )}
              {/* The other way out of a long copy: stop asking for more photos
                  but keep the ones already staged, so a card you only wanted
                  the first part of can go straight to review. */}
              {isUploading && canStopStaging && (
                <button
                  className="btn"
                  style={{ marginLeft: 8 }}
                  onClick={stopStaging}
                  disabled={stagingStopped}
                  title="Stop copying and review the photos copied so far"
                >
                  {stagingStopped ? "Stopping…" : "Stop & keep"}
                </button>
              )}
              <Presence open={importMenuOpen && !isUploading} ms={MOTION.pop}>
                {importMenuOpen && !isUploading && (
                  <div className="import-menu-dropdown" role="menu">
                    <button
                      className="import-menu-item"
                      role="menuitem"
                      onClick={async () => {
                        setImportMenuOpen(false);
                        // Desktop app: use the native folder dialog and let the
                        // backend read the files straight from disk - no browser
                        // upload, which for a big SD card/drive is both much
                        // faster and immune to upload aborts. Browser build
                        // falls back to the webkitdirectory picker.
                        const pickFolder = window.photoManager?.pickFolder;
                        if (pickFolder) {
                          const folder = await pickFolder();
                          if (folder) await importFolder(folder);
                          return;
                        }
                        folderInputRef.current?.click();
                      }}
                    >
                      <IconFolder size={14} /> Choose folder…
                    </button>
                    <button
                      className="import-menu-item"
                      role="menuitem"
                      onClick={async () => {
                        setImportMenuOpen(false);
                        // Desktop app: native file dialog + backend reads the
                        // files straight from disk - the same incremental
                        // staging as a folder import (review opens right away,
                        // grid fills as photos land) instead of a browser
                        // upload that only shows the grid once everything is
                        // through. Browser build falls back to the file input.
                        const pickFiles = window.photoManager?.pickFiles;
                        if (pickFiles) {
                          const picked = await pickFiles();
                          if (picked && picked.length > 0) {
                            setPickError(null);
                            const label =
                              picked.length === 1
                                ? picked[0].path.split("/").filter(Boolean).pop() || picked[0].path
                                : `${picked.length} selected files`;
                            const choice = await askImportMode(label);
                            if (choice) startFilesImport(picked, label, choice);
                          }
                          return;
                        }
                        filesInputRef.current?.click();
                      }}
                    >
                      <IconImage size={14} /> Choose files…
                    </button>
                  </div>
                )}
              </Presence>
            </div>
            {isUploading && (
              <p className="import-panel-desc" style={{ color: "var(--text-muted)", marginTop: 12 }}>
                {folderImportActive
                  ? totalFileCount
                    ? `Photos are being ${inPlace ? "read" : "copied"} and analyzed in the background. Nothing is added to your library until you have reviewed them.`
                    : "Looking for photos in the selected folder…"
                  : "Photos are being received. The review screen opens as soon as they are copied."}
              </p>
            )}
            {pickError && <p className="status-note status-note--error">{pickError}</p>}
            {uploadError && (
              <p className="import-panel-desc" style={{ color: "var(--danger)", marginTop: 12 }}>Upload failed: {uploadError}</p>
            )}
          </div>

          <ImportLibrary />

          <ExternalSources />
        </div>
      </div>
    );
  }

  const addHint = isUploading
    ? `Available once ${inPlace ? "reading" : "copying"} has finished.`
    : "Collect from several cards or folders in this session.";

  return (
    <div className="page page-timeline">
      <div className="import-review-head">
        <ImportSteps current={2} />
        {/* Title and explanation run on in one line; the header stays three
            lines tall on a wide window instead of five. */}
        <div className="import-review-intro">
          <h2 className="section-title">Review &amp; choose what to keep</h2>
          <p className="import-review-sub">
            From <strong>{sourceLabel}</strong>.{" "}
            {importedCount > 0
              ? `${importedCount.toLocaleString()} photo(s) already in your library.`
              : "Nothing is in your library yet."}{" "}
            {inPlace && "Added photos stay where they are. "}
            Select what to keep, then click "Add to library".
          </p>
        </div>
        {/* A session can collect from more than one card or folder - add the
            next one without leaving the review. Desktop only: it needs native
            paths the backend reads itself. What the buttons are for is in
            their tooltips; the session's folder shares the row. */}
        {(nativePick?.pickFolder || sessionFolder) && (
          <div className="import-add-row">
            {nativePick?.pickFolder && (
              <>
                <button
                  className="btn btn-sm"
                  onClick={addFolderToOpenSession}
                  disabled={isUploading}
                  title={addHint}
                >
                  <IconFolder size={12} /> Add folder…
                </button>
                {nativePick.pickFiles && (
                  <button
                    className="btn btn-sm"
                    onClick={addFilesToOpenSession}
                    disabled={isUploading}
                    title={addHint}
                  >
                    <IconImage size={12} /> Add photos…
                  </button>
                )}
              </>
            )}
            {sessionFolder && <ImportFolder folder={sessionFolder} backup={sessionBackup} />}
          </div>
        )}
        {/* Background copying still running: photos keep appearing, and the
            commit button below stays disabled until this finishes. */}
        {stagingInBackground && (
          <p className="import-staging-banner" role="status" aria-live="polite">
            <Spinner /> Still {inPlace ? "reading" : "copying"} photos in the background…{" "}
            {liveStagedCount != null && totalFileCount != null
              ? `${liveStagedCount.toLocaleString()} / ${totalFileCount.toLocaleString()}${
                  copyEta != null ? ` · ~${formatEta(copyEta)} left` : ""
                }`
              : ""}{" "}
            You can start reviewing now.
            <button
              className="btn btn-sm"
              onClick={stopStaging}
              disabled={stagingStopped}
              title={`Stop ${inPlace ? "reading" : "copying"} and keep the photos ${inPlace ? "read" : "copied"} so far`}
            >
              {stagingStopped ? "Stopping…" : inPlace ? "Stop" : "Stop copying"}
            </button>
          </p>
        )}
        {/* Stopped on purpose: the batch is short because the user said so.
            Without this the review just looks like an import that lost half
            the card. */}
        {stoppedEarly && (
          <p className="import-staging-banner" role="status">
            {inPlace ? "Reading" : "Copying"} stopped. The {(files?.length ?? 0).toLocaleString()}{" "}
            photo(s) {inPlace ? "read" : "copied"} so far are shown below.{" "}
            {sessionResumable
              ? `Continue this session later to ${inPlace ? "add" : "copy"} the rest.`
              : "To get the rest, import the same source again later."}
          </p>
        )}
        {sourceNotice && (
          <p className="import-staging-banner" role="status">
            {sourceNotice}
          </p>
        )}
        {commitNote && (
          <p className="import-staging-banner" role="status">
            {commitNote}
          </p>
        )}
        {/* Copying done, background analysis (thumbnails/EXIF/duplicates)
            still catching up: placeholders fill in as it runs. */}
        {analyzingInBackground && (
          <p className="import-staging-banner" role="status" aria-live="polite">
            <Spinner /> Analyzing photos in the background…{" "}
            {analysisTotal > 0
              ? `${analysisProcessed.toLocaleString()} / ${analysisTotal.toLocaleString()}`
              : ""}{" "}
            You can review now; importing unlocks when the analysis is done.
          </p>
        )}
        {stagingError && !stagingInBackground && (
          <p className="import-staging-banner import-staging-banner--error" role="alert">
            Some photos could not be loaded ({stagingError}). You can still import the ones shown
            below.
          </p>
        )}
      </div>
      <PhotoFilters
        viewMode={viewMode}
        onViewMode={setViewMode}
        ratingMin={ratingMin}
        onRatingMin={setRatingMin}
        colorLabel={colorFilter}
        onColorLabel={setColorFilter}
        cameras={facets.cameras}
        camera={camera}
        onCamera={setCamera}
        lenses={facets.lenses}
        lens={lens}
        onLens={setLens}
        focalLengths={facets.focalLengths}
        focalMin={focalMin}
        focalMax={focalMax}
        onFocalRange={(min, max) => {
          setFocalMin(min);
          setFocalMax(max);
        }}
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFrom={setDateFrom}
        onDateTo={setDateTo}
        viewExtras={
          // A toggle chip like its neighbours rather than a checkbox label:
          // the same height and on-state as every other toggle in the bar.
          // data-label reserves the chip's bold width, so turning it on
          // doesn't push the Filter chip along.
          <button
            type="button"
            className={`toggle-chip toggle-chip--steady${hideDuplicates ? " active" : ""}`}
            aria-pressed={hideDuplicates}
            onClick={() => setHideDuplicates(!hideDuplicates)}
            title="Hide photos that are already in the library"
            data-label="Hide duplicates"
          >
            Hide duplicates
          </button>
        }
      >
        {/* The library's two selection buttons, shown as there: only once a
            card is picked (Cmd/Ctrl-click, Shift-click) - the toolbar stays
            clean while nothing is selected; Cmd/Ctrl+A works anytime. They
            pick cards, they import nothing: taking what is picked is the
            import checkbox in the bottom bar's selection row. */}
        {marked.size > 0 && (
          <>
            <button className="btn btn-sm" onClick={markAll} title={`Select every photo shown (${modKeyLabel}+A)`}>
              Select all
            </button>
            <button className="btn btn-sm" onClick={() => setMarked(new Set())} title="Clear the selection (Esc)">
              Clear selection
            </button>
          </>
        )}
      </PhotoFilters>
      <div className="page-scroll">
      <div className="filter-bar action-bar--bottom" ref={actionBarRef}>
        {/* The library's bulk bar, as a row of its own on top of this one:
            the bar is anchored to the window's bottom edge, so it grows
            upward and the count and buttons below stay exactly where they
            are. Everything a card's footer holds - stars, colour, import -
            once more, here for all the picked photos: a card decides for
            its own photo, this row for the selection. */}
        {markedFiles.length > 0 && (
          <div className="control-group action-bar-selection">
            <span>{markedFiles.length} selected</span>
            <RatingStars
              rating={markedMeta.rating}
              onChange={(rating) => applyToMarked({ rating })}
              title="Rate the selected photos (0–5)"
            />
            <ColorLabelPicker
              value={markedMeta.colorLabel}
              onChange={(color_label) => applyToMarked({ color_label })}
            />
            <label className="filter-field filter-field-inline" title="Import or skip the selected photos (Space)">
              <input
                type="checkbox"
                checked={markedImport === "all"}
                // "Partly imported" has no JSX attribute - it's a DOM property only.
                ref={(el) => {
                  if (el) el.indeterminate = markedImport === "some";
                }}
                onChange={toggleMarkedImport}
              />{" "}
              Import
            </label>
          </div>
        )}
        <div className="control-group">
          {/* Always there, switched off rather than hidden when there is
              nothing for them to do - a review that starts with nothing ticked
              (the default) starts at "Import all". They tick, they don't
              select: the selection stays as it is. */}
          <button
            className="btn"
            onClick={() => importAll(true)}
            disabled={visibleFiles.length === 0 || allShownTicked}
            title="Import every photo shown"
          >
            Import all
          </button>
          <button
            className="btn"
            onClick={() => importAll(false)}
            disabled={selectedCount === 0}
            title="Import none of the photos"
          >
            Import none
          </button>
          {/* What the two buttons before it add up to. A slot as wide as the
              longest count this batch can show, in digits of equal width, so
              nothing after it moves while the count climbs from 0 to
              everything. */}
          <span
            style={{
              minWidth: `${2 * String(files?.length ?? 0).length + 12}ch`,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {selectedCount} of {files?.length ?? 0} to import
          </span>
          {importedCount > 0 && <span>{importedCount.toLocaleString()} already added</span>}
        </div>
        {/* The bar reads left to right in the order the work goes: what to
            import, where it goes and the button that does it - and, apart
            at the far end, the two ways to leave the review without adding
            anything. */}
        <div className="control-group">
          {/* Only shown when Immich is configured in Settings - an inert greyed
              checkbox is just clutter for everyone who doesn't use Immich. In
              selective/full sync modes the per-import checkbox is replaced by a
              status chip, since uploads are driven by the sync mode instead. */}
          {immichConfigured && immichMode === "manual" && (
            <ImmichSyncToggle
              on={uploadToImmich}
              onToggle={setUploadToImmich}
              label="Add to Immich"
              title="Upload the selected photos to Immich after import. RAW files only if enabled in Settings."
            />
          )}
          {immichConfigured && immichMode === "selective" && (
            <ImmichSyncToggle
              on={syncAllToImmich}
              onToggle={setSyncAllToImmich}
              title="Mark every imported photo for Immich sync. RAW files only if enabled in Settings."
            />
          )}
          {immichConfigured && immichMode === "full" && (
            <span
              className="filter-field filter-field-inline"
              style={{ color: "var(--text-muted)" }}
              title="Change this under Settings → Immich integration → Sync mode"
            >
              🔄 Immich full sync is on. Every imported photo is uploaded automatically.
            </span>
          )}
          <ImportAlbumPicker
            albumId={targetAlbum ? targetAlbum.id : null}
            onChange={setTargetAlbumId}
            disabled={commit.isPending}
          />
          <button
            className="btn primary"
            onClick={handleCommitClick}
            disabled={selectedCount === 0 || commit.isPending || stagingInBackground || analysisPending}
            title={
              stagingInBackground
                ? `Available when all photos have been ${inPlace ? "read" : "copied"}`
                : analysisPending
                  ? "Available when all photos have been analyzed"
                  : inPlace
                    ? "Add the selected photos to your library from where they are"
                    : sessionBackup
                      ? "Copy the selected photos into your library; they also stay in the import folder"
                      : sessionFolder
                        ? "Move the selected photos from the import folder into your library"
                        : "Add the selected photos to your library"
            }
          >
            {commit.isPending ? (
              <>
                <Spinner tone="inherit" inline />
                {`Adding to library…${progressSuffix}`}
              </>
            ) : stagingInBackground ? (
              inPlace ? "Reading photos…" : "Copying photos…"
            ) : analysisPending ? (
              `Analyzing… ${analysisProcessed}/${analysisTotal}`
            ) : (
              `Add ${selectedCount} photo(s) to library`
            )}
          </button>
        </div>
        <div className="control-group" style={{ marginLeft: "auto" }}>
          {/* Closes the review, keeps the session: it is listed on the Import
              page to continue - selection, ratings and copies all as left. */}
          <button
            className="btn"
            onClick={() => {
              leaveSession();
              queryClient.invalidateQueries({ queryKey: ["import-sessions"] });
            }}
            disabled={commit.isPending || discard.isPending}
            title="Keep the session open and come back from the Import page. Nothing is deleted."
          >
            <IconBookmark size={14} /> Continue later
          </button>
          <button
            className="btn"
            onClick={async () => {
              // What closing does was decided when the session started; it
              // only stops to confirm when copies of photos that were never
              // added would be deleted.
              const ok = await confirmCloseSession(dialogs, {
                label: sourceLabel,
                mode: sessionMode,
                folder: sessionFolder,
                keepBackup: sessionBackup,
                leftover: files ? files.filter((f) => !f.imported && !isDuplicate(f)).length : null,
              });
              if (ok) discard.mutate();
            }}
            disabled={discard.isPending}
            title={closeSessionTitle(sessionMode, sessionFolder, sessionBackup)}
          >
            {discard.isPending ? (
              <>
                <Spinner tone="inherit" inline />
                Closing…
              </>
            ) : (
              <>
                <IconLeave size={14} /> Close session
              </>
            )}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="empty-state">Processing files…</div>
      ) : (
        /* Day-sectioned with the library's date scrubber on the right edge -
           reviewing a big card scrolls and navigates like the library, at the
           day granularity an import batch actually has. */
        <ImportReviewGrid
          sessionId={sessionId}
          files={visibleFiles}
          takenAtOf={effectiveTakenAt}
          mergePairs={mergePairs}
          viewMode={viewMode}
          onToggleSelect={toggleStagedSelect}
          markedIds={marked}
          onToggleMark={toggleMark}
          sectionSelect={sectionSelect}
          onOpen={openLightboxAt}
          onPatch={(fileId, patch) => updateStaged.mutate({ fileId, patch })}
          warmPreviews={previewsAreCheap}
          initialScroll={savedScroll.current}
          // `sessionId` is captured per render: the unmount report after
          // "Continue later" arrives when the context has already dropped it.
          onScrollAnchor={(anchor) => {
            if (endedSession.current === sessionId) return;
            savedScroll.current = anchor;
            updateReviewState(sessionId, { scroll: anchor });
          }}
          scrubberSections={scrubberSections}
          getBottomInset={() => actionBarRef.current?.offsetHeight ?? 0}
          // Only the *set-narrowing* filters reset the scroll. The view mode
          // and pair merging are handled by the anchor's partner lookup, which
          // keeps the same shot on screen across the switch.
          resetKey={`${hideDuplicates}|${ratingMin}|${colorFilter}|${camera}|${lens}|${focalMin}|${focalMax}|${dateFrom}|${dateTo}`}
        />
      )}
      </div>

      <Presence open={lightboxIndex !== null} ms={MOTION.overlay}>
        {lightboxIndex !== null && (
          <ImportLightbox
            sessionId={sessionId}
            files={visibleFiles}
            index={lightboxIndex}
            onIndexChange={openLightboxAt}
            onClose={() => setLightboxFileId(null)}
            onUpdate={(fileId, patch) => updateStaged.mutate({ fileId, patch })}
            showImmichSync={immichConfigured && immichMode === "selective"}
            pairsMerged={mergePairs && viewMode === "combined"}
          />
        )}
      </Presence>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ColorLabel, StagedFileOut, ViewMode } from "../api/types";
import { RatingStars } from "../components/RatingStars";
import { ColorLabelPicker } from "../components/ColorLabelPicker";
import { PhotoFilters } from "../components/PhotoFilters";
import { ImportLightbox } from "../components/ImportLightbox";
import { ExternalSources } from "../components/ExternalSources";
import { fileTypeBadge, fileTypeBadgeClass, tileStyle, Thumb } from "../components/ThumbnailGrid";
import { TimelineScrubber } from "../components/TimelineScrubber";
import { collapsePairsBy, groupPairsAdjacent } from "../utils/pairing";
import { pickImportableFiles, sourceLabelFor } from "../utils/folderPick";
import { preloadImage, watchInViewport } from "../utils/preload";
import { useImportSession } from "../state/importSession";
import { useAppDialogs } from "../components/AppDialogs";
import { useTasks } from "../state/tasks";
import { useWait } from "../state/wait";
import { useMergePairs } from "../state/viewPrefs";
import { useTransientMessage } from "../utils/transientMessage";
import { IconChevronDown } from "../components/Icons";

// Human-readable "time remaining" for the import ETA (e.g. "45s", "2m 10s",
// "1h 57m" - never "116m 46s").
function formatEta(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM ? `${h}h ${remM}m` : `${h}h`;
}

// Byte-identical to a photo already in the library or elsewhere in this same
// batch - the backend refuses to import these, so the UI shouldn't let you
// select them in the first place. Exception: a copy of a photo sitting in the
// Trash may be imported (it restores that photo), so it stays selectable.
// A flagged duplicate is always an identical file: nothing is flagged for
// merely looking alike, so there is no "maybe" case to keep selectable.
function isDuplicate(f: StagedFileOut): boolean {
  return Boolean(f.duplicate_of_image_id || f.duplicate_of_staged_file_id) && !f.duplicate_in_trash;
}

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
  const steps = ["Choose photos", "Review & select", "In your library"];
  return (
    <ol className="import-steps" aria-label="Import steps">
      {steps.map((label, i) => {
        const n = i + 1;
        const state = n === current ? " active" : n < current ? " done" : "";
        return (
          <li key={label} className={`import-step${state}`}>
            <span className="import-step-num" aria-hidden>
              {n < current ? "✓" : n}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
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
    cancelUpload,
    reset,
  } = useImportSession();
  // Review is open (sessionId set) but the remaining batches are still copying
  // in the background: keep the grid refreshing and block commit until done.
  const stagingInBackground = !!sessionId && isUploading;
  // Copying is done but the background analysis (thumbnails, EXIF, duplicate
  // detection) hasn't caught up yet - reviewing works, committing is blocked.
  const analyzingInBackground = !!sessionId && !isUploading && analysisPending;
  const [hideDuplicates, setHideDuplicates] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("combined");
  const [ratingMin, setRatingMin] = useState(0);
  const [colorFilter, setColorFilter] = useState<ColorLabel>("none");
  // Flash message - auto-dismisses after a moment.
  const [pickError, setPickError] = useTransientMessage(8000);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [uploadToImmich, setUploadToImmich] = useState(false);
  // Selective sync: flag *everything* imported for Immich sync at commit.
  const [syncAllToImmich, setSyncAllToImmich] = useState(false);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);
  const importMenuRef = useRef<HTMLDivElement | null>(null);
  // Date-scrubber wiring for the review grid (same pattern as ThumbnailGrid's
  // groupByDate timeline): the grid root to find the scroller from, one DOM
  // node per day section, and the fixed bottom action bar whose height the
  // rail must stay clear of.
  const gridRootRef = useRef<HTMLDivElement | null>(null);
  const sectionEls = useRef<Map<string, HTMLElement>>(new Map());
  const actionBarRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();

  const { data: immich } = useQuery({
    queryKey: ["immich-settings"],
    queryFn: () => api.settings.getImmich(),
  });
  const immichConfigured = Boolean(immich?.base_url && immich?.api_key_set && immich.enabled);
  const immichMode = immich?.sync_mode ?? "manual";

  const mergePairs = useMergePairs();

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

  const commit = useMutation({
    mutationFn: () =>
      api.import.commit(
        sessionId!,
        uploadToImmich && immichConfigured,
        syncAllToImmich && immichConfigured && immichMode === "selective"
      ),
    onSuccess: () => {
      // The freshly-imported photos won't appear on the Library until its
      // ["images"] query refetches - invalidate so they show up immediately
      // instead of only after a manual page refresh. The Trash too: importing
      // a copy of a trashed photo restores it, so its thumb must leave the
      // Trash grid right away.
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["trash"] });
      // Without this, the session tracked in context (see state/importSession)
      // stays set after a successful commit, so revisiting /import re-opens
      // this same now-committed session - and Discard then 400s because it's
      // no longer in "staging" status, leaving no way back to a fresh import.
      reset();
      navigate("/");
    },
    // A failed commit used to be completely invisible (no state change, no
    // message) - the button just looked dead. Staged files survive a failed
    // commit server-side, so tell the user retrying is safe.
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      void dialogs.alert({
        title: "Import failed",
        message: `${message}\n\nYour photos are still in the staging area - nothing was lost. Please try again.`,
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
  const { withWait } = useWait();
  const discard = useMutation({
    mutationFn: () => withWait("Discarding this import…", () => api.import.discard(sessionId!)),
    // Always reset locally, even if the delete itself failed (e.g. the
    // session was already committed/discarded) - the point of Discard is to
    // get back to a clean import screen, and a stale server-side session is
    // exactly the case where that recovery matters most.
    onSettled: () => reset(),
  });

  // Lock the nav + show the top-bar spinner while an import commit runs, same as
  // the Settings maintenance tasks and the Immich upload.
  const { setBusyLabel } = useTasks();
  useEffect(() => {
    setBusyLabel(commit.isPending ? "Adding photos to your library…" : null);
  }, [commit.isPending, setBusyLabel]);
  useEffect(() => () => setBusyLabel(null), [setBusyLabel]);

  const filteredFiles: StagedFileOut[] = (files ?? []).filter((f) => {
    // Trash-restores stay visible even under "Hide duplicates": unlike blocked
    // duplicates they actively do something on import (restore the photo).
    if (
      hideDuplicates &&
      (f.duplicate_of_image_id || f.duplicate_of_staged_file_id) &&
      !f.duplicate_in_trash
    )
      return false;
    if (viewMode === "jpeg_only" && f.file_type !== "jpeg") return false;
    if (viewMode === "raw_only" && f.file_type !== "raw") return false;
    if (ratingMin > 0 && f.rating < ratingMin) return false;
    if (colorFilter !== "none" && f.color_label !== colorFilter) return false;
    return true;
  });
  // A file's capture date, falling back to its RAW/JPEG partner's (same shot,
  // same moment). Mid-analysis one half of a pair can have its EXIF read while
  // the other hasn't - without the fallback, pair-adjacent grouping would drag
  // an undated file into a dated month run and split the section in two.
  // Sorting and section labels below MUST both use this, never raw taken_at.
  const effectiveTakenAt = (f: StagedFileOut): string | null =>
    f.taken_at ??
    (f.paired_staged_file_id ? filesById.get(f.paired_staged_file_id)?.taken_at ?? null : null);

  // Chronological review, OLDEST first (shooting order, like a culling app) -
  // deliberately the reverse of the library timeline: files stage in roughly
  // capture order, so ascending dates mean every incoming batch and every
  // still-analyzing file appends at the BOTTOM of the grid instead of
  // reshuffling what's already on screen. Files whose EXIF hasn't been read
  // yet have no date and wait at the end in staging order (the sort is
  // stable); when their analysis lands they join their day - which, files
  // arriving in capture order, is usually right where they already sit.
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
  // In combined view, either merge each pair into one JPEG card (mergePairs) or
  // keep the two halves adjacent. Other view modes show a flat list.
  const visibleFiles =
    viewMode === "combined"
      ? mergePairs
        ? collapsePairsBy(dateSorted, (f) => f.file_type, (f) => f.paired_staged_file_id)
        : groupPairsAdjacent(dateSorted, (f) => f.file_type, (f) => f.paired_staged_file_id)
      : dateSorted;
  const selectedCount = (files ?? []).filter((f) => f.selected).length;

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
  const visibleCardIds = useRef(new Set<string>());
  const warmTimer = useRef<number | null>(null);
  const warmVisiblePreviews = useCallback(() => {
    if (!sessionId) return;
    if (warmTimer.current !== null) window.clearTimeout(warmTimer.current);
    warmTimer.current = window.setTimeout(() => {
      warmTimer.current = null;
      for (const id of visibleCardIds.current) {
        preloadImage(api.import.stagedPreviewUrl(sessionId, id));
      }
    }, 250);
  }, [sessionId]);

  useEffect(() => {
    const root = gridRootRef.current;
    if (!root || !sessionId) return;
    const unwatch: Array<() => void> = [];
    root.querySelectorAll<HTMLElement>("[data-staged-id]").forEach((el) => {
      const id = el.dataset.stagedId;
      if (!id) return;
      unwatch.push(
        watchInViewport(el, {
          enter: () => {
            visibleCardIds.current.add(id);
            warmVisiblePreviews();
          },
          leave: () => visibleCardIds.current.delete(id),
        })
      );
    });
    return () => {
      unwatch.forEach((u) => u());
      if (warmTimer.current !== null) {
        window.clearTimeout(warmTimer.current);
        warmTimer.current = null;
      }
    };
  }, [visibleFiles, sessionId, warmVisiblePreviews]);

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
    const label = date
      ? date.toLocaleDateString(undefined, {
          weekday: "short",
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      : null;
    const last = daySections[daySections.length - 1];
    if (last && last.label === label) last.items.push({ file, index });
    else daySections.push({ label, date, items: [{ file, index }] });
  });
  // The scrubber's big ticks are months, its small ticks day numbers. Month
  // ticks carry the year only when the import actually spans more than one.
  const importSpansYears =
    new Set(daySections.filter((s) => s.date).map((s) => s.date!.getFullYear())).size > 1;

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

  // Library-style selection: in select mode, click a card to toggle whether
  // it's imported, shift-click to select the whole range since the last click.
  // (Exact duplicates can't be imported, so they're skipped.) Outside select
  // mode a plain click opens the lightbox preview instead - the per-card
  // checkbox still toggles import selection in either mode.
  async function toggleStagedSelect(index: number, shiftKey: boolean) {
    const target = visibleFiles[index];
    if (!target || isDuplicate(target)) return;
    if (shiftKey && lastIndex !== null) {
      const [start, end] = lastIndex < index ? [lastIndex, index] : [index, lastIndex];
      const range = withPartners(visibleFiles.slice(start, end + 1)).filter((f) => !isDuplicate(f));
      await api.import.bulkUpdateStagedFiles(sessionId!, range.map((f) => f.id), { selected: true });
      queryClient.invalidateQueries({ queryKey: ["import-files", sessionId] });
    } else {
      updateStaged.mutate({ fileId: target.id, patch: { selected: !target.selected } });
    }
    setLastIndex(index);
  }

  async function selectAll(selected: boolean) {
    // Selecting acts on the filtered view (select exactly what you see);
    // clearing acts on the WHOLE batch. Filters hide files that are still
    // selected - Trash-restores under the default "Hide duplicates", the
    // other half of the type filter - and a clear scoped to the visible ones
    // left those invisibly selected: the count stayed above zero and they
    // would have been imported.
    const scope = selected ? withPartners(visibleFiles) : files ?? [];
    const ids = scope.filter((f) => !selected || !isDuplicate(f)).map((f) => f.id);
    await api.import.bulkUpdateStagedFiles(sessionId!, ids, { selected });
    queryClient.invalidateQueries({ queryKey: ["import-files", sessionId] });
  }

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
      const includeBoth = await dialogs.confirm({
        title: "Incomplete RAW+JPEG pairs",
        message:
          `${missingHalf.length} shot(s) have only the RAW or only the JPEG selected. ` +
          `Include the missing file for these shots too?`,
        confirmLabel: "Include both",
        cancelLabel: "Keep selection as-is",
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
        setPickError(emptyMessage);
        return;
      }
      setPickError(null);
      startUpload(picked, label);
    },
    [startUpload]
  );

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
      stageFileList(fileList, label, "No JPEG/RAW photos found in that folder.");
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
      stageFileList(fileList, label, "None of the selected files are JPEG/RAW photos.");
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
          <strong>Import</strong> copies photos into your library. An <strong>external source</strong>{" "}
          just points to a folder and leaves the files where they are.
        </p>
        <input ref={folderInputRef} type="file" multiple style={{ display: "none" }} />
        <input ref={filesInputRef} type="file" multiple style={{ display: "none" }} />

        <div className="import-panels">
          <div className="import-panel import-panel--menu">
            <h3 className="section-title">Import into library</h3>
            <p className="import-panel-desc">
              Copy photos from an SD card, camera, or folder into your library.
            </p>
            <div className="import-menu" ref={importMenuRef}>
              <button
                className="btn primary"
                onClick={() => setImportMenuOpen((v) => !v)}
                disabled={isUploading}
                aria-haspopup="menu"
                aria-expanded={importMenuOpen}
              >
                {!isUploading
                  ? <>Import photos <IconChevronDown size={12} /></>
                  : folderImportActive
                    ? totalFileCount
                      ? `Importing... ${effectiveUploadPct ?? 0}% · ${(liveStagedCount ?? 0).toLocaleString()} / ${totalFileCount.toLocaleString()} photos${uploadEtaSuffix}`
                      : "Scanning folder…"
                    : (uploadProgress ?? 0) >= 100
                      ? `Processing files...${progressSuffix}`
                      : `Importing... ${uploadProgress ?? 0}%${uploadEtaSuffix}`}
              </button>
              {/* Bail out of a long SD-card upload without waiting for it to
                  finish - aborts the in-flight request and clears the screen.
                  Hidden once the server is past receiving bytes ("Processing"),
                  since at that point the batch is already staging server-side. */}
              {isUploading && (uploadProgress ?? 0) < 100 && (
                <button className="btn" style={{ marginLeft: 8 }} onClick={cancelUpload}>
                  Cancel
                </button>
              )}
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
                        if (folder) {
                          setPickError(null);
                          startFolderImport(folder);
                        }
                        return;
                      }
                      folderInputRef.current?.click();
                    }}
                  >
                    Choose folder…
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
                          startFilesImport(picked, label);
                        }
                        return;
                      }
                      filesInputRef.current?.click();
                    }}
                  >
                    Choose files…
                  </button>
                </div>
              )}
            </div>
            {isUploading && (
              <p className="import-panel-desc" style={{ color: "var(--text-muted)" }}>
                {folderImportActive
                  ? totalFileCount
                    ? "Photos are being copied — the counter ticks up as each one lands, and they're analyzed (duplicates, previews, metadata) in the background. Nothing is added to your library until you review."
                    : "Looking for photos in the selected folder…"
                  : "Photos are being received — the review screen opens as soon as they're copied, while analysis continues in the background."}
              </p>
            )}
            {pickError && <p className="status-note status-note--error">{pickError}</p>}
            {uploadError && (
              <p className="import-panel-desc" style={{ color: "var(--danger)" }}>Upload failed: {uploadError}</p>
            )}
          </div>

          <ExternalSources />
        </div>
      </div>
    );
  }

  return (
    <div className="page page-timeline">
      <div className="import-review-head">
        <ImportSteps current={2} />
        <h2 className="section-title">Review &amp; choose what to keep</h2>
        <p className="import-review-sub">
          From <strong>{sourceLabel}</strong> — these photos are staged, nothing is in your
          library yet. Rate, compare and select, then press "Add to library".
        </p>
        {/* Background copying still running: photos keep appearing, and the
            commit button below stays disabled until this finishes. */}
        {stagingInBackground && (
          <p className="import-staging-banner" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" /> Still copying photos in the background…{" "}
            {liveStagedCount != null && totalFileCount != null
              ? `${liveStagedCount.toLocaleString()} / ${totalFileCount.toLocaleString()}${
                  copyEta != null ? ` · ~${formatEta(copyEta)} left` : ""
                }`
              : ""}{" "}
            — you can start reviewing now.
          </p>
        )}
        {/* Copying done, background analysis (thumbnails/EXIF/duplicates)
            still catching up: placeholders fill in as it runs. */}
        {analyzingInBackground && (
          <p className="import-staging-banner" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" /> Analyzing photos in the background…{" "}
            {analysisTotal > 0
              ? `${analysisProcessed.toLocaleString()} / ${analysisTotal.toLocaleString()}`
              : ""}{" "}
            — you can review now; importing unlocks when the analysis finishes.
          </p>
        )}
        {stagingError && !stagingInBackground && (
          <p className="import-staging-banner import-staging-banner--error" role="alert">
            Some photos couldn't be loaded ({stagingError}). You can still import the ones that made
            it in below.
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
        viewExtras={
          <label className="filter-field filter-field-inline">
            <input type="checkbox" checked={hideDuplicates} onChange={(e) => setHideDuplicates(e.target.checked)} />{" "}
            Hide duplicates
          </label>
        }
      >
        <button
          className={`btn${selectMode ? " primary" : ""}`}
          onClick={() => setSelectMode((v) => !v)}
        >
          {selectMode ? "Done selecting" : "Select"}
        </button>
        {selectMode && (
          <>
            {/* "Select all" is scoped to the filtered view (it acts on
                visibleFiles), so with a filter active it selects exactly the
                filtered photos - same as the library. No separate "only
                filtered" button needed. */}
            <button className="btn" onClick={() => selectAll(true)}>
              Select all
            </button>
            <button className="btn" onClick={() => selectAll(false)}>
              Clear selection
            </button>
          </>
        )}
      </PhotoFilters>
      <div className="page-scroll">
      <div className="filter-bar action-bar--bottom" ref={actionBarRef}>
        <span>{selectedCount} of {files?.length ?? 0} selected for import</span>
        {/* Only shown when Immich is configured in Settings - an inert greyed
            checkbox is just clutter for everyone who doesn't use Immich. In
            selective/full sync modes the per-import checkbox is replaced by a
            status chip, since uploads are driven by the sync mode instead. */}
        {immichConfigured && immichMode === "manual" && (
          <label
            className="filter-field filter-field-inline"
            title="Upload the selected JPEGs to Immich after import (RAW files are never uploaded)"
          >
            <input
              type="checkbox"
              checked={uploadToImmich}
              onChange={(e) => setUploadToImmich(e.target.checked)}
            />{" "}
            Add to Immich (JPG only)
          </label>
        )}
        {immichConfigured && immichMode === "selective" && (
          <label
            className="filter-field filter-field-inline"
            title="Flag every imported photo for Immich sync (JPG only — RAW files are never uploaded). Individual photos can be flagged in the preview instead."
          >
            <input
              type="checkbox"
              checked={syncAllToImmich}
              onChange={(e) => setSyncAllToImmich(e.target.checked)}
            />{" "}
            Sync to Immich (JPG only)
          </label>
        )}
        {immichConfigured && immichMode === "full" && (
          <span
            className="filter-field filter-field-inline"
            style={{ color: "var(--text-muted)" }}
            title="Change this under Settings → Immich integration → Sync mode"
          >
            🔄 Immich full sync is on — every imported JPEG uploads automatically.
          </span>
        )}
        <button
          className="btn primary"
          onClick={handleCommitClick}
          disabled={selectedCount === 0 || commit.isPending || stagingInBackground || analysisPending}
          title={
            stagingInBackground
              ? "Wait until all photos have finished copying before importing"
              : analysisPending
                ? "Wait until all photos have been analyzed (duplicates, metadata) before importing"
                : "Copies the selected photos into your library"
          }
        >
          {commit.isPending ? (
            <>
              <span className="btn-spinner" aria-hidden="true" />
              {`Adding to library...${progressSuffix}`}
            </>
          ) : stagingInBackground ? (
            "Copying photos…"
          ) : analysisPending ? (
            `Analyzing… ${analysisProcessed}/${analysisTotal}`
          ) : (
            `Add ${selectedCount} photo(s) to library`
          )}
        </button>
        <button
          className="btn"
          onClick={async () => {
            // Throwing away a whole reviewed batch (ratings, selection work)
            // deserves a confirmation - and the dialog doubles as the place to
            // reassure that the original files are untouched.
            if (
              await dialogs.confirm({
                title: "Discard this import batch?",
                message:
                  "Nothing has been added to your library, and the original files stay where they are.",
                confirmLabel: "Discard batch",
                danger: true,
              })
            ) {
              discard.mutate();
            }
          }}
          disabled={discard.isPending}
        >
          {discard.isPending ? (
            <>
              <span className="btn-spinner" aria-hidden="true" />
              Discarding…
            </>
          ) : (
            "Discard batch"
          )}
        </button>
      </div>

      {selectMode && (
        <p style={{ color: "var(--text-muted)", marginTop: -8, marginBottom: 16 }}>
          Click photos to select them for import - shift-click to select a range. Or open a photo
          and press Space to toggle it, 0-5 to rate.
        </p>
      )}

      {isLoading ? (
        <div className="empty-state">Processing uploaded files...</div>
      ) : (
        /* Day-sectioned with the library's date scrubber on the right edge -
           reviewing a big card scrolls and navigates like the library, at the
           day granularity an import batch actually has. */
        <div className="timeline has-scrubber" ref={gridRootRef}>
          {daySections.map((section) => (
            <section
              key={section.label ?? "dateless-tail"}
              className="timeline-section"
              ref={(el) => {
                const label = section.label;
                if (!label) return; // headerless tail - no scrubber anchor
                if (el) sectionEls.current.set(label, el);
                else sectionEls.current.delete(label);
              }}
            >
              {section.label && (
                <h3 className="timeline-header">
                  {section.label}
                  <span className="timeline-header-count">{section.items.length}</span>
                </h3>
              )}
              <div className={`thumbnail-grid${visibleFiles.length <= 2 ? " thumbnail-grid--few" : ""}`}>
                {section.items.map(({ file: f, index: i }) => (
                  <div
                    key={f.id}
                    data-staged-id={f.id}
                    style={tileStyle(f.width, f.height)}
                    className={`import-card${f.selected ? " selected" : ""}`}
                  >
                    <div
                      className={`thumb-card${f.selected ? " selected" : ""}`}
                      // The pointer landing on a card is the earliest signal
                      // that this is the photo about to be opened - warming
                      // here buys the preview the moment before the click.
                      onPointerEnter={() => preloadImage(api.import.stagedPreviewUrl(sessionId, f.id))}
                      onClick={(e) => (selectMode ? toggleStagedSelect(i, e.shiftKey) : setLightboxIndex(i))}
                      title={
                        selectMode
                          ? isDuplicate(f)
                            ? "Already in your library - can't be imported"
                            : f.duplicate_in_trash
                              ? "This photo is in the Trash - importing it restores it"
                              : "Click to select, shift-click for a range"
                          : "Click to preview"
                      }
                    >
                      {f.processed ? (
                        <Thumb src={api.import.stagedThumbnailUrl(sessionId, f.id)} alt={f.original_filename} />
                      ) : (
                        // Copied but not yet analyzed - no thumbnail exists yet. The
                        // 1s files refetch swaps this for the real Thumb when the
                        // background analysis finishes this file. Shimmers like the
                        // album skeleton cards instead of showing a spinner.
                        <div className="thumb-analyzing" title="Analyzing…" />
                      )}
                      {selectMode && (
                        <input
                          className="select-checkbox"
                          type="checkbox"
                          checked={f.selected}
                          disabled={isDuplicate(f)}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleStagedSelect(i, e.shiftKey);
                          }}
                          onChange={() => {}}
                        />
                      )}
                      {(f.duplicate_of_image_id || f.duplicate_of_staged_file_id) && (
                        <span className="duplicate-badge">
                          {f.duplicate_in_trash ? "In Trash - restores" : "Already in library"}
                        </span>
                      )}
                      <span
                        className={fileTypeBadgeClass(
                          f.file_type,
                          mergePairs && viewMode === "combined" && Boolean(f.paired_staged_file_id)
                        )}
                      >
                        {fileTypeBadge(
                          f.file_type,
                          // "RAW+JPG" only when this card is a merged stand-in for the
                          // pair; unmerged/filtered views show each file's own type.
                          mergePairs && viewMode === "combined" && Boolean(f.paired_staged_file_id)
                        )}
                      </span>
                    </div>
                    {/* No per-card import checkbox here: it's cramped at grid sizes and
                        crowds the stars. Toggle import via "Select" mode (overlay
                        checkbox / click) or in the large preview (Space key). The
                        footer keeps just rating + color, which have room now. */}
                    <div className="import-card-footer">
                      <RatingStars
                        rating={f.rating}
                        onChange={(rating) => updateStaged.mutate({ fileId: f.id, patch: { rating } })}
                      />
                      <ColorLabelPicker
                        value={f.color_label}
                        onChange={(color_label) => updateStaged.mutate({ fileId: f.id, patch: { color_label } })}
                      />
                    </div>
                  </div>
                ))}
                <i className="grid-filler" aria-hidden />
              </div>
            </section>
          ))}

          <TimelineScrubber
            getScroller={() =>
              (gridRootRef.current?.closest(".page-scroll") ??
                gridRootRef.current?.closest(".page")) as HTMLElement | null
            }
            getSectionEl={(label) => sectionEls.current.get(label) ?? null}
            sections={daySections.flatMap((s) =>
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
            )}
            getBottomInset={() => actionBarRef.current?.offsetHeight ?? 0}
          />
        </div>
      )}
      </div>

      {lightboxIndex !== null && (
        <ImportLightbox
          sessionId={sessionId}
          files={visibleFiles}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onUpdate={(fileId, patch) => updateStaged.mutate({ fileId, patch })}
          showImmichSync={immichConfigured && immichMode === "selective"}
          pairsMerged={mergePairs && viewMode === "combined"}
        />
      )}
    </div>
  );
}

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
import { collapsePairsBy, groupPairsAdjacent } from "../utils/pairing";
import { pickImportableFiles, sourceLabelFor } from "../utils/folderPick";
import { useImportSession } from "../state/importSession";
import { useTasks } from "../state/tasks";
import { useMergePairs } from "../state/viewPrefs";

// Human-readable "time remaining" for the import ETA (e.g. "45s", "2m 10s").
function formatEta(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

// Byte-identical to a photo already in the library or elsewhere in this same
// batch - the backend refuses to import these, so the UI shouldn't let you
// select them in the first place. Exception: a copy of a photo sitting in the
// Trash may be imported (it restores that photo), so it stays selectable.
function isExactDuplicate(f: StagedFileOut): boolean {
  return (
    Boolean(f.duplicate_of_image_id || f.duplicate_of_staged_file_id) &&
    !f.is_near_duplicate &&
    !f.duplicate_in_trash
  );
}

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
  const [pickError, setPickError] = useState<string | null>(null);
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: immich } = useQuery({
    queryKey: ["immich-settings"],
    queryFn: () => api.settings.getImmich(),
  });
  const immichConfigured = Boolean(immich?.base_url && immich?.api_key_set);
  const immichMode = immich?.sync_mode ?? "manual";

  const mergePairs = useMergePairs();

  const { data: files, isLoading } = useQuery({
    queryKey: ["import-files", sessionId],
    queryFn: () => api.import.files(sessionId!),
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
    refetchInterval: (query) =>
      stagingInBackground || analysisPending || (query.state.data ?? []).some((f) => !f.processed)
        ? 1000
        : false,
  });

  const filesById = useMemo(() => new Map((files ?? []).map((f) => [f.id, f])), [files]);

  const updateStaged = useMutation({
    mutationFn: async ({
      fileId,
      patch,
    }: {
      fileId: string;
      patch: { selected?: boolean; rating?: number; color_label?: ColorLabel; immich_sync?: boolean };
    }) => {
      await api.import.updateStagedFile(sessionId!, fileId, patch);
      // Merged view shows only the JPEG of a pair, so mirror the change onto the
      // hidden RAW partner - selecting/rating the one card affects both files.
      if (mergePairs) {
        const partnerId = filesById.get(fileId)?.paired_staged_file_id;
        if (partnerId) await api.import.updateStagedFile(sessionId!, partnerId, patch);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["import-files", sessionId] }),
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
      window.alert(
        `Import failed: ${message}\n\nYour photos are still in the staging area - nothing was lost. Please try again.`
      );
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

  const discard = useMutation({
    mutationFn: () => api.import.discard(sessionId!),
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
  // In combined view, either merge each pair into one JPEG card (mergePairs) or
  // keep the two halves adjacent. Other view modes show a flat list.
  const visibleFiles =
    viewMode === "combined"
      ? mergePairs
        ? collapsePairsBy(filteredFiles, (f) => f.file_type, (f) => f.paired_staged_file_id)
        : groupPairsAdjacent(filteredFiles, (f) => f.file_type, (f) => f.paired_staged_file_id)
      : filteredFiles;
  const selectedCount = (files ?? []).filter((f) => f.selected).length;

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
    if (!target || isExactDuplicate(target)) return;
    if (shiftKey && lastIndex !== null) {
      const [start, end] = lastIndex < index ? [lastIndex, index] : [index, lastIndex];
      const range = withPartners(visibleFiles.slice(start, end + 1)).filter((f) => !isExactDuplicate(f));
      await api.import.bulkUpdateStagedFiles(sessionId!, range.map((f) => f.id), { selected: true });
      queryClient.invalidateQueries({ queryKey: ["import-files", sessionId] });
    } else {
      updateStaged.mutate({ fileId: target.id, patch: { selected: !target.selected } });
    }
    setLastIndex(index);
  }

  async function selectAll(selected: boolean) {
    const ids = withPartners(visibleFiles)
      .filter((f) => !selected || !isExactDuplicate(f))
      .map((f) => f.id);
    await api.import.bulkUpdateStagedFiles(sessionId!, ids, { selected });
    queryClient.invalidateQueries({ queryKey: ["import-files", sessionId] });
  }

  async function applyFilterToSelection() {
    const visibleIds = new Set(withPartners(visibleFiles).map((f) => f.id));
    const targets = (files ?? []).filter((f) => !(visibleIds.has(f.id) && isExactDuplicate(f)));
    const selectIds = targets.filter((f) => visibleIds.has(f.id)).map((f) => f.id);
    const deselectIds = targets.filter((f) => !visibleIds.has(f.id)).map((f) => f.id);
    if (selectIds.length) await api.import.bulkUpdateStagedFiles(sessionId!, selectIds, { selected: true });
    if (deselectIds.length) await api.import.bulkUpdateStagedFiles(sessionId!, deselectIds, { selected: false });
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
    const missingHalf = findIncompletePairs(files ?? []).filter((f) => !isExactDuplicate(f));
    if (missingHalf.length > 0) {
      const includeBoth = window.confirm(
        `${missingHalf.length} shot(s) have only the RAW or only the JPEG selected. ` +
          `Include the missing file for these shots too?\n\n` +
          `OK = include both, Cancel = keep your current selection as-is.`
      );
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
                  ? "Import photos ▾"
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
                    onClick={() => {
                      setImportMenuOpen(false);
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
            {pickError && <p className="import-panel-desc" style={{ color: "var(--danger)" }}>{pickError}</p>}
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
    <div className="page">
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
              ? `${liveStagedCount.toLocaleString()} / ${totalFileCount.toLocaleString()}`
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
            <button className="btn" onClick={applyFilterToSelection}>
              Select only filtered
            </button>
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
      <div className="filter-bar action-bar--bottom">
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
          {commit.isPending
            ? `Adding to library...${progressSuffix}`
            : stagingInBackground
              ? "Copying photos…"
              : analysisPending
                ? `Analyzing… ${analysisProcessed}/${analysisTotal}`
                : `Add ${selectedCount} photo(s) to library`}
        </button>
        <button
          className="btn"
          onClick={() => {
            // Throwing away a whole reviewed batch (ratings, selection work)
            // deserves a confirmation - and the dialog doubles as the place to
            // reassure that the original files are untouched.
            if (
              window.confirm(
                "Discard this import batch? Nothing has been added to your library, and the original files stay where they are."
              )
            ) {
              discard.mutate();
            }
          }}
          disabled={discard.isPending}
        >
          Discard batch
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
        <div className={`thumbnail-grid${visibleFiles.length <= 2 ? " thumbnail-grid--few" : ""}`}>
          {visibleFiles.map((f, i) => (
            <div
              key={f.id}
              style={tileStyle(f.width, f.height)}
              className={`import-card${f.selected ? " selected" : ""}`}
            >
              <div
                className={`thumb-card${f.selected ? " selected" : ""}`}
                onClick={(e) => (selectMode ? toggleStagedSelect(i, e.shiftKey) : setLightboxIndex(i))}
                title={
                  selectMode
                    ? isExactDuplicate(f)
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
                  // background analysis finishes this file.
                  <div className="thumb-analyzing" title="Analyzing…">
                    <span className="spinner" aria-hidden="true" />
                  </div>
                )}
                {selectMode && (
                  <input
                    className="select-checkbox"
                    type="checkbox"
                    checked={f.selected}
                    disabled={isExactDuplicate(f)}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleStagedSelect(i, e.shiftKey);
                    }}
                    onChange={() => {}}
                  />
                )}
                {(f.duplicate_of_image_id || f.duplicate_of_staged_file_id) && (
                  <span className="duplicate-badge">
                    {f.is_near_duplicate
                      ? "Possible duplicate"
                      : f.duplicate_in_trash
                        ? "In Trash - restores"
                        : "Already in library"}
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

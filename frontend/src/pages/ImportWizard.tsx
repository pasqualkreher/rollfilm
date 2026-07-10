import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ColorLabel, StagedFileOut, ViewMode } from "../api/types";
import { RatingStars } from "../components/RatingStars";
import { ColorLabelPicker } from "../components/ColorLabelPicker";
import { PhotoFilters } from "../components/PhotoFilters";
import { ImportLightbox } from "../components/ImportLightbox";
import { fileTypeBadge } from "../components/ThumbnailGrid";
import { collapsePairsBy, groupPairsAdjacent } from "../utils/pairing";
import { pickImportableFiles, sourceLabelFor } from "../utils/folderPick";
import { useImportSession } from "../state/importSession";
import { useTasks } from "../state/tasks";
import { useMergePairs } from "../state/viewPrefs";

// Byte-identical to a photo already in the library or elsewhere in this same
// batch - the backend refuses to import these, so the UI shouldn't let you
// select them in the first place.
function isExactDuplicate(f: StagedFileOut): boolean {
  return Boolean(f.duplicate_of_image_id || f.duplicate_of_staged_file_id) && !f.is_near_duplicate;
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

export function ImportWizard() {
  const { sessionId, sourceLabel, uploadProgress, uploadError, isUploading, startUpload, reset } =
    useImportSession();
  const [hideDuplicates, setHideDuplicates] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("combined");
  const [ratingMin, setRatingMin] = useState(0);
  const [colorFilter, setColorFilter] = useState<ColorLabel>("none");
  const [pickError, setPickError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [uploadToImmich, setUploadToImmich] = useState(false);
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

  const mergePairs = useMergePairs();

  const { data: files, isLoading } = useQuery({
    queryKey: ["import-files", sessionId],
    queryFn: () => api.import.files(sessionId!),
    enabled: !!sessionId,
  });

  const filesById = useMemo(() => new Map((files ?? []).map((f) => [f.id, f])), [files]);

  const updateStaged = useMutation({
    mutationFn: async ({
      fileId,
      patch,
    }: {
      fileId: string;
      patch: { selected?: boolean; rating?: number; color_label?: ColorLabel };
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
    mutationFn: () => api.import.commit(sessionId!, uploadToImmich && immichConfigured),
    onSuccess: () => {
      // The freshly-imported photos won't appear on the Library until its
      // ["images"] query refetches - invalidate so they show up immediately
      // instead of only after a manual page refresh.
      queryClient.invalidateQueries({ queryKey: ["images"] });
      // Without this, the session tracked in context (see state/importSession)
      // stays set after a successful commit, so revisiting /import re-opens
      // this same now-committed session - and Discard then 400s because it's
      // no longer in "staging" status, leaving no way back to a fresh import.
      reset();
      navigate("/");
    },
  });

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
    setBusyLabel(commit.isPending ? "Importing photos…" : null);
  }, [commit.isPending, setBusyLabel]);
  useEffect(() => () => setBusyLabel(null), [setBusyLabel]);

  const filteredFiles: StagedFileOut[] = (files ?? []).filter((f) => {
    if (hideDuplicates && (f.duplicate_of_image_id || f.duplicate_of_staged_file_id)) return false;
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
        : groupPairsAdjacent(filteredFiles, (f) => f.paired_staged_file_id)
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
      await Promise.all(range.map((f) => api.import.updateStagedFile(sessionId!, f.id, { selected: true })));
      queryClient.invalidateQueries({ queryKey: ["import-files", sessionId] });
    } else {
      updateStaged.mutate({ fileId: target.id, patch: { selected: !target.selected } });
    }
    setLastIndex(index);
  }

  async function selectAll(selected: boolean) {
    await Promise.all(
      withPartners(visibleFiles)
        .filter((f) => !selected || !isExactDuplicate(f))
        .map((f) => api.import.updateStagedFile(sessionId!, f.id, { selected }))
    );
    queryClient.invalidateQueries({ queryKey: ["import-files", sessionId] });
  }

  async function applyFilterToSelection() {
    const visibleIds = new Set(withPartners(visibleFiles).map((f) => f.id));
    await Promise.all(
      (files ?? [])
        .filter((f) => !(visibleIds.has(f.id) && isExactDuplicate(f)))
        .map((f) => api.import.updateStagedFile(sessionId!, f.id, { selected: visibleIds.has(f.id) }))
    );
    queryClient.invalidateQueries({ queryKey: ["import-files", sessionId] });
  }

  async function handleCommitClick() {
    const missingHalf = findIncompletePairs(files ?? []);
    if (missingHalf.length > 0) {
      const includeBoth = window.confirm(
        `${missingHalf.length} shot(s) have only the RAW or only the JPEG selected. ` +
          `Include the missing file for these shots too?\n\n` +
          `OK = include both, Cancel = keep your current selection as-is.`
      );
      if (includeBoth) {
        await Promise.all(
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
        <p style={{ color: "var(--text-muted)", marginTop: -8 }}>
          Import from an SD card, camera, or folder - or pick individual photos.
        </p>
        <input ref={folderInputRef} type="file" multiple style={{ display: "none" }} />
        <input ref={filesInputRef} type="file" multiple style={{ display: "none" }} />
        <div className="import-toolbar">
          <div className="import-menu" ref={importMenuRef}>
            <button
              className="btn primary"
              onClick={() => setImportMenuOpen((v) => !v)}
              disabled={isUploading}
              aria-haspopup="menu"
              aria-expanded={importMenuOpen}
            >
              {isUploading ? `Uploading... ${uploadProgress ?? 0}%` : "Import photos ▾"}
            </button>
            {importMenuOpen && !isUploading && (
              <div className="import-menu-dropdown" role="menu">
                <button
                  className="import-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setImportMenuOpen(false);
                    folderInputRef.current?.click();
                  }}
                >
                  Choose folder to import
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
        </div>
        {pickError && <div className="empty-state">{pickError}</div>}
        {uploadError && <div className="empty-state">Upload failed: {uploadError}</div>}
      </div>
    );
  }

  return (
    <div className="page">
      <h2 className="section-title">Review import ({sourceLabel})</h2>
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
        <label
          className="filter-field filter-field-inline"
          title={
            immichConfigured
              ? "Upload the selected JPEGs to Immich after import (RAW files are never uploaded)"
              : "Add your Immich host and API key in Settings to enable this"
          }
          style={immichConfigured ? undefined : { opacity: 0.5 }}
        >
          <input
            type="checkbox"
            checked={uploadToImmich && immichConfigured}
            disabled={!immichConfigured}
            onChange={(e) => setUploadToImmich(e.target.checked)}
          />{" "}
          Also upload to Immich (JPG only)
        </label>
        <button className="btn primary" onClick={handleCommitClick} disabled={selectedCount === 0 || commit.isPending}>
          {commit.isPending ? "Importing..." : `Import ${selectedCount} photo(s)`}
        </button>
        <button className="btn" onClick={() => discard.mutate()} disabled={discard.isPending}>
          Discard
        </button>
      </div>

      {selectMode && (
        <p style={{ color: "var(--text-muted)", marginTop: -8, marginBottom: 16 }}>
          Click photos to select them for import - shift-click to select a range. The checkbox on
          each card works anytime.
        </p>
      )}

      {isLoading ? (
        <div className="empty-state">Processing uploaded files...</div>
      ) : (
        <div className="thumbnail-grid">
          {visibleFiles.map((f, i) => (
            <div key={f.id} className={`import-card${f.selected ? " selected" : ""}`}>
              <div
                className={`thumb-card${f.selected ? " selected" : ""}`}
                onClick={(e) => (selectMode ? toggleStagedSelect(i, e.shiftKey) : setLightboxIndex(i))}
                title={
                  selectMode
                    ? isExactDuplicate(f)
                      ? "Already in your library - can't be imported"
                      : "Click to select, shift-click for a range"
                    : "Click to preview"
                }
              >
                <img src={api.import.stagedThumbnailUrl(sessionId, f.id)} alt={f.original_filename} />
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
                    {f.is_near_duplicate ? "Possible duplicate" : "Already in library"}
                  </span>
                )}
                <span className="badge">{fileTypeBadge(f.file_type, Boolean(f.paired_staged_file_id))}</span>
                <button
                  className="card-expand"
                  title="Preview"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLightboxIndex(i);
                  }}
                >
                  ⤢
                </button>
              </div>
              <div className="import-card-footer">
                <input
                  type="checkbox"
                  checked={f.selected}
                  disabled={isExactDuplicate(f)}
                  title={isExactDuplicate(f) ? "Already in your library - can't be imported again" : undefined}
                  onChange={(e) => updateStaged.mutate({ fileId: f.id, patch: { selected: e.target.checked } })}
                />
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
        />
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { ColorLabel, StagedFileOut } from "../api/types";
import { RatingStars } from "./RatingStars";
import { ColorLabelPicker } from "./ColorLabelPicker";
import { fileTypeBadge, fileTypeBadgeClass } from "./ThumbnailGrid";
import { flaggedDuplicate } from "./ImportReviewGrid";
import { LIGHTBOX_NEIGHBOR_DEPTH, PinnedImageWindow } from "../utils/preload";
import { IconChevronLeft, IconChevronRight, IconImage, IconImport, IconRotate } from "./Icons";
import { ExifTable } from "./ExifTable";
import { useImageZoomPan } from "../utils/useImageZoomPan";
import { useFullResUpgrade } from "../utils/useFullResUpgrade";
import { ZoomReadout } from "./ZoomReadout";
import { StageBackgroundToggle } from "./StageBackgroundToggle";
import { setImportInfoPanelOpen, useImportInfoPanelOpen, useStageBg } from "../state/viewPrefs";
import { Spinner } from "./Spinner";

interface Props {
  sessionId: string;
  files: StagedFileOut[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onUpdate: (
    fileId: string,
    patch: { selected?: boolean; rating?: number; color_label?: ColorLabel; immich_sync?: boolean }
  ) => void;
  // Selective Immich sync is active - show the per-photo "Sync to Immich" checkbox.
  showImmichSync?: boolean;
  // The files list collapses RAW+JPEG pairs into one stand-in card - label that
  // card "RAW+JPG" instead of its own file type.
  pairsMerged?: boolean;
  // Set by <Presence> while the lightbox fades out: keys are ignored, so an
  // arrow pressed during the fade cannot reopen it on the neighbour.
  closing?: boolean;
}

export function ImportLightbox({
  sessionId,
  files,
  index,
  onIndexChange,
  onClose,
  onUpdate,
  showImmichSync = false,
  pairsMerged = false,
  closing = false,
}: Props) {
  const file = files[index];
  // The preview failed to load (damaged/unreadable file). Show a clean error
  // state instead of the browser's broken-image icon; rating, the import
  // toggle and arrow-key navigation keep working.
  const [loadFailed, setLoadFailed] = useState(false);
  // Whether the <img> currently on the stage has decoded. Until it has, the
  // stage shows a "Developing…" hint instead of nothing: a staged RAW whose
  // preview the import's render pass hasn't reached yet is rendered on this
  // very request, which is seconds - an empty stage read as "the photo doesn't
  // show". Reset with the photo and with the preview/full swap.
  const [photoLoaded, setPhotoLoaded] = useState(false);
  // Bumped to re-mount the <img> for a retry - a fresh request rather than the
  // browser's cached failure. The server answers 503 while every render slot
  // is busy (and the browser reports that as an error), so a failed preview is
  // asked for again a few times before it counts as unreadable.
  const [retryNonce, setRetryNonce] = useState(0);
  const retriesRef = useRef(0);
  const retryTimerRef = useRef<number | undefined>(undefined);
  const PREVIEW_RETRIES = 6;
  const PREVIEW_RETRY_MS = 2000;
  // Swap the review preview for the full-resolution render once the user zooms
  // in, so 100% shows the photo's own pixels (which is what judging critical
  // focus needs) instead of an upscaled 2048px preview. If that render can't be
  // fetched we stay on the preview - never a broken image.
  const [hiRes, setHiRes] = useState(false);
  const [fullFailed, setFullFailed] = useState(false);
  // Light / mid grey / black surround - the same shared preference (and the
  // same control) as the library photo view and the editor.
  const bgMode = useStageBg();
  // The camera-settings panel right of the photo (P, or the Info button).
  // Closed until opened, then remembered like the library's side panel.
  const infoOpen = useImportInfoPanelOpen();
  // Scroll/pinch zoom, drag pan, fit sizing - the same hook the library photo
  // view uses, so culling an import inspects photos exactly like browsing the
  // library does. The editor is deliberately NOT here: import review rates and
  // selects, it doesn't develop. Handed the staged file's real pixel size, so
  // 100% means the photo's pixels, not the review preview's.
  const zoom = useImageZoomPan(
    file?.width && file?.height ? { w: file.width, h: file.height } : null
  );
  useEffect(() => {
    setLoadFailed(false);
    setHiRes(false);
    setFullFailed(false);
    setPhotoLoaded(false);
    retriesRef.current = 0;
    window.clearTimeout(retryTimerRef.current);
    // A new photo always opens at fit - carrying a 400% view over to the next
    // frame would show a random corner of it.
    zoom.resetZoom();
    zoom.clearFit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  // Once zoomed in, upgrade to the full-resolution render (fetched lazily)
  // unless it already failed for this photo. Latches: zooming back out keeps
  // the pixels we already paid for rather than flipping back to the preview.
  useEffect(() => {
    if (zoom.zoomed && !fullFailed) setHiRes(true);
  }, [zoom.zoomed, fullFailed]);
  // A staged RAW's full render is seconds away and the server sheds load (503
  // while its single render slot stays busy, 409 once a newer zoom claimed
  // it): fetched off-screen with retries while the preview stays up, then
  // swapped in decoded - the same loader as the library lightbox. A JPEG's
  // full size is the file itself and goes straight onto the <img>.
  const isRaw = file?.file_type === "raw";
  const full = useFullResUpgrade(
    hiRes && isRaw && file ? api.import.stagedFullUrl(sessionId, file.id) : null
  );
  useEffect(() => () => window.clearTimeout(retryTimerRef.current), []);

  useEffect(() => {
    if (!file) return;
    const duplicate = flaggedDuplicate(file);
    function onKeyDown(e: KeyboardEvent) {
      if (closing) return;
      // Don't hijack keys while a text/choice control (checkbox, select,
      // text field) has focus - let it handle its own Space/Enter natively.
      // BUTTONS are deliberately NOT exempt: after clicking the ‹/› arrows
      // the clicked button kept focus, and the browser's native "Space
      // activates the focused button" then navigated AGAIN instead of
      // toggling the photo's selection.
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inControl = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";

      // Esc drops back to fit if zoomed in, and only closes from there - one
      // press must not do both (same as the library photo view).
      if (e.key === "Escape") {
        if (zoom.zoomed) zoom.resetZoom(true);
        else onClose();
      } else if (e.key === "ArrowLeft") onIndexChange(Math.max(0, index - 1));
      else if (e.key === "ArrowRight") onIndexChange(Math.min(files.length - 1, index + 1));
      else if (!inControl && e.key >= "0" && e.key <= "5") {
        // Number keys set the star rating (0 clears it).
        onUpdate(file!.id, { rating: Number(e.key) });
      } else if (!inControl && (e.key === " " || e.code === "Space")) {
        // Space toggles whether this file is imported (skipped for files that
        // are already in the library and can't be re-imported).
        e.preventDefault();
        if (!duplicate) onUpdate(file!.id, { selected: !file!.selected });
      } else if (!inControl && (e.key === "a" || e.key === "A") && !e.metaKey && !e.ctrlKey) {
        // A picks: the photo is imported (the culling key, as in the library).
        if (!duplicate) onUpdate(file!.id, { selected: true });
      } else if (!inControl && (e.key === "x" || e.key === "X") && !e.metaKey && !e.ctrlKey) {
        // X rejects: left out of the import.
        if (!duplicate) onUpdate(file!.id, { selected: false });
      } else if (!inControl && ["p", "i"].includes(e.key.toLowerCase()) && !e.metaKey && !e.ctrlKey) {
        // P (or I), as in the library photo view: the camera settings.
        setImportInfoPanelOpen(!infoOpen);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, files.length, onIndexChange, onClose, onUpdate, file, zoom.zoomed, closing, infoOpen]);

  // Hold the 10 previous and 10 next staged previews pinned in memory while
  // this one is on screen (same sliding window as the library lightbox) -
  // zapping through a fresh import with the arrow keys swaps instantly in
  // both directions, and whatever falls out of the window is released. Also
  // triggers the server's lazy preview generation for RAW files ahead of the
  // user, hiding that first-request cost. Ordered nearest-first so the
  // immediate neighbors are warm before the far ones.
  const pinnedNeighbors = useRef(new PinnedImageWindow());
  useEffect(() => {
    const pins = pinnedNeighbors.current;
    return () => pins.clear();
  }, []);
  useEffect(() => {
    // The photo on screen goes first: its request must not share the
    // browser's few connections with a dozen low-priority neighbours while
    // the user is looking at an empty stage.
    if (!photoLoaded) return;
    const order: string[] = [];
    // Bounded window: each pinned preview holds ~11MB decoded, and an
    // unbounded one fed system-wide swapping during imports. The depth scales
    // with device RAM (±2 on 4GB machines, ±6 otherwise) - enough that a held
    // arrow key doesn't outrun it.
    for (let d = 1; d <= LIGHTBOX_NEIGHBOR_DEPTH; d++) {
      const ahead = files[index + d];
      const behind = files[index - d];
      if (ahead) order.push(ahead.id);
      if (behind) order.push(behind.id);
    }
    pinnedNeighbors.current.update(order, (id) => api.import.stagedPreviewUrl(sessionId, id));
  }, [files, index, sessionId, photoLoaded]);

  if (!file) return null;

  const isDuplicate = flaggedDuplicate(file);

  return (
    // Styled like the library's photo view (opaque app surface, the same
    // elevated image box, the same control row under it with the background
    // toggle and the zoom). Instead of the library's side panel there is an
    // optional camera-settings panel in the same rail; the review controls
    // (stars, colours, Import) sit in that one row, left of the zoom.
    <div className={`lightbox-overlay lightbox-overlay--page${closing ? " pm-closing" : ""}`} onClick={onClose}>
      <div className="detail-layout lightbox-detail-layout" onClick={(e) => e.stopPropagation()}>
        <div className="detail-main">
          <div
            className={`detail-image lightbox-stage detail-image-${bgMode}`}
            ref={zoom.setBox}
          >
            <button
              className="lightbox-nav-btn lightbox-nav-prev"
              onClick={(e) => {
                e.stopPropagation();
                e.currentTarget.blur(); // Space/Enter must never re-trigger the arrow
                onIndexChange(Math.max(0, index - 1));
              }}
              disabled={index === 0}
              tabIndex={-1}
              title="Previous photo (Left arrow)"
              aria-label="Previous photo"
            >
              <IconChevronLeft size={20} />
            </button>
            {loadFailed ? (
              <div className="detail-photo-error">
                <span className="detail-photo-error-icon" aria-hidden="true"><IconImage size={40} /></span>
                <p>This photo cannot be displayed. The file may be damaged or unreadable.</p>
                <p className="detail-photo-error-name">{file.original_filename}</p>
                <button
                  className="btn"
                  onClick={() => {
                    retriesRef.current = 0;
                    setLoadFailed(false);
                    setRetryNonce((n) => n + 1);
                  }}
                >
                  <IconRotate size={13} /> Retry
                </button>
              </div>
            ) : (
              <img
                key={retryNonce}
                ref={zoom.setImg}
                // The photo the user is looking at always wins the connection
                // pool over the neighbour prefetches and the grid's thumbnails.
                {...({ fetchpriority: "high" } as Record<string, string>)}
                className={`detail-photo${bgMode === "dark" ? " framed" : ""}${
                  zoom.zoomed ? " zoomed" : ""
                }${zoom.zoomAnim ? " zoom-anim" : ""}`}
                style={zoom.imageStyle}
                draggable={false}
                src={
                  hiRes && !isRaw
                    ? api.import.stagedFullUrl(sessionId, file.id)
                    : full.state === "ready" && full.src
                      ? full.src
                      : api.import.stagedPreviewUrl(sessionId, file.id)
                }
                alt={file.original_filename}
                onLoad={() => {
                  zoom.refit();
                  setPhotoLoaded(true);
                }}
                onError={() => {
                  // The full render is unavailable (or was superseded because
                  // the user zapped on): drop back to the preview so the photo
                  // never shows as a broken image. Only a failing PREVIEW is a
                  // real "can't display this file" - and only after the
                  // retries the busy-server case is given (see retryNonce).
                  if (hiRes && !isRaw) {
                    setFullFailed(true);
                    setHiRes(false);
                  } else if (retriesRef.current < PREVIEW_RETRIES) {
                    retriesRef.current++;
                    window.clearTimeout(retryTimerRef.current);
                    retryTimerRef.current = window.setTimeout(
                      () => setRetryNonce((n) => n + 1),
                      PREVIEW_RETRY_MS
                    );
                  } else {
                    setLoadFailed(true);
                  }
                }}
                {...zoom.imageHandlers}
              />
            )}
            {!loadFailed && !photoLoaded && (
              <div
                className="stage-rendering is-bare"
                role="status"
                aria-label={file.file_type === "raw" && !file.processed ? "Analysing" : "Developing preview"}
              >
                <Spinner size="sm" tone="inherit" />
              </div>
            )}
            {!loadFailed && photoLoaded && hiRes && isRaw && full.state === "loading" && (
              <div className="stage-rendering is-quiet" role="status" aria-label="Rendering full resolution">
                <Spinner size="sm" tone="inherit" />
              </div>
            )}
            {!loadFailed && photoLoaded && hiRes && isRaw && full.state === "failed" && (
              <div className="stage-rendering" role="status">
                Full resolution unavailable – showing the preview
              </div>
            )}
            <button
              className="lightbox-nav-btn lightbox-nav-next"
              onClick={(e) => {
                e.stopPropagation();
                e.currentTarget.blur(); // Space/Enter must never re-trigger the arrow
                onIndexChange(Math.min(files.length - 1, index + 1));
              }}
              disabled={index === files.length - 1}
              tabIndex={-1}
              title="Next photo (Right arrow)"
              aria-label="Next photo"
            >
              <IconChevronRight size={20} />
            </button>
          </div>
          {/* The one row under the photo: the card's footer as the grid draws
              it (stars, colours, the Import box) flush left, the stage's
              look-at-it controls (background, zoom) centred, the file, its
              kind, the position and the Info toggle flush right. Selective
              sync swaps the Import box for the sync one, as the grid's bar
              does. No keyboard hints: the keys ride in the tooltips and in
              Help. What gives way on a narrow stage (side panel open, small
              window) is set in CSS (.lightbox-stage-bar): the filename first,
              then the zoom steps. */}
          <div className="filter-bar filter-bar--stage detail-image-toolbar lightbox-stage-bar">
            <div className="import-card-footer import-card-footer--inline lightbox-review-footer">
              <div className="import-card-footer-row">
                <RatingStars rating={file.rating} onChange={(rating) => onUpdate(file.id, { rating })} />
                {showImmichSync && !isDuplicate ? (
                  <label
                    className={`import-check${file.immich_sync ? " on" : ""}`}
                    title="Upload this photo to Immich right after import. RAW files only if enabled in Settings."
                  >
                    <IconRotate />
                    <span className="import-check-text">Sync to Immich</span>
                    <input
                      className="import-checkbox"
                      type="checkbox"
                      checked={file.immich_sync}
                      onChange={(e) => onUpdate(file.id, { immich_sync: e.target.checked })}
                    />
                  </label>
                ) : (
                  <label
                    className={`import-check${isDuplicate ? " disabled" : ""}`}
                    title={isDuplicate ? "Already in your library" : "Import this photo (Space)"}
                  >
                    <IconImport />
                    <span className="import-check-text">{isDuplicate ? "Already in library" : "Import"}</span>
                    <input
                      className="import-checkbox"
                      type="checkbox"
                      checked={file.selected}
                      disabled={isDuplicate}
                      onChange={(e) => onUpdate(file.id, { selected: e.target.checked })}
                      aria-label="Import this photo"
                    />
                  </label>
                )}
              </div>
              <ColorLabelPicker value={file.color_label} onChange={(color_label) => onUpdate(file.id, { color_label })} />
            </div>
            <span className="lightbox-stage-centre">
              <StageBackgroundToggle />
              <ZoomReadout zoom={zoom} />
            </span>
            {/* No Back of its own: Esc, the title bar's Back (the preview is a
                history entry, see ImportWizard) or the Import tab close it. */}
            <span className="stage-end">
              <span className="lightbox-filename" title={file.original_filename}>
                {file.original_filename}
              </span>
              <span
                className={fileTypeBadgeClass(
                  file.file_type,
                  pairsMerged && Boolean(file.paired_staged_file_id),
                  "badge-inline"
                )}
              >
                {fileTypeBadge(file.file_type, pairsMerged && Boolean(file.paired_staged_file_id))}
              </span>
              <span className="lightbox-counter lightbox-counter--index">
                {index + 1} / {files.length}
              </span>
              <button
                className="btn btn-sm detail-panel-toggle"
                onClick={() => setImportInfoPanelOpen(!infoOpen)}
                title={infoOpen ? "Hide the camera settings (P)" : "Show the camera settings (P)"}
                aria-label={infoOpen ? "Hide the camera settings" : "Show the camera settings"}
                aria-expanded={infoOpen}
                aria-controls="import-info-panel"
              >
                <span className="stage-btn-text">Info</span>{" "}
                {infoOpen ? <IconChevronRight size={13} /> : <IconChevronLeft size={13} />}
              </button>
            </span>
          </div>
        </div>
        {/* Same rail as the library's side panel (width, slide, chrome), kept
            mounted so opening it doesn't wait on anything. The settings come
            from the analysis; until it has run the rows read "—". */}
        <div id="import-info-panel" className={`detail-panel${infoOpen ? "" : " detail-panel--collapsed"}`}>
          <div className="detail-section">
            <div className="detail-section-label">Camera settings</div>
            <ExifTable image={file} />
          </div>
        </div>
      </div>
    </div>
  );
}

import type {
  AlbumOut,
  CropBox,
  ImageOut,
  DirListing,
  ImmichSettings,
  ImmichSyncMode,
  ImmichTestResult,
  ImmichPushResult,
  ImmichUploadResult,
  FolderScanOut,
  ImportProgress,
  ImportSessionOut,
  GeoImage,
  LibraryFacets,
  LibraryFilters,
  LibraryIndexImage,
  ScanStatus,
  SearchResultOut,
  SourceRoot,
  StagedFileOut,
  StagedFileUpdatePatch,
  TagUsage,
  TrashSettings,
} from "./types";
import type { ImageEdits } from "../utils/adjustments";

// Thumbnail/preview files are regenerated in place after an edit, so the URL
// needs to change to bust the browser cache - this derives a stable version
// key from the same fields that affect the rendered pixels.
export function editVersion(image: ImageOut): string {
  return [
    image.edit_rotation,
    image.edit_crop_x ?? "",
    image.edit_crop_y ?? "",
    image.edit_crop_width ?? "",
    image.edit_crop_height ?? "",
    image.edit_flip_h ? "fh" : "",
    image.edit_flip_v ? "fv" : "",
    image.edit_straighten,
    image.edit_persp_h,
    image.edit_persp_v,
    image.edit_exposure,
    image.edit_contrast,
    image.edit_highlights,
    image.edit_shadows,
    image.edit_whites,
    image.edit_blacks,
    image.edit_saturation,
    image.edit_temperature,
    image.edit_tint,
    image.edit_color_mix ?? "",
    image.edit_vignette,
    image.edit_distortion,
    image.edit_dehaze,
    image.edit_grain,
    image.edit_grain_size,
    image.edit_denoise,
    image.edit_clarity,
    image.edit_sharpness,
    image.edit_color_tint,
    image.edit_chrome_effect,
    image.edit_chrome_blue,
    image.edit_mist,
  ].join("-");
}

// Version string of a never-edited photo (every edit field at its default).
// The library index sends thumb_version: "" for those (the vast majority) to
// keep the payload small - substitute this constant so the grid's thumbnail
// URLs stay identical to the ones every other view builds via editVersion().
export const DEFAULT_EDIT_VERSION = editVersion({
  edit_rotation: 0,
  edit_crop_x: null,
  edit_crop_y: null,
  edit_crop_width: null,
  edit_crop_height: null,
  edit_flip_h: false,
  edit_flip_v: false,
  edit_straighten: 0,
  edit_persp_h: 0,
  edit_persp_v: 0,
  edit_exposure: 0,
  edit_contrast: 0,
  edit_highlights: 0,
  edit_shadows: 0,
  edit_whites: 0,
  edit_blacks: 0,
  edit_saturation: 0,
  edit_temperature: 0,
  edit_tint: 0,
  edit_color_mix: null,
  edit_vignette: 0,
  edit_distortion: 0,
  edit_dehaze: 0,
  edit_grain: 0,
  edit_grain_size: 0,
  edit_denoise: 0,
  edit_clarity: 0,
  edit_sharpness: 0,
  edit_color_tint: 0,
  edit_chrome_effect: 0,
  edit_chrome_blue: 0,
  edit_mist: 0,
} as ImageOut);

// The editor state uses camelCase; the API's pydantic model is snake_case.
// Multi-word fields MUST be renamed here - pydantic silently ignores unknown
// keys, so a camelCase key wouldn't error, it would just drop the edit (this
// bit us: colorMix/grainSize/colorTint were lost on every save).
function apiEdits(edits: ImageEdits) {
  const { colorMix, grainSize, colorTint, chromeEffect, chromeBlue, flipH, flipV, perspH, perspV, ...rest } =
    edits;
  return {
    ...rest,
    color_mix: colorMix,
    grain_size: grainSize,
    color_tint: colorTint,
    chrome_effect: chromeEffect,
    chrome_blue: chromeBlue,
    flip_h: flipH,
    flip_v: flipV,
    persp_h: perspH,
    persp_v: perspV,
  };
}

// In the Electron app the backend runs on a random localhost port, injected by
// the preload script. Fall back to the build-time env (web/Docker) or the dev default.
const BASE_URL =
  (typeof window !== "undefined" && window.photoManager?.apiBaseUrl) ||
  import.meta.env.VITE_API_BASE_URL ||
  "http://localhost:8000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function assetUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

// A global cache-bust token bumped when derivatives are regenerated app-wide
// (e.g. "Rebuild thumbnails" in Settings). The per-image `?v=` only changes when
// an edit changes, so without this a rebuild at a new resolution would keep
// serving the browser-cached images. Stored in localStorage so it survives
// reloads and is shared across tabs.
const CACHE_BUST_KEY = "pm.thumbCacheBust";

export function bumpThumbnailCacheBust(): void {
  try {
    localStorage.setItem(CACHE_BUST_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

function derivativeUrl(path: string, version?: string): string {
  let cb = "";
  try {
    cb = localStorage.getItem(CACHE_BUST_KEY) ?? "";
  } catch {
    /* ignore */
  }
  const query = [version ? `v=${version}` : "", cb ? `cb=${cb}` : ""].filter(Boolean).join("&");
  return assetUrl(`${path}${query ? `?${query}` : ""}`);
}

// Serialise library/search filters to query params. Array values (e.g. `tags`)
// become repeated params (?tags=a&tags=b) so the backend reads them as a list;
// empty / null / "" entries are dropped.
function filtersToParams(filters: Partial<LibraryFilters>): URLSearchParams {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      value.forEach((v) => {
        if (v !== undefined && v !== null && v !== "") params.append(key, String(v));
      });
    } else {
      params.set(key, String(value));
    }
  });
  return params;
}

// One batch of an import upload. Uses XMLHttpRequest (not fetch) so we get
// real upload progress - an SD card of RAW files can be several GB, and a
// silent multi-minute hang would look broken without it. `sessionId` appends
// to an existing staging session (null creates a new one).
function uploadBatch(
  files: File[],
  sourceLabel: string,
  sessionId: string | null,
  totalBytes: number,
  onLoaded?: (bytes: number) => void,
  signal?: AbortSignal
): Promise<ImportSessionOut> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    const formData = new FormData();
    files.forEach((f) => formData.append("files", f, f.name));
    formData.append("source_label", sourceLabel);
    formData.append("total_bytes", String(totalBytes));
    // Source modification times (epoch seconds), aligned with `files` -
    // multipart doesn't carry them, and they're the capture-date fallback for
    // photos without EXIF (otherwise those sort by import time).
    formData.append("mtimes", JSON.stringify(files.map((f) => f.lastModified / 1000)));
    if (sessionId) formData.append("session_id", sessionId);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE_URL}/import/sessions/upload`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onLoaded) onLoaded(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        // Surface the API's human-readable message (e.g. the disk-full
        // preflight) instead of a raw JSON blob; keep the status on the error
        // so the retry loop can tell client errors from transient ones.
        let detail = xhr.responseText;
        try {
          detail = JSON.parse(xhr.responseText).detail ?? detail;
        } catch {
          /* not JSON - show as-is */
        }
        const err = new Error(detail || `Upload failed (HTTP ${xhr.status})`) as Error & {
          status?: number;
        };
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    // Cancel-in-flight: abort the XHR (stops sending bytes) and reject with an
    // AbortError the caller recognises as a user cancel, not a failure.
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    if (signal) signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(formData);
  });
}

export const api = {
  images: {
    list(filters: LibraryFilters, page?: { limit: number; offset: number }): Promise<ImageOut[]> {
      const params = filtersToParams(filters);
      if (page) {
        params.set("limit", String(page.limit));
        params.set("offset", String(page.offset));
      }
      return request(`/images?${params.toString()}`);
    },
    facets(): Promise<LibraryFacets> {
      return request(`/images/facets`);
    },
    // Total photos the filter set matches.
    count(filters: LibraryFilters): Promise<{ count: number }> {
      return request(`/images/count?${filtersToParams(filters).toString()}`);
    },
    // The whole filtered library as one slim ordered list - drives the
    // virtual grid: exact scrollbar range and jump-anywhere without paging.
    index(filters: LibraryFilters): Promise<{ images: LibraryIndexImage[] }> {
      return request(`/images/index?${filtersToParams(filters).toString()}`);
    },
    // Every geotagged photo (slim rows, newest first) - the map clusters
    // these client-side per zoom level.
    geo(): Promise<{ images: GeoImage[] }> {
      return request(`/images/geo`);
    },
    get(id: string): Promise<ImageOut> {
      return request(`/images/${id}`);
    },
    update(
      id: string,
      patch: { rating?: number; color_label?: string; apply_to_pair?: boolean }
    ): Promise<ImageOut> {
      return request(`/images/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    },
    bulkUpdate(
      image_ids: string[],
      patch: { rating?: number; color_label?: string; apply_to_pair?: boolean }
    ): Promise<ImageOut[]> {
      return request(`/images/bulk`, {
        method: "PATCH",
        body: JSON.stringify({ image_ids, ...patch }),
      });
    },
    // Managed photos go to the in-app Trash (restorable); photos indexed from
    // an external source root are removed from the library only - their files
    // on disk are never touched.
    bulkDelete(image_ids: string[]): Promise<void> {
      return request(`/images/bulk-delete`, { method: "POST", body: JSON.stringify({ image_ids }) });
    },
    listTrash(): Promise<ImageOut[]> {
      return request(`/images/trash`);
    },
    restoreFromTrash(image_ids: string[]): Promise<ImageOut[]> {
      return request(`/images/trash/restore`, { method: "POST", body: JSON.stringify({ image_ids }) });
    },
    // Permanently deletes photos already in the Trash - this removes the
    // original files from the library folder.
    deleteFromTrash(image_ids: string[]): Promise<void> {
      return request(`/images/trash/delete`, { method: "POST", body: JSON.stringify({ image_ids }) });
    },
    // Fetches a server-built zip of the originals and saves it via a temporary
    // object URL - keeps the potentially large binary out of React state.
    async downloadZip(image_ids: string[]): Promise<void> {
      const res = await fetch(`${BASE_URL}/images/download-zip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_ids }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`download-zip failed: ${res.status} ${body}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "photos.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    bulkAddTags(image_ids: string[], tag_names: string[]): Promise<ImageOut[]> {
      return request(`/images/bulk-tags`, { method: "POST", body: JSON.stringify({ image_ids, tag_names }) });
    },
    // Push already-imported library photos to Immich (only works when Immich is
    // configured in Settings). JPEGs upload; RAW/other files are skipped.
    pushToImmich(image_ids: string[]): Promise<ImmichPushResult> {
      return request(`/images/immich`, { method: "POST", body: JSON.stringify({ image_ids }) });
    },
    // Selective Immich sync: flag/unflag photos. Enabling also queues an
    // immediate upload of each JPEG. Returns the updated rows.
    setImmichSync(image_ids: string[], enabled: boolean): Promise<ImageOut[]> {
      return request(`/images/immich-sync`, {
        method: "POST",
        body: JSON.stringify({ image_ids, enabled }),
      });
    },
    bulkReset(image_ids: string[]): Promise<ImageOut[]> {
      return request(`/images/bulk-reset`, { method: "POST", body: JSON.stringify({ image_ids }) });
    },
    addTag(id: string, name: string): Promise<ImageOut> {
      return request(`/images/${id}/tags`, { method: "POST", body: JSON.stringify({ name }) });
    },
    removeTag(id: string, name: string): Promise<ImageOut> {
      return request(`/images/${id}/tags/${encodeURIComponent(name)}`, { method: "DELETE" });
    },
    similar(id: string, limit = 50): Promise<SearchResultOut[]> {
      return request(`/images/${id}/similar?limit=${limit}`);
    },
    rotate(id: string, degrees: 90 | -90): Promise<ImageOut> {
      return request(`/images/${id}/rotate`, { method: "PATCH", body: JSON.stringify({ degrees }) });
    },
    crop(id: string, crop: CropBox | null): Promise<ImageOut> {
      return request(`/images/${id}/crop`, { method: "PATCH", body: JSON.stringify({ crop }) });
    },
    // Live editor preview, rendered server-side with the exact save pipeline -
    // returns a JPEG blob. Abortable so a newer slider state cancels stale renders.
    // `full` renders on the full-resolution base (slow - fetched after settle).
    async editorPreview(id: string, edits: ImageEdits, signal?: AbortSignal, full = false): Promise<Blob> {
      const res = await fetch(`${BASE_URL}/images/${id}/editor-preview${full ? "?full=1" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiEdits(edits)),
        signal,
      });
      if (!res.ok) throw new Error(`preview render failed: ${res.status}`);
      return res.blob();
    },
    // Save the full non-destructive edit (rotation + crop + tonal) in place.
    saveEdits(id: string, edits: ImageEdits): Promise<ImageOut> {
      return request(`/images/${id}/edits`, { method: "PATCH", body: JSON.stringify(apiEdits(edits)) });
    },
    // Bake the edit into a new managed library photo (tagged "edited").
    saveCopy(id: string, edits: ImageEdits): Promise<ImageOut> {
      return request(`/images/${id}/save-copy`, { method: "POST", body: JSON.stringify(apiEdits(edits)) });
    },
    thumbnailUrl(id: string, version?: string): string {
      return derivativeUrl(`/images/${id}/thumbnail`, version);
    },
    previewUrl(id: string, version?: string): string {
      return derivativeUrl(`/images/${id}/preview`, version);
    },
    // Full-resolution edited render for true 100% zoom.
    fullUrl(id: string, version?: string): string {
      return derivativeUrl(`/images/${id}/full`, version);
    },
    // Geometry-only render (no tonal edits) the editor draws its live preview on.
    basePreviewUrl(id: string, version?: string): string {
      return derivativeUrl(`/images/${id}/base-preview`, version);
    },
    originalUrl(id: string): string {
      return assetUrl(`/images/${id}/original`);
    },
  },
  albums: {
    list(): Promise<AlbumOut[]> {
      return request(`/albums`);
    },
    get(id: string): Promise<AlbumOut> {
      return request(`/albums/${id}`);
    },
    create(name: string, description?: string): Promise<AlbumOut> {
      return request(`/albums`, { method: "POST", body: JSON.stringify({ name, description }) });
    },
    remove(id: string): Promise<void> {
      return request(`/albums/${id}`, { method: "DELETE" });
    },
    addImages(albumId: string, imageIds: string[]): Promise<AlbumOut> {
      return request(`/albums/${albumId}/images`, {
        method: "POST",
        body: JSON.stringify({ image_ids: imageIds }),
      });
    },
    removeImage(albumId: string, imageId: string): Promise<void> {
      return request(`/albums/${albumId}/images/${imageId}`, { method: "DELETE" });
    },
    // Selective Immich sync: mirror this album to Immich. Enabling queues an
    // upload of every JPEG in the album into a same-named Immich album.
    setImmichSync(albumId: string, enabled: boolean): Promise<AlbumOut> {
      return request(`/albums/${albumId}/immich-sync`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
    },
  },
  import: {
    // The server's multipart parser rejects a request with more than 1000
    // files, so big imports (a whole archive folder) are sent as several
    // batches: the first creates the staging session, the rest append to it.
    // Batches well under the cap keep each request's memory bounded too.
    // `signal` cancels an in-flight upload (see startUpload's Cancel button);
    // `onSession` fires as soon as the staging session exists so the caller can
    // clean it up if the user then cancels mid-upload.
    async upload(
      files: File[],
      sourceLabel: string,
      onProgress?: (pct: number) => void,
      signal?: AbortSignal,
      onSession?: (id: string) => void
    ): Promise<ImportSessionOut> {
      const BATCH_FILES = 250;
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0) || 1;
      const batches: File[][] = [];
      for (let i = 0; i < files.length; i += BATCH_FILES) batches.push(files.slice(i, i + BATCH_FILES));
      const batchBytes = batches.map((b) => b.reduce((sum, f) => sum + f.size, 0));

      const uploadedBytes = batches.map(() => 0);
      const report = () => {
        const done = uploadedBytes.reduce((a, b) => a + b, 0);
        onProgress?.(Math.min(100, Math.round((done / totalBytes) * 100)));
      };
      const sendOnce = (idx: number, sessionId: string | null) =>
        uploadBatch(batches[idx], sourceLabel, sessionId, totalBytes, (loaded) => {
          // loaded includes multipart framing overhead - clamp to the batch's
          // real payload so the total can't overshoot 100%.
          uploadedBytes[idx] = Math.min(loaded, batchBytes[idx]);
          report();
        }, signal).then((s) => {
          uploadedBytes[idx] = batchBytes[idx];
          report();
          return s;
        });
      // A multi-hour import shouldn't die because one batch hit a transient
      // hiccup (backend momentarily busy, socket reset). Retry each batch a
      // couple of times with a pause - but never on a user cancel, and never
      // on a 4xx/507 (those are real answers, a retry can't change them).
      const RETRIES = 2;
      const send = async (idx: number, sessionId: string | null) => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await sendOnce(idx, sessionId);
          } catch (err) {
            const e = err as Error & { status?: number; name?: string };
            const retriable =
              e.name !== "AbortError" && (e.status === undefined || e.status >= 500) && e.status !== 507;
            if (!retriable || attempt >= RETRIES) throw err;
            uploadedBytes[idx] = 0;
            report();
            await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
            if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
          }
        }
      };

      // The first batch runs alone - its response carries the session id the
      // rest append to.
      const session = await send(0, null);
      onSession?.(session.id);
      // Then keep two requests in flight: the server serializes the staging
      // work, but receives the next batch's bytes while it analyzes the
      // previous one - upload and analysis overlap instead of alternating.
      let pending: Promise<ImportSessionOut> | null = null;
      for (let i = 1; i < batches.length; i++) {
        const next = send(i, session.id);
        // If an earlier batch fails the whole upload aborts; this handler only
        // keeps the still-running one from surfacing as an unhandled rejection.
        next.catch(() => {});
        if (pending) await pending;
        pending = next;
      }
      if (pending) await pending;
      return session;
    },
    get(id: string): Promise<ImportSessionOut> {
      return request(`/import/sessions/${id}`);
    },
    // Direct desktop import: the backend scans and reads the folder itself,
    // so nothing is pumped through a browser upload. Electron-only (needs a
    // native absolute folder path from the OS dialog).
    scanFolder(path: string, signal?: AbortSignal): Promise<FolderScanOut> {
      return request(`/import/scan-folder`, {
        method: "POST",
        body: JSON.stringify({ path }),
        signal,
      });
    },
    stagePaths(
      paths: string[],
      sourceLabel: string,
      sessionId: string | null,
      totalBytes: number,
      signal?: AbortSignal
    ): Promise<ImportSessionOut> {
      return request(`/import/sessions/stage-paths`, {
        method: "POST",
        body: JSON.stringify({
          paths,
          source_label: sourceLabel,
          session_id: sessionId,
          total_bytes: totalBytes,
        }),
        signal,
      });
    },
    progress(id: string): Promise<ImportProgress> {
      return request(`/import/sessions/${id}/progress`);
    },
    files(id: string): Promise<StagedFileOut[]> {
      return request(`/import/sessions/${id}/files`);
    },
    stagedThumbnailUrl(sessionId: string, fileId: string): string {
      return assetUrl(`/import/sessions/${sessionId}/files/${fileId}/thumbnail`);
    },
    stagedPreviewUrl(sessionId: string, fileId: string): string {
      return assetUrl(`/import/sessions/${sessionId}/files/${fileId}/preview`);
    },
    updateStagedFile(sessionId: string, fileId: string, patch: StagedFileUpdatePatch): Promise<StagedFileOut> {
      return request(`/import/sessions/${sessionId}/files/${fileId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    },
    // One request/transaction for "select all"-style bulk changes - a PATCH
    // per file made selecting a big import take seconds.
    bulkUpdateStagedFiles(
      sessionId: string,
      fileIds: string[],
      patch: StagedFileUpdatePatch
    ): Promise<StagedFileOut[]> {
      return request(`/import/sessions/${sessionId}/files`, {
        method: "PATCH",
        body: JSON.stringify({ file_ids: fileIds, ...patch }),
      });
    },
    commit(id: string, uploadToImmich = false, syncAllToImmich = false): Promise<ImageOut[]> {
      return request(`/import/sessions/${id}/commit`, {
        method: "POST",
        body: JSON.stringify({
          upload_to_immich: uploadToImmich,
          sync_all_to_immich: syncAllToImmich,
        }),
      });
    },
    discard(id: string): Promise<void> {
      return request(`/import/sessions/${id}`, { method: "DELETE" });
    },
  },
  search: {
    // Scoped to the grid the user is on: pass the same filters (album, rating,
    // color, date range, view mode) so results only include photos the current
    // view would show.
    query(q: string, filters?: Partial<LibraryFilters>): Promise<SearchResultOut[]> {
      const params = filtersToParams(filters ?? {});
      params.set("q", q);
      // The UI language, so country/city queries work in it ("italien",
      // "münchen") as well as in English.
      params.set("lang", navigator.language || "en");
      return request(`/search?${params.toString()}`);
    },
  },
  maintenance: {
    sync(): Promise<{
      removed_missing_files: number;
      untracked_files_found: number;
      orphan_thumbnails_removed: number;
      thumbnails_queued: number;
    }> {
      return request(`/maintenance/sync`, { method: "POST" });
    },
    rebuildThumbnails(): Promise<{ rebuilt: number }> {
      return request(`/maintenance/rebuild-thumbnails`, { method: "POST" });
    },
    // Re-read every photo's EXIF capture date and fix wrongly stored ones
    // (photos imported before the reader understood CreateDate/XMP fallbacks
    // sorted by their import moment instead of their capture date).
    repairDates(): Promise<{ checked: number; fixed: number }> {
      return request(`/maintenance/repair-dates`, { method: "POST" });
    },
    backupUrl(): string {
      return assetUrl(`/maintenance/backup`);
    },
    wipe(confirmation: string): Promise<void> {
      return request(`/maintenance/wipe`, { method: "POST", body: JSON.stringify({ confirmation }) });
    },
    restore(file: File, confirmation: string): Promise<{ images_restored: number; albums_restored: number }> {
      return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append("file", file, file.name);
        formData.append("confirmation", confirmation);

        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${BASE_URL}/maintenance/restore`);
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText));
          } else {
            reject(new Error(`Restore failed: ${xhr.status} ${xhr.responseText}`));
          }
        };
        xhr.onerror = () => reject(new Error("Restore failed: network error"));
        xhr.send(formData);
      });
    },
  },
  tags: {
    list(): Promise<string[]> {
      return request(`/tags`);
    },
    usage(): Promise<TagUsage[]> {
      return request(`/tags/usage`);
    },
    remove(name: string): Promise<void> {
      return request(`/tags/${encodeURIComponent(name)}`, { method: "DELETE" });
    },
    pruneUnused(): Promise<{ removed: string[] }> {
      return request(`/tags/prune-unused`, { method: "POST" });
    },
  },
  settings: {
    getTrash(): Promise<TrashSettings> {
      return request(`/settings/trash`);
    },
    updateTrash(retention_days: number): Promise<TrashSettings> {
      return request(`/settings/trash`, { method: "PUT", body: JSON.stringify({ retention_days }) });
    },
    // Live Immich upload activity - drives the top-bar sync indicator (and
    // the desktop shell's quit warning, which calls it directly).
    immichActivity(): Promise<{ pending_uploads: number; sync_mode: string }> {
      return request(`/settings/immich/activity`);
    },
    getImmich(): Promise<ImmichSettings> {
      return request(`/settings/immich`);
    },
    updateImmich(patch: {
      base_url: string;
      api_key?: string | null;
      sync_mode?: ImmichSyncMode;
    }): Promise<ImmichSettings> {
      return request(`/settings/immich`, { method: "PUT", body: JSON.stringify(patch) });
    },
    testImmich(): Promise<ImmichTestResult> {
      return request(`/settings/immich/test`, { method: "POST" });
    },
    immichUploads(): Promise<ImmichUploadResult[]> {
      return request(`/settings/immich/uploads`);
    },
  },
  sources: {
    list(): Promise<SourceRoot[]> {
      return request(`/sources`);
    },
    add(name: string, path: string): Promise<SourceRoot> {
      return request(`/sources`, { method: "POST", body: JSON.stringify({ name, path }) });
    },
    browse(path?: string): Promise<DirListing> {
      const qs = path ? `?${new URLSearchParams({ path })}` : "";
      return request(`/sources/browse${qs}`);
    },
    scan(id: string): Promise<ScanStatus> {
      return request(`/sources/${id}/scan`, { method: "POST" });
    },
    scanStatus(id: string): Promise<ScanStatus> {
      return request(`/sources/${id}/scan-status`);
    },
    remove(id: string): Promise<void> {
      return request(`/sources/${id}`, { method: "DELETE" });
    },
  },
};

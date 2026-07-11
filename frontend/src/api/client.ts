import type {
  AlbumOut,
  CropBox,
  ImageOut,
  DirListing,
  ImmichSettings,
  ImmichTestResult,
  ImmichPushResult,
  ImmichUploadResult,
  ImportSessionOut,
  LibraryFilters,
  ScanStatus,
  SearchResultOut,
  SourceRoot,
  StagedFileOut,
  StagedFileUpdatePatch,
  TagUsage,
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

// The editor state uses camelCase; the API's pydantic model is snake_case.
// Multi-word fields MUST be renamed here - pydantic silently ignores unknown
// keys, so a camelCase key wouldn't error, it would just drop the edit (this
// bit us: colorMix/grainSize/colorTint were lost on every save).
function apiEdits(edits: ImageEdits) {
  const { colorMix, grainSize, colorTint, chromeEffect, chromeBlue, ...rest } = edits;
  return {
    ...rest,
    color_mix: colorMix,
    grain_size: grainSize,
    color_tint: colorTint,
    chrome_effect: chromeEffect,
    chrome_blue: chromeBlue,
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

export const api = {
  images: {
    list(filters: LibraryFilters): Promise<ImageOut[]> {
      return request(`/images?${filtersToParams(filters).toString()}`);
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
    emptyTrash(): Promise<void> {
      return request(`/images/trash/empty`, { method: "POST" });
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
    bulkReset(image_ids: string[]): Promise<ImageOut[]> {
      return request(`/images/bulk-reset`, { method: "POST", body: JSON.stringify({ image_ids }) });
    },
    addTag(id: string, name: string): Promise<ImageOut> {
      return request(`/images/${id}/tags`, { method: "POST", body: JSON.stringify({ name }) });
    },
    removeTag(id: string, name: string): Promise<ImageOut> {
      return request(`/images/${id}/tags/${encodeURIComponent(name)}`, { method: "DELETE" });
    },
    similar(id: string): Promise<SearchResultOut[]> {
      return request(`/images/${id}/similar`);
    },
    rotate(id: string, degrees: 90 | -90): Promise<ImageOut> {
      return request(`/images/${id}/rotate`, { method: "PATCH", body: JSON.stringify({ degrees }) });
    },
    crop(id: string, crop: CropBox | null): Promise<ImageOut> {
      return request(`/images/${id}/crop`, { method: "PATCH", body: JSON.stringify({ crop }) });
    },
    // Live editor preview, rendered server-side with the exact save pipeline -
    // returns a JPEG blob. Abortable so a newer slider state cancels stale renders.
    async editorPreview(id: string, edits: ImageEdits, signal?: AbortSignal): Promise<Blob> {
      const res = await fetch(`${BASE_URL}/images/${id}/editor-preview`, {
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
  },
  import: {
    // Uses XMLHttpRequest (not fetch) so we get real upload progress - an SD
    // card of RAW files can be several GB, and a silent multi-minute hang
    // would look broken without it.
    upload(files: File[], sourceLabel: string, onProgress?: (pct: number) => void): Promise<ImportSessionOut> {
      return new Promise((resolve, reject) => {
        const formData = new FormData();
        files.forEach((f) => formData.append("files", f, f.name));
        formData.append("source_label", sourceLabel);

        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${BASE_URL}/import/sessions/upload`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText));
          } else {
            reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText}`));
          }
        };
        xhr.onerror = () => reject(new Error("Upload failed: network error"));
        xhr.send(formData);
      });
    },
    get(id: string): Promise<ImportSessionOut> {
      return request(`/import/sessions/${id}`);
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
    commit(id: string, uploadToImmich = false): Promise<ImageOut[]> {
      return request(`/import/sessions/${id}/commit`, {
        method: "POST",
        body: JSON.stringify({ upload_to_immich: uploadToImmich }),
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
      return request(`/search?${params.toString()}`);
    },
  },
  maintenance: {
    sync(): Promise<{ removed_missing_files: number; untracked_files_found: number }> {
      return request(`/maintenance/sync`, { method: "POST" });
    },
    rebuildThumbnails(): Promise<{ rebuilt: number }> {
      return request(`/maintenance/rebuild-thumbnails`, { method: "POST" });
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
    getImmich(): Promise<ImmichSettings> {
      return request(`/settings/immich`);
    },
    updateImmich(patch: { base_url: string; api_key?: string | null }): Promise<ImmichSettings> {
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

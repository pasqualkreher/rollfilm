import type {
  AlbumOut,
  CropBox,
  ImageOut,
  DirListing,
  ImmichSettings,
  ImmichTestResult,
  ImmichPushResult,
  ImportSessionOut,
  LibraryFilters,
  ScanStatus,
  SearchResultOut,
  SourceRoot,
  StagedFileOut,
  StagedFileUpdatePatch,
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
    image.edit_saturation,
    image.edit_temperature,
    image.edit_tint,
    image.edit_color_mix ?? "",
    image.edit_vignette,
  ].join("-");
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

export const api = {
  images: {
    list(filters: LibraryFilters): Promise<ImageOut[]> {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
          params.set(key, String(value));
        }
      });
      return request(`/images?${params.toString()}`);
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
    bulkDelete(image_ids: string[]): Promise<void> {
      return request(`/images/bulk-delete`, { method: "POST", body: JSON.stringify({ image_ids }) });
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
    // Save the full non-destructive edit (rotation + crop + tonal) in place.
    saveEdits(id: string, edits: ImageEdits): Promise<ImageOut> {
      return request(`/images/${id}/edits`, { method: "PATCH", body: JSON.stringify(edits) });
    },
    // Bake the edit into a new managed library photo (tagged "edited").
    saveCopy(id: string, edits: ImageEdits): Promise<ImageOut> {
      return request(`/images/${id}/save-copy`, { method: "POST", body: JSON.stringify(edits) });
    },
    thumbnailUrl(id: string, version?: string): string {
      return assetUrl(`/images/${id}/thumbnail${version ? `?v=${version}` : ""}`);
    },
    previewUrl(id: string, version?: string): string {
      return assetUrl(`/images/${id}/preview${version ? `?v=${version}` : ""}`);
    },
    // Geometry-only render (no tonal edits) the editor draws its live preview on.
    basePreviewUrl(id: string, version?: string): string {
      return assetUrl(`/images/${id}/base-preview${version ? `?v=${version}` : ""}`);
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
      const params = new URLSearchParams({ q });
      if (filters) {
        Object.entries(filters).forEach(([key, value]) => {
          if (value !== undefined && value !== null && value !== "") {
            params.set(key, String(value));
          }
        });
      }
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

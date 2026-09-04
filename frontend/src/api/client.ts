import type {
  CanvasGalleryOut,
  CanvasLayout,
  CanvasSummary,
  AlbumOut,
  AutoAdjustResult,
  AutoDevelopSettings,
  BorgSettings,
  BorgTestResult,
  BulkAutoDevelopResult,
  BulkResetOptions,
  CropBox,
  LibraryStats,
  ExportJobProgress,
  ImageOut,
  ImageRenameResult,
  SegmentResult,
  DirListing,
  ImmichActivity,
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
  LibraryMergeProgress,
  LibraryMergeSummary,
  ScanStatus,
  SearchResultOut,
  SmartAlbumsOut,
  SmartAlbumSettings,
  SourceRoot,
  StagedFileOut,
  StagedFileUpdatePatch,
  TagUsage,
  RawDecodeSettings,
  TrashSettings,
} from "./types";
import type { ImageEdits } from "../utils/adjustments";

// Thumbnail/preview files are regenerated in place after an edit, so the URL
// needs to change to bust the browser cache - this derives a stable version
// key from the same fields that affect the rendered pixels.
export function editVersion(image: ImageOut): string {
  return image.edit_rev ? String(image.edit_rev) : "";
}

// Never-edited photos: the library index sends thumb_version "" for them (the
// vast majority) and this constant stands in so their thumbnail URLs match the
// ones every other view builds via editVersion().
export const DEFAULT_EDIT_VERSION = "";

// The editor's geometry state uses camelCase; the API's pydantic model is
// snake_case. Multi-word geometry fields MUST be renamed here - pydantic
// silently ignores unknown keys, so a camelCase key wouldn't error, it would
// just drop the edit. The `adjustments` object already uses snake_case keys
// (see utils/adjustments.ts) and passes straight through.
function apiEdits(edits: ImageEdits) {
  const { flipH, flipV, perspH, perspV, ...rest } = edits;
  return {
    ...rest,
    flip_h: flipH,
    flip_v: flipV,
    persp_h: perspH,
    persp_v: perspV,
  };
}

// In the Electron app the backend runs on a random localhost port, injected by
// the preload script. Fall back to the build-time env (web/Docker) or the dev default.
/** A render Blob carrying what the server actually produced. `servedTier`: a
 *  native request is answered from the tier below while the full-resolution
 *  base decodes. `frame`/`box`: set on region renders - the finished frame's
 *  pixel size and the tile's exact box within it (all in the frame's pixels),
 *  so the editor can composite the tile into its copy of the frame without
 *  re-deriving (and mis-rounding) either. The tile's bitmap can be smaller
 *  than its box when `regionPx` capped the render - drawing stretches it. */
export type ServedBlob = Blob & {
  servedTier?: string;
  frame?: { w: number; h: number };
  box?: { x: number; y: number; w?: number; h?: number };
};

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

// Save a download by asking the user where to put it FIRST (via the File
// System Access API our Electron/Chromium runtime provides), then running the
// potentially slow server build and streaming the result into the chosen file.
// This way the save dialog appears up front rather than after the whole zip is
// built. Where the picker is unavailable we fall back to a plain anchor
// download, which prompts at the end. Returns without saving if the user
// cancels the picker.
// Exported for the progress-export dialog: its `fetchBlob` runs the whole
// job (start + poll + result) so the location question still comes first.
export async function saveDownload(
  suggestedName: string,
  accept: Record<string, string[]>,
  fetchBlob: () => Promise<Blob>
): Promise<void> {
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (opts: {
        suggestedName?: string;
        types?: { description?: string; accept: Record<string, string[]> }[];
      }) => Promise<{
        createWritable: () => Promise<{
          write: (data: Blob) => Promise<void>;
          close: () => Promise<void>;
        }>;
      }>;
    }
  ).showSaveFilePicker;

  if (picker) {
    let handle;
    try {
      handle = await picker({ suggestedName, types: [{ accept }] });
    } catch (e) {
      // User dismissed the location picker - nothing to save, not an error.
      if (e instanceof DOMException && e.name === "AbortError") return;
      throw e;
    }
    const blob = await fetchBlob();
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }

  const blob = await fetchBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// The desktop shell serves cached derivatives off disk through its own rf://
// scheme (see electron/main.js), which sidesteps the six-connections-per-origin
// limit Chromium puts on HTTP/1.1 - the ceiling that capped how many of a
// grid's tiles could ever be loading at once, however far ahead the look-ahead
// reached. Only in Electron; the web/Docker build has no such scheme and stays
// on HTTP.
const HAS_DESKTOP_SHELL = typeof window !== "undefined" && Boolean(window.photoManager?.apiBaseUrl);

// Which on-disk file a derivative route corresponds to, or null for the ones
// that are RENDERED per request (full-resolution zoom, the editor's geometry
// base) and therefore have to go to the backend.
function derivativeFile(route: string, size?: string): string | null {
  if (route === "preview") return "preview.jpg";
  if (route === "thumbnail") return size ? `${size}.jpg` : "thumbnail.jpg";
  return null;
}

function derivativeUrl(id: string, route: string, version?: string, size?: string): string {
  let cb = "";
  try {
    cb = localStorage.getItem(CACHE_BUST_KEY) ?? "";
  } catch {
    /* ignore */
  }
  const query = [size ? `size=${size}` : "", version ? `v=${version}` : "", cb ? `cb=${cb}` : ""]
    .filter(Boolean)
    .join("&");
  const file = HAS_DESKTOP_SHELL ? derivativeFile(route, size) : null;
  // The query string is carried onto the rf:// URL unchanged even though the
  // handler resolves the path from the id and filename alone: `v`/`cb` are what
  // make the URL change when the pixels change, and that has to hold on both
  // branches or an edit would keep painting the cached old render.
  const base = file ? `rf://derivative/${id}/${file}` : assetUrl(`/images/${id}/${route}`);
  return `${base}${query ? `?${query}` : ""}`;
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
    // Filter-dropdown options, cross-filtered: pass the active filters so each
    // facet reflects what the other filters leave over (the backend lifts each
    // facet's own dimension, so its alternatives stay selectable).
    facets(filters: Partial<LibraryFilters> = {}): Promise<LibraryFacets> {
      const params = filtersToParams(filters).toString();
      return request(`/images/facets${params ? `?${params}` : ""}`);
    },
    // Total photos the filter set matches (no filters = the whole library).
    count(filters: Partial<LibraryFilters> = {}): Promise<{ count: number }> {
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
      patch: {
        rating?: number;
        color_label?: string;
        // "" clears the note; omit the field to leave it as it is.
        description?: string;
        apply_to_pair?: boolean;
      }
    ): Promise<ImageOut> {
      return request(`/images/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    },
    // Renames the photo's actual file on disk and follows it in the catalog -
    // the photo keeps its id, and with it its rating, tags, albums and edits.
    // `name` may be typed with or without the extension; the extension is
    // always kept. rename_pair (default true) gives the RAW/JPEG partner the
    // same stem.
    rename(id: string, name: string, rename_pair = true): Promise<ImageRenameResult> {
      return request(`/images/${id}/rename`, {
        method: "POST",
        body: JSON.stringify({ name, rename_pair }),
      });
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
      await saveDownload("photos.zip", { "application/zip": [".zip"] }, async () => {
        const res = await fetch(`${BASE_URL}/images/download-zip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_ids }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`download-zip failed: ${res.status} ${body}`);
        }
        return res.blob();
      });
    },
    // Downloads the library files exactly as stored (RAW stays RAW, all EXIF
    // and metadata untouched) - a single photo as the original file itself,
    // several via the zip endpoint above.
    async downloadOriginals(image_ids: string[]): Promise<void> {
      if (image_ids.length !== 1) return api.images.downloadZip(image_ids);
      const res = await fetch(`${BASE_URL}/images/${image_ids[0]}/original`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`download failed: ${res.status} ${body}`);
      }
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "photo";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    // Server-side JPEG export with the saved edits baked in - one photo comes
    // back as a plain .jpg, several as a zip. Saved via a temporary object URL
    // like downloadZip, with the filename taken from the response headers.
    async exportImages(
      image_ids: string[],
      opts: { quality: number; max_size?: number | null }
    ): Promise<void> {
      const single = image_ids.length === 1;
      const suggestedName = single ? "export.jpg" : "export.zip";
      const accept: Record<string, string[]> = single
        ? { "image/jpeg": [".jpg", ".jpeg"] }
        : { "application/zip": [".zip"] };
      await saveDownload(suggestedName, accept, async () => {
        const res = await fetch(`${BASE_URL}/images/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_ids, quality: opts.quality, max_size: opts.max_size ?? null }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`export failed: ${res.status} ${body}`);
        }
        return res.blob();
      });
    },
    // Progress-reporting export: start a server-side job (renders in a worker
    // thread), poll its per-photo progress, then download the finished file.
    // Powers the export dialog's progress bar for both formats.
    exportStart(
      image_ids: string[],
      opts: { quality: number; max_size?: number | null; format: "jpeg" | "original" }
    ): Promise<{ job_id: string; total: number }> {
      return request(`/images/export/start`, {
        method: "POST",
        body: JSON.stringify({
          image_ids,
          quality: opts.quality,
          max_size: opts.max_size ?? null,
          format: opts.format,
        }),
      });
    },
    exportProgress(job_id: string): Promise<ExportJobProgress> {
      return request(`/images/export/${job_id}/progress`);
    },
    exportCancel(job_id: string): Promise<void> {
      return request(`/images/export/${job_id}`, { method: "DELETE" });
    },
    // Fetch the finished job's file as a blob (the dialog writes it into the
    // save target it picked before starting the job).
    async exportResultBlob(job_id: string): Promise<Blob> {
      const res = await fetch(`${BASE_URL}/images/export/${job_id}/result`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`export download failed: ${res.status} ${body}`);
      }
      return res.blob();
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
    // Reset selected aspects (stars/colors/tags/develop/geometry/albums) back to
    // the just-imported state. Omitted flags fall back to the server defaults
    // (the three metadata flags default true, edits/albums false).
    bulkReset(image_ids: string[], opts?: BulkResetOptions): Promise<ImageOut[]> {
      return request(`/images/bulk-reset`, {
        method: "POST",
        body: JSON.stringify({ image_ids, ...opts }),
      });
    },
    // Apply one develop object (an editor preset) to every selected photo in
    // place. Geometry is untouched; a neutral object clears the develop sliders.
    bulkDevelop(image_ids: string[], adjustments: Record<string, unknown>): Promise<ImageOut[]> {
      return request(`/images/bulk-develop`, {
        method: "POST",
        body: JSON.stringify({ image_ids, adjustments }),
      });
    },
    // Auto-develop every selected photo (each learns its own suggestion). Returns
    // the updated rows plus how many were applied vs. skipped (no embedding yet).
    bulkAutoDevelop(image_ids: string[]): Promise<BulkAutoDevelopResult> {
      return request(`/images/bulk-auto-develop`, {
        method: "POST",
        body: JSON.stringify({ image_ids }),
      });
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
    // mode: "scrub" = fast small-base frame drawn while dragging a control,
    // "fast" = accurate render on release, "full" = settled full-quality pass,
    // "ultra" = one step above "full", for when the settled render is still
    // being shown upscaled - it costs no extra decode, so the editor walks up to
    // it before considering "native".
    // "native" = TRUE full-resolution render for 100% zoom (slowest, background).
    // `browse` renders a raw with the library's auto-exposure instead of the
    // editor's native (dark) base - only the split view's "Original" half wants
    // that; every other render must stay native so edits are made on real data.
    // `peek` marks one mask's covered area in the returned frame with the
    // editor's zebra - what the Show-mask toggle uses for the masks that have no
    // shape to draw over the photo (luminance / colour / edges).
    // A preview Blob, tagged with the tier the server actually rendered.
    async editorPreview(
      id: string,
      edits: ImageEdits,
      signal?: AbortSignal,
      mode: "scrub" | "fast" | "full" | "ultra" | "native" = "fast",
      browse = false,
      peek: string | null = null,
      // Fractions of the finished frame. The native tier renders that part
      // alone (what makes editing at 100% zoom possible at all - the whole
      // frame of a 40MP raw is half a minute of pipeline for pixels that are
      // mostly off screen); scrub and the accurate tier honour it too once the
      // native base is decoded, so the live frames while zoomed are sharp
      // instead of a stretched whole-frame preview. The server answers with a
      // whole frame when a tile isn't possible - check `frame` on the result.
      region: { x: number; y: number; w: number; h: number } | null = null,
      // Scrub tier only: the user is zoomed in, so the drag frames are being
      // inspected for detail - the server sizes them up to the accurate base.
      zoomed = false,
      // The interactive render budget, in device pixels of the long edge.
      // With a region it caps the tile's rendered size (between fit view and
      // 100% zoom the native cut holds more pixels than the screen can show,
      // and rendering them made zoomed drags crawl and stretched the settle;
      // at true 100% the budget equals the cut, so the zoomed-in sharpness the
      // native tier exists for is untouched). Without a region it is the
      // whole-frame scrub tier's adaptive resolution (`px=`) - the editor
      // walks it down when drag frames stop keeping up with the pointer.
      regionPx: number | null = null,
      // Native settle polling: the caller already painted this edit state from
      // the fallback tier and only waits for the full-resolution base. With
      // this set the server answers "not yet" (202, servedTier "pending")
      // instead of re-rendering the multi-second fallback frame - check
      // servedTier before touching the blob, a pending one is empty.
      nativeOnly = false
    ): Promise<ServedBlob> {
      const tier =
        mode === "native"
          ? "native=1"
          : mode === "ultra"
            ? "ultra=1"
            : mode === "full"
              ? "full=1"
              : mode === "scrub"
                ? "scrub=1"
                : "";
      const regionParam =
        region && (mode === "native" || mode === "scrub" || mode === "fast")
          ? `region=${[region.x, region.y, region.w, region.h].map((n) => n.toFixed(5)).join(",")}`
          : "";
      const params = [
        tier,
        browse ? "browse=1" : "",
        peek ? `peek=${encodeURIComponent(peek)}` : "",
        regionParam,
        regionParam && regionPx ? `region_px=${Math.round(regionPx)}` : "",
        !regionParam && regionPx && mode === "scrub" ? `px=${Math.round(regionPx)}` : "",
        mode === "native" && nativeOnly ? "native_only=1" : "",
        zoomed && mode === "scrub" ? "zoomed=1" : "",
      ]
        .filter(Boolean)
        .join("&");
      const q = params ? `?${params}` : "";
      const res = await fetch(`${BASE_URL}/images/${id}/editor-preview${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiEdits(edits)),
        signal,
      });
      // 409 = the server dropped this render because a newer preview request
      // for the image superseded it. We aborted the fetch client-side too in
      // that case - treat any straggler exactly like our own abort, never as
      // a user-visible render error.
      if (res.status === 409) throw new DOMException("preview superseded", "AbortError");
      if (!res.ok) throw new Error(`preview render failed: ${res.status}`);
      const blob = await res.blob();
      // What the server actually rendered. It is not always what was asked for:
      // a native request lands on the tier below while the full-resolution base
      // is still decoding, and the caller needs to know so it can come back for
      // the sharp one. Carried on the Blob so no call site has to change shape.
      const out = blob as ServedBlob;
      const served = res.headers.get("X-Rollfilm-Tier");
      if (served) out.servedTier = served;
      const frame = res.headers.get("X-Rollfilm-Frame");
      const box = res.headers.get("X-Rollfilm-Box");
      if (frame && box) {
        const [fw, fh] = frame.split("x").map(Number);
        const [bx, by, bw, bh] = box.split(",").map(Number);
        if (fw > 0 && fh > 0 && Number.isFinite(bx) && Number.isFinite(by)) {
          out.frame = { w: fw, h: fh };
          out.box = { x: bx, y: by };
          if (bw > 0 && bh > 0) {
            out.box.w = bw;
            out.box.h = bh;
          }
        }
      }
      return out;
    },
    // Develop suggestion learned from the user's own saved edits (CLIP k-NN
    // over edited photos). Pure suggestion - nothing is stored server-side.
    autoAdjust(id: string): Promise<AutoAdjustResult> {
      return request(`/images/${id}/auto-adjust`);
    },
    // Find a named subject (sky / water / greenery / people / buildings /
    // ground) and get it back as a soft mask. The edits ride along because the
    // mask comes back in the *framed* image's coordinates - the geometry has to
    // match what the editor is showing.
    segment(id: string, edits: ImageEdits, subject: string): Promise<SegmentResult> {
      return request(`/images/${id}/segment`, {
        method: "POST",
        body: JSON.stringify({ ...apiEdits(edits), subject }),
      });
    },
    // Ask the server to run the subject-detection pass for this frame now,
    // before any subject has been picked. One pass finds all six subjects, so
    // opening the Masks panel a second or two ahead of the click is usually
    // enough for the click itself to be instant. Fire and forget - if it
    // doesn't finish (or fails), segment() does the work as it always did.
    segmentPrepare(id: string, edits: ImageEdits): Promise<void> {
      return request(`/images/${id}/segment/prepare`, {
        method: "POST",
        body: JSON.stringify(apiEdits(edits)),
      });
    },
    // Save the full non-destructive edit (rotation + crop + tonal) in place.
    saveEdits(id: string, edits: ImageEdits): Promise<ImageOut> {
      return request(`/images/${id}/edits`, { method: "PATCH", body: JSON.stringify(apiEdits(edits)) });
    },
    // Bake the edit into a new managed library photo (tagged "edited").
    // quality/maxSize mirror the export options (long-edge cap, JPEG quality).
    saveCopy(id: string, edits: ImageEdits, opts?: { quality?: number; maxSize?: number | null }): Promise<ImageOut> {
      const params = new URLSearchParams();
      if (opts?.quality != null) params.set("quality", String(opts.quality));
      if (opts?.maxSize != null) params.set("max_size", String(opts.maxSize));
      const qs = params.toString();
      return request(`/images/${id}/save-copy${qs ? `?${qs}` : ""}`, {
        method: "POST",
        body: JSON.stringify(apiEdits(edits)),
      });
    },
    // A "virtual copy": a second library entry for the SAME file on disk,
    // starting from the source's current develop state, tagged "virtual copy".
    // No pixels are written; deleting the copy later falls canvas frames back
    // to the source.
    // With `edits` (the editor's Save copy → virtual copy) the copy takes the
    // editor's current, possibly unsaved state instead of the saved one.
    virtualCopy(id: string, edits?: ImageEdits): Promise<ImageOut> {
      return request(`/images/${id}/virtual-copy`, {
        method: "POST",
        ...(edits ? { body: JSON.stringify(apiEdits(edits)) } : {}),
      });
    },
    // `size: "small"` requests the 640px tier the dense grid sizes use (see
    // thumbTier in state/viewPrefs.ts); omitted = the full 1600px thumbnail.
    thumbnailUrl(id: string, version?: string, size?: "small"): string {
      return derivativeUrl(id, "thumbnail", version, size);
    },
    previewUrl(id: string, version?: string): string {
      return derivativeUrl(id, "preview", version);
    },
    // Full-resolution edited render for true 100% zoom.
    fullUrl(id: string, version?: string): string {
      return derivativeUrl(id, "full", version);
    },
    // The photo as the layout exports take it: the saved bytes themselves for
    // a photo without edits, a lossless full-resolution PNG for one with.
    exportUrl(id: string, version?: string): string {
      return derivativeUrl(id, "export", version);
    },
    // Geometry-only render (no tonal edits) the editor draws its live preview on.
    basePreviewUrl(id: string, version?: string): string {
      return derivativeUrl(id, "base-preview", version);
    },
  },
  albums: {
    list(): Promise<AlbumOut[]> {
      return request(`/albums`);
    },
    get(id: string): Promise<AlbumOut> {
      return request(`/albums/${id}`);
    },
    create(name: string, description?: string, tagFilter?: string[]): Promise<AlbumOut> {
      return request(`/albums`, {
        method: "POST",
        body: JSON.stringify({ name, description, tag_filter: tagFilter ?? [] }),
      });
    },
    update(
      id: string,
      patch: { name?: string; description?: string; tag_filter?: string[] }
    ): Promise<AlbumOut> {
      return request(`/albums/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
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
  canvases: {
    // The overview: every canvas, most recently worked-on first.
    list(): Promise<CanvasSummary[]> {
      return request(`/canvases`);
    },
    get(id: string): Promise<CanvasSummary> {
      return request(`/canvases/${id}`);
    },
    create(name: string): Promise<CanvasSummary> {
      return request(`/canvases`, { method: "POST", body: JSON.stringify({ name }) });
    },
    rename(id: string, name: string): Promise<CanvasSummary> {
      return request(`/canvases/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
    },
    remove(id: string): Promise<void> {
      return request(`/canvases/${id}`, { method: "DELETE" });
    },
    // Membership: what the canvas's filmstrip offers. Adding photos here is
    // the "Add to canvas" of the library's Select mode; the answer includes
    // every photo a frame still references, so placed frames never go blind.
    images(id: string): Promise<ImageOut[]> {
      return request(`/canvases/${id}/images`);
    },
    addImages(id: string, imageIds: string[]): Promise<CanvasSummary> {
      return request(`/canvases/${id}/images`, {
        method: "POST",
        body: JSON.stringify({ image_ids: imageIds }),
      });
    },
    removeImages(id: string, imageIds: string[]): Promise<CanvasSummary> {
      return request(`/canvases/${id}/images/remove`, {
        method: "POST",
        body: JSON.stringify({ image_ids: imageIds }),
      });
    },
    // The working layout. A canvas that has never been laid out answers with
    // a blank default page rather than a 404 - nothing is written until the
    // first save.
    getLayout(id: string): Promise<CanvasLayout> {
      return request(`/canvases/${id}/layout`);
    },
    // The whole canvas in one request: a drag can move, restack and reshape
    // several items at once, so the document is replaced rather than patched.
    saveLayout(id: string, layout: Omit<CanvasLayout, "canvas_id" | "updated_at">): Promise<CanvasLayout> {
      return request(`/canvases/${id}/layout`, { method: "PUT", body: JSON.stringify(layout) });
    },
    clearLayout(id: string): Promise<void> {
      return request(`/canvases/${id}/layout`, { method: "DELETE" });
    },
    // Kept versions of the canvas. Every call answers with the fresh layout
    // (including the version list), so the cache can be replaced in one go.
    createLayoutVersion(id: string, name: string): Promise<CanvasLayout> {
      return request(`/canvases/${id}/layout/versions`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
    },
    restoreLayoutVersion(id: string, versionId: string): Promise<CanvasLayout> {
      return request(`/canvases/${id}/layout/versions/${versionId}/restore`, { method: "POST" });
    },
    renameLayoutVersion(id: string, versionId: string, name: string): Promise<CanvasLayout> {
      return request(`/canvases/${id}/layout/versions/${versionId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
    },
    deleteLayoutVersion(id: string, versionId: string): Promise<CanvasLayout> {
      return request(`/canvases/${id}/layout/versions/${versionId}`, { method: "DELETE" });
    },
    // The Canvas Shelf (on the Albums page): every opted-in canvas's chosen
    // version, ready to draw.
    gallery(): Promise<CanvasGalleryOut[]> {
      return request(`/canvases/gallery`);
    },
    // On or off the Canvas Shelf - and nothing else. The shelf card's X calls
    // this: hiding is not deleting.
    setShelf(id: string, enabled: boolean): Promise<void> {
      return request(`/canvases/${id}/layout/shelf`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
    },
  },
  smartAlbums: {
    list(): Promise<SmartAlbumsOut> {
      return request(`/smart-albums`);
    },
    images(id: string, limit = 500, offset = 0): Promise<ImageOut[]> {
      return request(`/smart-albums/${encodeURIComponent(id)}/images?limit=${limit}&offset=${offset}`);
    },
  },
  import: {
    // The server's multipart parser rejects a request with more than 1000
    // files, so big imports (a whole archive folder) are sent as several
    // batches: the first creates the staging session, the rest append to it.
    // Batches well under the cap keep each request's memory bounded too.
    // `signal` cancels an in-flight upload (see startUpload's Cancel button);
    // `onSession` fires as soon as the staging session exists so the caller can
    // clean it up if the user then cancels mid-upload. `shouldStop` is the
    // graceful counterpart to `signal`: asked between batches, it ends the
    // upload *successfully* with whatever is already staged instead of
    // throwing the session away.
    async upload(
      files: File[],
      sourceLabel: string,
      onProgress?: (pct: number) => void,
      signal?: AbortSignal,
      onSession?: (id: string) => void,
      shouldStop?: () => boolean
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
        // Graceful stop: let the batches already in flight finish, then return
        // the session as if the upload had run out of files. The progress
        // percentage stops short of 100% - that's the point, the rest of the
        // photos were deliberately left behind.
        if (shouldStop?.()) break;
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
    // Full-resolution pixels of a staged file - fetched only once the review
    // lightbox is zoomed in, so 100% shows the photo's own pixels instead of an
    // upscaled preview.
    stagedFullUrl(sessionId: string, fileId: string): string {
      return assetUrl(`/import/sessions/${sessionId}/files/${fileId}/full`);
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
      // Show a lot more matches than the default handful - people search to
      // pull up everything about a place/tag/camera, not just the top 40.
      params.set("limit", "1000");
      // The UI language, so country/city queries work in it ("italien",
      // "münchen") as well as in English.
      params.set("lang", navigator.language || "en");
      return request(`/search?${params.toString()}`);
    },
  },
  maintenance: {
    sync(): Promise<{
      removed_missing_files: number;
      // Files renamed or moved outside the app, matched back to their photo by
      // content hash instead of being treated as gone.
      renamed_files_followed: number;
      untracked_files_found: number;
      orphan_thumbnails_removed: number;
      thumbnails_queued: number;
    }> {
      return request(`/maintenance/sync`, { method: "POST" });
    },
    rebuildThumbnails(): Promise<{ rebuilt: number }> {
      return request(`/maintenance/rebuild-thumbnails`, { method: "POST" });
    },
    // Live "N of M photos" progress of a running rebuild, polled by Settings.
    rebuildProgress(): Promise<{ active: boolean; total: number; done: number }> {
      return request(`/maintenance/rebuild-progress`);
    },
    // Read-only look at another Rollfilm library (a drive taken travelling):
    // what merging it would bring in. Touches nothing.
    inspectLibraryMerge(path: string): Promise<LibraryMergeSummary> {
      return request(`/maintenance/merge-library/inspect`, {
        method: "POST",
        body: JSON.stringify({ path }),
      });
    },
    // Starts the merge and returns at once - it runs in the background and is
    // followed through mergeLibraryProgress(), which also carries the outcome.
    mergeLibrary(path: string): Promise<LibraryMergeProgress> {
      return request(`/maintenance/merge-library`, {
        method: "POST",
        body: JSON.stringify({ path }),
      });
    },
    // Asks a running merge to stop; it finishes the photo it is on first.
    cancelLibraryMerge(): Promise<LibraryMergeProgress> {
      return request(`/maintenance/merge-library/cancel`, { method: "POST" });
    },
    mergeLibraryProgress(): Promise<LibraryMergeProgress> {
      return request(`/maintenance/merge-library/progress`);
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
    getAutoDevelop(): Promise<AutoDevelopSettings> {
      return request(`/settings/auto-develop`);
    },
    // enabled_groups omitted/undefined leaves the stored group selection as is.
    updateAutoDevelop(patch: { enabled: boolean; enabled_groups?: string[] }): Promise<AutoDevelopSettings> {
      return request(`/settings/auto-develop`, { method: "PUT", body: JSON.stringify(patch) });
    },
    getSmartAlbums(): Promise<SmartAlbumSettings> {
      return request(`/settings/smart-albums`);
    },
    // Omitted fields stay unchanged.
    updateSmartAlbums(patch: {
      sections?: string[];
      place_radius_km?: number;
    }): Promise<SmartAlbumSettings> {
      return request(`/settings/smart-albums`, { method: "PUT", body: JSON.stringify(patch) });
    },
    getTrash(): Promise<TrashSettings> {
      return request(`/settings/trash`);
    },
    updateTrash(retention_days: number): Promise<TrashSettings> {
      return request(`/settings/trash`, { method: "PUT", body: JSON.stringify({ retention_days }) });
    },
    getRawDecode(): Promise<RawDecodeSettings> {
      return request(`/settings/raw`);
    },
    updateRawDecode(native_decode: boolean): Promise<RawDecodeSettings> {
      return request(`/settings/raw`, { method: "PUT", body: JSON.stringify({ native_decode }) });
    },
    // Live Immich upload activity - drives the top-bar sync indicator, the
    // Settings sync-status panel (and the desktop shell's quit warning, which
    // calls it directly).
    immichActivity(): Promise<ImmichActivity> {
      return request(`/settings/immich/activity`);
    },
    setImmichPaused(paused: boolean): Promise<ImmichActivity> {
      return request(`/settings/immich/pause`, {
        method: "PUT",
        body: JSON.stringify({ paused }),
      });
    },
    getImmich(): Promise<ImmichSettings> {
      return request(`/settings/immich`);
    },
    updateImmich(patch: {
      base_url: string;
      api_key?: string | null;
      sync_mode?: ImmichSyncMode;
      enabled?: boolean;
    }): Promise<ImmichSettings> {
      return request(`/settings/immich`, { method: "PUT", body: JSON.stringify(patch) });
    },
    testImmich(): Promise<ImmichTestResult> {
      return request(`/settings/immich/test`, { method: "POST" });
    },
    immichUploads(): Promise<ImmichUploadResult[]> {
      return request(`/settings/immich/uploads`);
    },
    // Automatic incremental Borg backups. getBorg doubles as the status poll
    // (running / last-run outcome), so the Settings panel refreshes off it.
    getBorg(): Promise<BorgSettings> {
      return request(`/settings/borg`);
    },
    updateBorg(patch: {
      enabled: boolean;
      repo: string;
      // Omit / send null to keep the stored passphrase; "" clears it.
      passphrase?: string | null;
    }): Promise<BorgSettings> {
      return request(`/settings/borg`, { method: "PUT", body: JSON.stringify(patch) });
    },
    backupBorgNow(): Promise<BorgSettings> {
      return request(`/settings/borg/backup`, { method: "POST" });
    },
    testBorg(): Promise<BorgTestResult> {
      return request(`/settings/borg/test`, { method: "POST" });
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

  stats: {
    library(): Promise<LibraryStats> {
      return request(`/stats/library`);
    },
  },
};

export type FileType = "jpeg" | "png" | "raw";

export type ColorLabel =
  | "none"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "magenta"
  | "gray";

export type ViewMode = "combined" | "jpeg_only" | "raw_only";

export interface ImageOut {
  id: string;
  original_filename: string;
  file_type: FileType;
  raw_format: string | null;
  width: number | null;
  height: number | null;
  taken_at: string | null;
  imported_at: string;
  // Set while the photo sits in the in-app Trash (managed photos only).
  deleted_at: string | null;
  camera_make: string | null;
  camera_model: string | null;
  iso: number | null;
  aperture: number | null;
  shutter_speed: string | null;
  focal_length: number | null;
  gps_lat: number | null;
  gps_lon: number | null;
  gps_country: string | null;
  rating: number;
  color_label: ColorLabel;
  immich_sync: boolean;
  paired_image_id: string | null;
  source_root_id: string | null;
  edit_rotation: number;
  edit_crop_x: number | null;
  edit_crop_y: number | null;
  edit_crop_width: number | null;
  edit_crop_height: number | null;
  edit_flip_h: boolean;
  edit_flip_v: boolean;
  edit_straighten: number;
  edit_persp_h: number;
  edit_persp_v: number;
  edit_exposure: number;
  edit_contrast: number;
  edit_highlights: number;
  edit_shadows: number;
  edit_whites: number;
  edit_blacks: number;
  edit_saturation: number;
  edit_temperature: number;
  edit_tint: number;
  edit_color_mix: string | null; // JSON: { band: [hue, sat, lum] }
  edit_vignette: number;
  edit_distortion: number;
  edit_dehaze: number;
  edit_grain: number;
  edit_grain_size: number;
  edit_denoise: number;
  edit_clarity: number;
  edit_sharpness: number;
  edit_color_tint: number;
  edit_chrome_effect: number;
  edit_chrome_blue: number;
  edit_mist: number;
  tags: string[];
  album_ids: string[];
}

export interface TrashSettings {
  // Days a photo stays in the Trash before the automatic startup cleanup
  // deletes it for good; 0 = keep forever.
  retention_days: number;
}

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AlbumOut {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  image_count: number;
  immich_sync: boolean;
}

export interface ImportProgress {
  phase: "staging" | "commit" | "idle";
  processed: number;
  total: number;
  eta_seconds: number | null;
}

export interface ScannedFile {
  path: string;
  name: string;
  size: number;
}

export interface FolderScanOut {
  files: ScannedFile[];
  total_bytes: number;
}

export type ImportSessionStatus = "staging" | "committed" | "discarded";

export interface ImportSessionOut {
  id: string;
  source_path: string;
  status: ImportSessionStatus;
  created_at: string;
}

export interface StagedFileOut {
  id: string;
  original_filename: string;
  file_type: FileType;
  selected: boolean;
  rating: number;
  color_label: ColorLabel;
  duplicate_of_image_id: string | null;
  duplicate_of_staged_file_id: string | null;
  is_near_duplicate: boolean;
  paired_staged_file_id: string | null;
  taken_at: string | null;
  camera_make: string | null;
  camera_model: string | null;
  width: number | null;
  height: number | null;
  immich_sync: boolean;
}

export interface StagedFileUpdatePatch {
  selected?: boolean;
  rating?: number;
  color_label?: ColorLabel;
  immich_sync?: boolean;
}

export interface SearchResultOut {
  image: ImageOut;
  distance: number;
}

export type ImmichSyncMode = "manual" | "selective" | "full";

export interface ImmichSettings {
  base_url: string | null;
  api_key_set: boolean;
  sync_mode: ImmichSyncMode;
}

export interface ImmichTestResult {
  ok: boolean;
  message: string;
}

export interface ImmichUploadResult {
  filename: string;
  ok: boolean;
  detail: string;
  at: string;
}

export interface ImmichPushResult {
  uploaded: number;
  duplicate: number;
  skipped: number;
  failed: number;
  message: string;
}

export interface SourceRoot {
  id: string;
  name: string;
  path: string;
  created_at: string;
  last_scanned_at: string | null;
  image_count: number;
  scanning: boolean;
  // False when the source folder isn't currently reachable (external drive
  // unplugged / NAS unmounted); its photos are hidden from the library.
  available: boolean;
}

export interface ScanStatus {
  running: boolean;
  scanned: number;
  added: number;
  error: string | null;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  parent: string | null;
  exists: boolean;
  entries: DirEntry[];
}

export interface TagUsage {
  name: string;
  count: number;
}

// One photo in the library index: just enough to lay out and interact with a
// grid tile. The index endpoint returns the WHOLE filtered library in one
// slim response - the virtual grid computes every tile's position up front
// (exact scrollbar, jump anywhere) and fetches only thumbnails on demand.
export interface LibraryIndexImage {
  id: string;
  original_filename: string;
  file_type: FileType;
  width: number | null;
  height: number | null;
  taken_at: string | null;
  rating: number;
  color_label: ColorLabel;
  immich_sync: boolean;
  paired_image_id: string | null;
  source_root_id: string | null;
  // Server-computed equivalent of editVersion() - cache-buster for the
  // thumbnail URL that changes whenever the photo's edits change.
  thumb_version: string;
}

// One geotagged photo on the map, slim like the library index.
export interface GeoImage {
  id: string;
  lat: number;
  lon: number;
  paired_image_id: string | null;
  original_filename: string;
}

export interface LibraryFilters {
  view_mode: ViewMode;
  album_id?: string;
  rating_min?: number;
  color_label?: ColorLabel;
  camera_model?: string;
  // Region filter: a reverse-geocoded country name, or the "__none__" sentinel
  // for photos with no location.
  country?: string;
  date_from?: string;
  date_to?: string;
  tags?: string[];
  limit?: number;
}

export const NO_LOCATION = "__none__";

export interface Facet {
  value: string;
  count: number;
}

export interface LibraryFacets {
  cameras: Facet[];
  regions: Facet[];
  no_location_count: number;
}

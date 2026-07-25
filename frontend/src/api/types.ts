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
  edit_distortion: number; // lens distortion correction, geometric
  // The whole develop state (tonal/colour/effects/curves/grading/masks) as a
  // JSON string - see utils/adjustments.ts - or null when fully neutral. Parse
  // with adjustmentsFromImage().
  edit_adjustments: string | null;
  // Per-image cache-buster, bumped whenever the edit changes. editVersion()
  // returns String(edit_rev); the server is the single source of truth for it.
  edit_rev: number;
  tags: string[];
  album_ids: string[];
}

export interface TrashSettings {
  // Days a photo stays in the Trash before the automatic startup cleanup
  // deletes it for good; 0 = keep forever.
  retention_days: number;
}

export interface RawDecodeSettings {
  // True = load RAWs with no brightness processing (native sensor exposure).
  native_decode: boolean;
}

export interface AutoDevelopSettings {
  // Whether the editor shows the Auto develop button.
  enabled: boolean;
  // Which adjustment groups Auto may touch ("tone" | "white_balance" | "color"
  // | "details" | "curves" | "effects"); unchecked groups keep their current
  // slider values when Auto runs.
  enabled_groups: string[];
  // How many edited photos the suggestion can currently learn from.
  example_count: number;
}

// Which aspects a bulk reset should clear. Omitted flags use the server
// defaults: the three metadata flags default true, edits/albums false.
export interface BulkResetOptions {
  rating?: boolean; // stars
  color_label?: boolean; // colour label
  tags?: boolean;
  develop?: boolean; // the develop sliders (edit_adjustments)
  geometry?: boolean; // crop / rotation / straighten / flip / perspective
  albums?: boolean; // remove from every album
}

export interface BulkAutoDevelopResult {
  images: ImageOut[];
  // How many photos actually got a suggestion.
  applied: number;
  // How many were skipped (no embedding yet, or nothing similar to learn from).
  skipped: number;
}

export interface AutoAdjustResult {
  // A *partial* server-normalized develop object: only the fields of the
  // groups enabled in Settings. The editor spreads it over its current state.
  adjustments: Record<string, unknown>;
  // How many similar edited photos the suggestion was blended from.
  samples: number;
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
  // Up to 4 member ids (album order) for the card's mini mosaic preview.
  cover_image_ids: string[];
  immich_sync: boolean;
}

// A virtual, auto-computed album (similarity cluster, place or time group).
// The id is self-describing ("cluster:2", "year:2024", "month:2024-07",
// "day:2024-07-12", "place:48.1374,11.5755") and is what
// /smart-albums/{id}/images resolves.
export interface SmartAlbumOut {
  id: string;
  kind: "cluster" | "year" | "month" | "day" | "place" | "country" | "country_year" | "edits";
  name: string;
  image_count: number;
  cover_image_id: string | null;
  // Up to 4 member ids (newest first) for the card's mini mosaic preview.
  cover_image_ids: string[];
}

export interface SmartAlbumsOut {
  // "building" while the first cluster pass runs - poll until "ready".
  clusters_status: "building" | "ready";
  clusters: SmartAlbumOut[];
  places: SmartAlbumOut[];
  countries: SmartAlbumOut[];
  country_years: SmartAlbumOut[];
  years: SmartAlbumOut[];
  months: SmartAlbumOut[];
  days: SmartAlbumOut[];
  edits: SmartAlbumOut[];
}

// Which smart-album sections the Albums page shows + the place radius.
export interface SmartAlbumSettings {
  sections: string[];
  place_radius_km: number;
}

export interface ImportProgress {
  phase: "staging" | "commit" | "idle";
  // Staging: files whose background analysis finished, of `total` staged so
  // far. Commit: photos moved/recorded, of the commit plan.
  processed: number;
  total: number;
  // Staging only: files fully copied into the staging folder - runs ahead of
  // `processed` while the background analysis catches up.
  copied: number;
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
  // The matching library photo sits in the Trash: importing this file is
  // allowed and restores it (instead of being blocked as "already in library").
  duplicate_in_trash: boolean;
  paired_staged_file_id: string | null;
  taken_at: string | null;
  camera_make: string | null;
  camera_model: string | null;
  width: number | null;
  height: number | null;
  immich_sync: boolean;
  // False while the background analysis (thumbnail/EXIF/duplicates) is still
  // running for this file - the grid shows a placeholder card until it flips.
  processed: boolean;
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

export interface ImmichActivity {
  pending_uploads: number;
  sync_mode: ImmichSyncMode;
  // Sync progress: of the `total` JPEGs the current mode wants on Immich,
  // `synced` are known to be there already.
  synced: number;
  total: number;
  paused: boolean;
}

export interface BorgSettings {
  enabled: boolean;
  repo: string | null;
  passphrase_set: boolean;
  // Whether the `borg` binary is installed on this machine.
  available: boolean;
  // Live status of the background/manual backup runner.
  running: boolean;
  last_ok: boolean | null;
  last_message: string;
  last_archive: string | null;
  last_finished_at: string | null;
}

export interface BorgTestResult {
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

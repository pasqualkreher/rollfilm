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
  camera_make: string | null;
  camera_model: string | null;
  iso: number | null;
  aperture: number | null;
  shutter_speed: string | null;
  focal_length: number | null;
  gps_lat: number | null;
  gps_lon: number | null;
  rating: number;
  color_label: ColorLabel;
  paired_image_id: string | null;
  source_root_id: string | null;
  edit_rotation: number;
  edit_crop_x: number | null;
  edit_crop_y: number | null;
  edit_crop_width: number | null;
  edit_crop_height: number | null;
  tags: string[];
  album_ids: string[];
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
}

export interface StagedFileUpdatePatch {
  selected?: boolean;
  rating?: number;
  color_label?: ColorLabel;
}

export interface SearchResultOut {
  image: ImageOut;
  distance: number;
}

export interface ImmichSettings {
  base_url: string | null;
  api_key_set: boolean;
}

export interface ImmichTestResult {
  ok: boolean;
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

export interface LibraryFilters {
  view_mode: ViewMode;
  album_id?: string;
  rating_min?: number;
  color_label?: ColorLabel;
  camera_model?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
}

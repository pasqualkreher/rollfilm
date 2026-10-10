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
  lens_model: string | null;
  iso: number | null;
  aperture: number | null;
  shutter_speed: string | null;
  focal_length: number | null;
  gps_lat: number | null;
  gps_lon: number | null;
  gps_country: string | null;
  rating: number;
  color_label: ColorLabel;
  // Free-text note typed in the detail view; null when there is none.
  description: string | null;
  immich_sync: boolean;
  paired_image_id: string | null;
  source_root_id: string | null;
  // Set when this row is a virtual copy ("virtual copy") of another photo:
  // same file on disk, its own develop state.
  virtual_of_image_id?: string | null;
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

// What POST /images/:id/rename answers with: the renamed photo, plus what
// happened to its RAW/JPEG partner (renamed to the same stem by default).
export interface ImageRenameResult {
  image: ImageOut;
  // The partner's new name when it was renamed too, else null.
  paired_filename: string | null;
  // Set when the partner should have been renamed but couldn't be - the photo
  // itself still was, so this is a note rather than a failure.
  pair_error: string | null;
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

// What an import does with the picked files: copy them into the library
// folder, or leave them where they are and index the chosen ones in place.
export type ImportMode = "copy" | "reference";

// The answer to the import question: the mode, and for a copy where the
// session's import folder is created (null = "Import" in the library) and
// whether that folder is kept as a backup.
export interface ImportChoice {
  mode: ImportMode;
  stagingFolder: string | null;
  // Copy only: the import folder keeps every photo (the ones added to the
  // library are copied, not moved) and stays when the session closes.
  keepBackup: boolean;
  // The session's name; the source folder's name unless the user typed one.
  name: string;
}

export type ImportAfterCommit = "ask" | "keep" | "close";
export type ImportSelectDefault = "select" | "deselect";
export type ImportBackupDefault = "keep" | "delete";

export interface ImportSettings {
  // "ask" = the Import page asks each time; otherwise the remembered answer.
  mode_default: "ask" | ImportMode;
  // No longer read by the UI: a session stays open until the user closes it.
  after_commit: ImportAfterCommit;
  // Whether photos arriving in a review start out selected for import. The
  // backend applies it as each photo is staged.
  select_default: ImportSelectDefault;
  // Whether a copy session keeps its import folder as a backup: pre-selected
  // in the start dialog, and the answer when the dialog is skipped.
  backup_default: ImportBackupDefault;
  // Whether stars, colour labels, keywords and captions another program wrote
  // into the files (or .xmp sidecars beside them) come in with the photos.
  read_file_metadata: boolean;
}

export interface SidecarSettings {
  // Whether an .xmp sidecar beside each managed original is kept up to date
  // with the photo's stars, label, tags and note.
  enabled: boolean;
  // The "write them all now" pass: running, and how far it is.
  active: boolean;
  total: number;
  done: number;
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
  // Which ones got one - "apply auto edit and save copy" copies only those.
  applied_ids: string[];
}

// A background copy job (the grid's bulk Save copy, "Apply ... and save copy"):
// one photo after the other from its saved edits, polled for its count.
export interface CopyJobProgress {
  state: "running" | "ready" | "error" | "cancelled";
  done: number;
  written: number;
  skipped: number;
  total: number;
  error: string | null;
  created_ids: string[];
}

export interface AutoAdjustResult {
  // A *partial* server-normalized develop object: only the fields of the
  // groups enabled in Settings. The editor spreads it over its current state.
  adjustments: Record<string, unknown>;
  // How many similar edited photos the suggestion was blended from.
  samples: number;
}

export interface SegmentResult {
  // Which subject was looked for (sky, water, greenery, person, ...).
  subject: string;
  // The found region as a base64 8-bit grayscale PNG - soft, so it already
  // fades where the detection is uncertain. Stored verbatim in the semantic
  // sub-mask's `mask` parameter; the backend decodes and upsamples it at render
  // time (services/masks._semantic_field).
  mask: string;
  width: number;
  height: number;
  // Share of the frame the region covers (0..1).
  coverage: number;
  // The model's strongest evidence anywhere in the frame (0..1), and whether
  // that clears the "it's really there" bar. `found` is what the editor asks -
  // NOT coverage: distant people are unmistakably people and cover almost none
  // of the frame.
  peak: number;
  found: boolean;
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
  // Tag rule: photos carrying ANY of these tags are members automatically,
  // on top of the manually added ones. Empty = plain manual album.
  tag_filter: string[];
}

// --- Canvases: standalone design surfaces ----------------------------------
//
// Every measurement is in MILLIMETRES, never pixels: a layout is a page design
// that has to survive being printed, and the canvas zoom is only a way of
// looking at it. The renderer draws 1mm as one CSS unit inside a scaled
// container, so nothing in the component has to convert.

export interface LayoutTextStyle {
  // Cap height of the text, in mm, like a type size on a printed page.
  size_mm?: number;
  color?: string;
  weight?: number;
  italic?: boolean;
  align?: "left" | "center" | "right" | "justify";
  // Where the text sits in a box taller than it needs; omitted = top.
  valign?: "top" | "middle" | "bottom";
  // A CSS font-family stack; omitted = the app's own UI face.
  font?: string;
  // Line height as a multiple of the size; omitted = 1.25.
  line_height?: number;
  // Tracking in em, so it scales with the size; omitted = 0.
  letter_spacing?: number;
  // Photo frames only: a matte border ADDED around the frame, like the
  // editor's white frame - its width as a % of the frame's shorter edge, so
  // it scales with the picture, and its colour. Omitted = no border.
  frame_pct?: number;
  frame_color?: string;
}

export interface LayoutItem {
  id: string;
  kind: "photo" | "text";
  image_id: string | null;
  // Which sheet the item sits on; always 0 on an infinite canvas.
  page: number;
  // The frame: position of its top-left corner on the page, and its size.
  x_mm: number;
  y_mm: number;
  width_mm: number;
  height_mm: number;
  // Clockwise degrees around the frame's centre.
  rotation: number;
  z: number;
  // How the photo sits inside its frame. The photo always COVERS the frame
  // (so it can never be squashed); content_scale zooms it further and
  // content_dx/dy shift it, both as a fraction of the frame's own size.
  content_scale: number;
  content_dx: number;
  content_dy: number;
  text: string | null;
  style: LayoutTextStyle | null;
  // A frame whose photo was permanently deleted: it stays on the page as a
  // placeholder. Round-trips through saves so autosave never erases the gap.
  missing?: boolean;
  // False when the photo behind the frame is in the Trash or on an unplugged
  // drive: the item stays (and is saved back untouched) but has nothing to
  // draw, so the page returns intact once the photo does.
  available?: boolean;
}

// Just enough of a canvas's working layout to draw the overview card's paper
// preview - same shape the shelf's gallery cards use, minus the version
// bookkeeping. Null until the canvas has been saved once.
export interface CanvasPreview {
  page_mode: "pages" | "infinite";
  page_width_mm: number;
  page_height_mm: number;
  page_count: number;
  background: string;
  show_page_guide: boolean;
  items: LayoutItem[];
  // Per-photo cache-buster for thumbnail URLs (image id -> ?v value).
  thumb_versions: Record<string, string>;
}

// One canvas in the overview: name, size, when it last changed - and the
// working layout itself, so the overview shows the design, not a label.
export interface CanvasSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string | null;
  image_count: number;
  item_count: number;
  show_in_canvases: boolean;
  preview: CanvasPreview | null;
}

// One kept snapshot of a canvas, as the version list shows it. The document
// itself stays on the server - it only travels when restored.
export interface LayoutVersion {
  id: string;
  name: string;
  created_at: string;
}

export interface CanvasLayout {
  canvas_id: string;
  // "pages" = a run of fixed-size sheets, like a photo book;
  // "infinite" = one unbounded plane, like a pinboard.
  page_mode: "pages" | "infinite";
  page_width_mm: number;
  page_height_mm: number;
  page_count: number;
  background: string;
  show_grid: boolean;
  grid_mm: number;
  snap: boolean;
  // Page margins in mm: drawn as a guide on each sheet, a snap target, and
  // where the auto-layout flows photos. margin_mm is the left and right
  // margin (the name predates the split), margin_y_mm the top and bottom one.
  margin_mm: number;
  margin_y_mm: number;
  // Free canvas only: draw the outline of the sheets this design would be cut
  // into, so laying out against them makes a later switch to Pages a
  // relabelling rather than a redesign.
  show_page_guide: boolean;
  // Whether this canvas appears on the Canvases shelf of the Albums page.
  show_in_canvases: boolean;
  // The version the shelf shows (last kept or last loaded), and the kept
  // versions themselves, newest first. Server-owned: never sent back on save.
  active_version_id?: string | null;
  versions?: LayoutVersion[];
  updated_at?: string | null;
  items: LayoutItem[];
}

// One card on the Canvases shelf: a canvas's chosen version, with just enough
// of its document to draw the print-style preview.
export interface CanvasGalleryOut {
  canvas_id: string;
  canvas_name: string;
  version_id: string;
  version_name: string;
  version_count: number;
  created_at: string;
  page_mode: "pages" | "infinite";
  page_width_mm: number;
  page_height_mm: number;
  page_count: number;
  background: string;
  // A free canvas with the page guide on prints as the guide's sheets - the
  // shelf's print view and export cut the same way.
  show_page_guide: boolean;
  items: LayoutItem[];
  // Per-photo cache-buster for thumbnail URLs (image id -> ?v value).
  thumb_versions: Record<string, string>;
}

// A virtual, auto-computed album (similarity cluster, place or time group).
// The id is self-describing ("cluster:2", "year:2024", "month:2024-07",
// "day:2024-07-12", "place:48.1374,11.5755") and is what
// /smart-albums/{id}/images resolves.
export interface SmartAlbumOut {
  id: string;
  kind: "cluster" | "tag" | "year" | "month" | "day" | "place" | "country" | "country_year" | "edits";
  name: string;
  image_count: number;
  cover_image_id: string | null;
  // Up to 4 member ids (newest first) for the card's mini mosaic preview.
  cover_image_ids: string[];
  // Clusters only: base label shared by sibling moments ("Mountains" for
  // "Mountains · Alpine" / "Mountains · Mediterranean") - the Moments row
  // stacks a group under one expandable card.
  group?: string | null;
}

export interface SmartAlbumsOut {
  // "building" while the first cluster pass runs - poll until "ready".
  // "building" = very first cluster pass; "refreshing" = served clusters are
  // stale and a rebuild runs (e.g. embeddings backfilling after an import).
  clusters_status: "building" | "refreshing" | "ready";
  clusters: SmartAlbumOut[];
  // One album per tag ("albums by tag") - the "tags" section.
  tags: SmartAlbumOut[];
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

// Poll payload of a progress-reporting export job (mirrors ExportJobProgress
// in backend schemas.py). `filename` arrives with state "ready".
export interface ExportJobProgress {
  done: number;
  total: number;
  state: "running" | "ready" | "error" | "cancelled";
  filename: string | null;
  error: string | null;
  // A folder export: where the files went, how many were written (a photo
  // that could not be rendered is skipped), and one of them to point at.
  dest_dir: string | null;
  written: number;
  reveal_path: string | null;
}

export type ExportFormat = "jpeg" | "tiff" | "original";
export type ExportSharpen = "off" | "low" | "standard" | "high";
// What a rendered file says about itself: everything (camera data plus the
// library's stars, colour label and tags), the same without where it was
// taken, or nothing but the colour profile.
export type ExportMetadata = "all" | "no_location" | "none";

// The choices of the export dialog, as a preset stores them (mirrors
// ExportOptions in backend schemas.py).
export interface ExportOptions {
  format: ExportFormat;
  quality: number;
  max_size: number | null;
  metadata: ExportMetadata;
  name_template: string;
  // "download" asks where to save each time; "folder" writes into dest_dir.
  destination: "download" | "folder";
  dest_dir: string | null;
  // Finishing touches on the exported pixels only: sharpening for the size
  // the picture leaves at, and a line of text in a corner ("" = none).
  sharpen: ExportSharpen;
  watermark_text: string;
  watermark_corner: "tl" | "tr" | "bl" | "br";
  watermark_size: "small" | "medium" | "large";
  watermark_opacity: number;
}

export interface ExportPreset {
  name: string;
  options: ExportOptions;
}

export interface ExportSettings {
  presets: ExportPreset[];
  // What the dialog was last exported with; null before the first export.
  last: ExportOptions | null;
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
  // Bytes landed so far - copy rate/ETA are computed from bytes, so a tail
  // of big RAWs after small JPEGs doesn't make the estimate grow.
  copied_bytes: number;
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

// One folder a session copies from - it can collect from several.
export interface ImportSource {
  id: string;
  label: string;
  root: string;
  // Where it is reachable right now (the card can come back under another
  // mount name); null when it isn't connected.
  current_root: string | null;
  volume_name: string | null;
  // The folder, on the right volume, is reachable right now.
  available: boolean;
  copied: number;
  // Not copied yet as of its last scan; null when never scanned.
  remaining: number | null;
}

// An open import session as listed on the Import page, to continue it.
export interface ImportSessionSummary {
  id: string;
  source_path: string;
  mode: ImportMode;
  // Copy sessions: the import folder its cards are copied into.
  staging_dir: string | null;
  // That folder is a backup: it keeps every photo and stays on close.
  keep_backup: boolean;
  created_at: string;
  updated_at: string | null;
  file_count: number;
  imported_count: number;
  duplicate_count: number;
  selected_count: number;
  pending_count: number;
  sources: ImportSource[];
}

// One source in a rescan: what of it isn't copied yet. `id` is null for a
// folder that isn't part of the session yet (scanned before adding it).
export interface ImportRescanSource {
  id: string | null;
  label: string;
  root: string;
  available: boolean;
  files: ScannedFile[];
  total_bytes: number;
  file_count: number | null;
}

export interface ImportSessionRescan {
  sources: ImportRescanSource[];
}

export interface ImportSessionOut {
  id: string;
  source_path: string;
  mode: ImportMode;
  staging_dir: string | null;
  keep_backup?: boolean;
  source_root?: string | null;
  volume_name?: string | null;
  updated_at?: string | null;
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
  // The matching library photo sits in the Trash: importing this file is
  // allowed and restores it (instead of being blocked as "already in library").
  duplicate_in_trash: boolean;
  paired_staged_file_id: string | null;
  taken_at: string | null;
  camera_make: string | null;
  camera_model: string | null;
  width: number | null;
  height: number | null;
  // Camera settings from the analysis' EXIF record (the lightbox's info
  // panel); null before analysis or where the file lacks them.
  lens_model: string | null;
  iso: number | null;
  aperture: number | null;
  shutter_speed: string | null;
  focal_length: number | null;
  gps_lat: number | null;
  gps_lon: number | null;
  immich_sync: boolean;
  // Added to the library by an earlier partial import of this session - it
  // now reads as "already in library" (duplicate_of_image_id is that photo).
  imported: boolean;
  // RAW only: the background demosaiced grid thumbnail is ready. The grid
  // appends it to the img URL, so the card swaps from the fast embedded
  // camera thumb to the sensor-accurate render when it lands.
  has_demosaic_thumb: boolean;
  // False while the background analysis (thumbnail/EXIF/duplicates) is still
  // running for this file - the grid shows a placeholder card until it flips.
  processed: boolean;
}

// /files response: the staged list plus the session's change counter. When
// polled with the version the client already holds and nothing changed, the
// backend answers {version, unchanged: true} without loading anything.
export interface StagedFilesOut {
  version: number;
  unchanged: boolean;
  files: StagedFileOut[];
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
  // Master switch: false turns the whole integration off (uploads, sync loop,
  // import checkboxes) while the stored server/key/mode are kept.
  enabled: boolean;
  // Also upload RAW files (off by default: JPEGs only). A RAW follows its
  // paired JPEG; turning this off leaves already uploaded RAWs on Immich.
  include_raw: boolean;
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
  // False for a root an import created by leaving photos in place: not
  // scanned at startup, so only the photos chosen then are indexed.
  auto_scan: boolean;
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

// One labeled count in the stats dashboard (a camera, a year, a bucket).
// `key` is what gets sent back to pin the value as a filter; `lo`/`hi` are the
// bucket's numeric bounds where it has them (focal, ISO, aperture).
export interface StatCount {
  key: string;
  name: string;
  count: number;
  lo?: number | null;
  hi?: number | null;
}

// One pinned value per dimension on the statistics page (GET /stats/library
// query params). Bucket dimensions carry the bucket's key ("wide", "iso_400").
export interface StatsFilters {
  camera?: string;
  lens?: string;
  focal?: string;
  year?: string;
  month?: string;
  rating?: string;
  file_type?: string;
  iso?: string;
  aperture?: string;
  shutter?: string;
  country?: string;
}

// Aggregate snapshot for the statistics dashboard (GET /stats/library). The
// headline counts honour every pinned filter; each list is computed with its
// own dimension lifted, so the chart you clicked keeps its alternatives.
export interface LibraryStats {
  library_total_photos: number;
  available: string[];
  total_photos: number;
  total_bytes: number;
  raw_count: number;
  jpeg_count: number;
  pair_count: number;
  edited_count: number;
  with_gps_count: number;
  rated_count: number;
  camera_count: number;
  lens_count: number;
  cameras: StatCount[];
  lenses: StatCount[];
  countries: StatCount[];
  focal_buckets: StatCount[];
  isos: StatCount[];
  apertures: StatCount[];
  shutters: StatCount[];
  years: StatCount[];
  months: StatCount[];
  ratings: StatCount[];
  file_types: StatCount[];
  first_taken_at: string | null;
  last_taken_at: string | null;
}

// One photo in the library index: just enough to lay out and interact with a
// grid tile. The index endpoint returns the WHOLE filtered library in one
// slim response - the virtual grid computes every tile's position up front
// (exact scrollbar, jump anywhere) and fetches only thumbnails on demand.
// Of a set of photos: how many sit in at least one album, how many a canvas
// holds, and how many are in either (the two overlap). Asked before a delete.
export interface ImageUsage {
  in_album: number;
  in_canvas: number;
  in_any: number;
}

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
  // Set when this row is a virtual copy of another photo (no file of its own).
  virtual_of_image_id: string | null;
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
  // Photos a canvas holds (filmstrip members and placed frames).
  canvas_id?: string;
  rating_min?: number;
  color_label?: ColorLabel;
  camera_model?: string;
  lens_model?: string;
  // Focal-length range from the filter slider: bounds are facet values from
  // LibraryFacets.focal_lengths (formatted mm numbers like "23" or "8.8");
  // the backend parses them back. Unset side = unbounded.
  focal_min?: string;
  focal_max?: string;
  // The camera make ("FUJIFILM"), exact like the model.
  camera_make?: string;
  // The exposure sliders' bounds, facet values sent back as they came:
  // ISO ("400"), aperture ("2.8"), shutter speed in SECONDS ("0.004").
  iso_min?: string;
  iso_max?: string;
  aperture_min?: string;
  aperture_max?: string;
  shutter_min?: string;
  shutter_max?: string;
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

// One shutter-speed stop: the stored EXIF string and its exposure time in
// seconds (what the slider sorts, formats and sends back).
export interface ShutterFacet {
  value: string;
  count: number;
  seconds: number;
}

export interface LibraryFacets {
  cameras: Facet[];
  makes: Facet[];
  lenses: Facet[];
  // Distinct focal lengths as formatted mm numbers ("23", "8.8").
  focal_lengths: Facet[];
  // The exposure sliders' stops, ascending: ISO ("400"), aperture ("2.8").
  isos: Facet[];
  apertures: Facet[];
  shutters: ShutterFacet[];
  regions: Facet[];
  no_location_count: number;
}

// Folding another Rollfilm library (a drive taken travelling) into this one -
// see the "Import a library" section of the import screen.
export interface LibraryMergeSummary {
  library_root: string;
  // Photos the other library would hand over (its Trash and any photos it only
  // indexes in place from an external drive stay behind).
  photos: number;
  // Not in this library yet - these get copied in.
  new_photos: number;
  // Already here byte for byte; only the review work done on them travels.
  known_photos: number;
  bytes_to_copy: number;
  albums: number;
  tags: number;
}

export interface LibraryMergeResult {
  added: number;
  updated: number;
  skipped: number;
  copied_bytes: number;
  // Stopped by the user rather than run to the end. What already came across
  // stays; running it again picks up where it left off.
  canceled: boolean;
}

export interface LibraryMergeProgress {
  active: boolean;
  total: number;
  done: number;
  copied_bytes: number;
  // Null until enough photos have finished to measure a rate from.
  eta_seconds: number | null;
  // Outcome of the last finished run - still here after leaving the screen.
  result: LibraryMergeResult | null;
  error: string | null;
}

// One of the user's own tags with how many photos (outside the Trash) carry
// it - the Settings list that deletes a tag from every photo at once.
export interface TagUsage {
  // The full path: "Travel/Italy/Rome" is Rome filed under Italy under Travel.
  name: string;
  count: number;
  // From an imported keyword list: stays without photos until deleted.
  kept: boolean;
}

export interface TagImportResult {
  created: number;
  existing: number;
}

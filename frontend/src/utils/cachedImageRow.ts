import type { QueryClient } from "@tanstack/react-query";
import type { ImageOut, LibraryIndexImage } from "../api/types";

// The photo view's first render used to wait for /images/{id} even though the
// grid it was opened from had just drawn that very photo - a "Loading…" page
// for the length of a round-trip, on the most common step in the app. This
// finds the photo's row in whatever grid data is cached (the library index,
// an album's or smart album's list, the trash) so the view can start from it.
//
// A full ImageOut (album lists, search, trash) is used as is. The library
// index carries slim rows without the edit fields; those are filled with the
// neutral values and the caller treats the record as "edits unknown" until
// the real one lands - see ImageDetail's `seeded`. What matters is that the
// preview URL is right from the first frame: editVersion() is
// String(edit_rev), and the index's thumb_version is the server's rendering
// of the same number, so the two URLs are identical and the image request
// goes out once.
export function cachedImageRow(queryClient: QueryClient, id: string): ImageOut | undefined {
  let slim: LibraryIndexImage | undefined;
  for (const prefix of [["images"], ["smart-album-images"], ["trash"]]) {
    for (const [, data] of queryClient.getQueriesData<unknown>({ queryKey: prefix })) {
      const rows = rowsOf(data);
      if (!rows) continue;
      const row = rows.find((r) => r.id === id);
      if (!row) continue;
      if (isFull(row)) return row;
      slim ??= row;
    }
  }
  return slim ? fromIndexRow(slim) : undefined;
}

function rowsOf(data: unknown): Array<ImageOut | LibraryIndexImage> | null {
  if (Array.isArray(data)) return data as Array<ImageOut | LibraryIndexImage>;
  if (data && typeof data === "object" && Array.isArray((data as { images?: unknown }).images)) {
    return (data as { images: Array<ImageOut | LibraryIndexImage> }).images;
  }
  return null;
}

function isFull(row: ImageOut | LibraryIndexImage): row is ImageOut {
  return typeof (row as ImageOut).edit_rev === "number";
}

function fromIndexRow(row: LibraryIndexImage): ImageOut {
  return {
    id: row.id,
    original_filename: row.original_filename,
    file_type: row.file_type,
    raw_format: null,
    width: row.width,
    height: row.height,
    taken_at: row.taken_at,
    imported_at: "",
    deleted_at: null,
    camera_make: null,
    camera_model: null,
    lens_model: null,
    iso: null,
    aperture: null,
    shutter_speed: null,
    focal_length: null,
    gps_lat: null,
    gps_lon: null,
    gps_country: null,
    rating: row.rating,
    color_label: row.color_label,
    description: null,
    immich_sync: row.immich_sync,
    paired_image_id: row.paired_image_id,
    source_root_id: row.source_root_id,
    virtual_of_image_id: row.virtual_of_image_id,
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
    edit_distortion: 0,
    edit_adjustments: null,
    edit_rev: Number(row.thumb_version) || 0,
    tags: [],
    album_ids: [],
  };
}

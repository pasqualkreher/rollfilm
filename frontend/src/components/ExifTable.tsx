import { formatShutterSpeed } from "../utils/photoMeta";

// The fields the table shows. Both a library photo (ImageOut) and a photo in
// the import review (StagedFileOut) carry them.
export interface ExifFields {
  taken_at: string | null;
  camera_make: string | null;
  camera_model: string | null;
  lens_model?: string | null;
  width: number | null;
  height: number | null;
  iso?: number | null;
  aperture?: number | null;
  shutter_speed?: string | null;
  focal_length?: number | null;
}

// The photo's capture info as a two-column table: the library photo view's
// "Info" section and the import lightbox's "Camera settings" panel.
export function ExifTable({ image }: { image: ExifFields }) {
  const camera = [image.camera_make, image.camera_model].filter(Boolean).join(" ");
  return (
    <table className="exif-table">
      <tbody>
        <tr>
          <td>Taken</td>
          <td>{image.taken_at ? new Date(image.taken_at).toLocaleString() : "—"}</td>
        </tr>
        <tr>
          <td>Camera</td>
          <td>{camera || "—"}</td>
        </tr>
        <tr>
          <td>Lens</td>
          <td>{image.lens_model ?? "—"}</td>
        </tr>
        <tr>
          <td>Dimensions</td>
          <td>{image.width && image.height ? `${image.width}×${image.height}` : "—"}</td>
        </tr>
        <tr>
          <td>ISO</td>
          <td>{image.iso ?? "—"}</td>
        </tr>
        <tr>
          <td>Aperture</td>
          <td>{image.aperture ? `f/${image.aperture}` : "—"}</td>
        </tr>
        <tr>
          <td>Shutter</td>
          <td>{formatShutterSpeed(image.shutter_speed ?? null)}</td>
        </tr>
        <tr>
          <td>Focal length</td>
          <td>{image.focal_length ? `${image.focal_length}mm` : "—"}</td>
        </tr>
      </tbody>
    </table>
  );
}

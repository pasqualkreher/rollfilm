import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, editVersion } from "../api/client";
import { RatingStars } from "../components/RatingStars";
import { ColorLabelPicker } from "../components/ColorLabelPicker";
import { ImageEditor } from "../components/ImageEditor";
import { TagEditor } from "../components/TagEditor";
import { AlbumPicker } from "../components/AlbumPicker";
import { useSelects } from "../state/selects";
import type { ColorLabel } from "../api/types";

export function ImageDetail() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState(id!);
  const [editorOpen, setEditorOpen] = useState(false);
  const [bgMode, setBgMode] = useState<"light" | "dark">("light");
  const selects = useSelects();

  // Passed from the Library grid so arrow keys can zap through the same
  // filtered/ordered set of photos you were browsing, not the whole library.
  const imageIds = (location.state as { imageIds?: string[] } | null)?.imageIds;

  // The route param changes on arrow-key navigation (same component instance,
  // React Router just re-renders it) - activeId must follow it, or the RAW/JPEG
  // toggle state from the previous photo would stick around on the new one.
  useEffect(() => {
    setActiveId(id!);
  }, [id]);

  const { data: image } = useQuery({
    queryKey: ["image", activeId],
    queryFn: () => api.images.get(activeId),
    enabled: !!activeId,
  });

  const { data: paired } = useQuery({
    queryKey: ["image", image?.paired_image_id],
    queryFn: () => api.images.get(image!.paired_image_id!),
    enabled: !!image?.paired_image_id,
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (editorOpen) return;

      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && image && paired) {
        setActiveId(activeId === image.id ? paired.id : image.id);
        return;
      }

      if (!imageIds || imageIds.length === 0) return;
      const currentIndex = imageIds.indexOf(id!);
      if (currentIndex === -1) return;
      if (e.key === "ArrowLeft" && currentIndex > 0) {
        navigate(`/image/${imageIds[currentIndex - 1]}`, { replace: true, state: { imageIds } });
      } else if (e.key === "ArrowRight" && currentIndex < imageIds.length - 1) {
        navigate(`/image/${imageIds[currentIndex + 1]}`, { replace: true, state: { imageIds } });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [imageIds, id, navigate, editorOpen, image, paired, activeId]);

  const { data: similar } = useQuery({
    queryKey: ["similar", activeId],
    queryFn: () => api.images.similar(activeId),
    enabled: !!activeId,
  });

  if (!image) return <div className="page empty-state">Loading...</div>;

  async function setRating(rating: number) {
    await api.images.update(image!.id, { rating });
    queryClient.invalidateQueries({ queryKey: ["image", activeId] });
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  async function setColor(color_label: ColorLabel) {
    await api.images.update(image!.id, { color_label });
    queryClient.invalidateQueries({ queryKey: ["image", activeId] });
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  async function addTag(name: string) {
    await api.images.addTag(image!.id, name);
    queryClient.invalidateQueries({ queryKey: ["image", activeId] });
    queryClient.invalidateQueries({ queryKey: ["tags"] });
  }

  async function removeTag(name: string) {
    await api.images.removeTag(image!.id, name);
    queryClient.invalidateQueries({ queryKey: ["image", activeId] });
  }

  async function addToAlbum(albumId: string) {
    await api.albums.addImages(albumId, [image!.id]);
    queryClient.invalidateQueries({ queryKey: ["image", activeId] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  async function removeFromAlbum(albumId: string) {
    await api.albums.removeImage(albumId, image!.id);
    queryClient.invalidateQueries({ queryKey: ["image", activeId] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  return (
    <div className="page detail-page">
      <button className="btn" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <div className="detail-layout" style={{ marginTop: 16 }}>
        <div style={{ flex: "999 1 400px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div className={`detail-image${bgMode === "dark" ? " detail-image-dark" : ""}`}>
            <img
              className={bgMode === "dark" ? "framed" : undefined}
              src={api.images.previewUrl(image.id, editVersion(image))}
              alt={image.original_filename}
            />
          </div>
          <span className="segmented" style={{ alignSelf: "center" }}>
            <button className={bgMode === "light" ? "active" : ""} onClick={() => setBgMode("light")}>
              Light background
            </button>
            <button className={bgMode === "dark" ? "active" : ""} onClick={() => setBgMode("dark")}>
              Black background
            </button>
          </span>
        </div>
        <div className="detail-panel">
          <h3 className="section-title">{image.original_filename}</h3>

          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <button className="btn" onClick={() => setEditorOpen(true)}>
              Rotate / crop
            </button>
            <button
              className={`btn${selects.has(image.id) ? " primary" : ""}`}
              onClick={() => selects.toggle(image!.id)}
            >
              {selects.has(image.id) ? "✓ In selects" : "+ Add to selects"}
            </button>
          </div>

          {paired && (
            <div style={{ marginBottom: 16 }}>
              <span className="segmented">
                {/* Render the pair in a fixed order (RAW then JPEG) so the two
                    buttons keep their positions and the highlight tracks the
                    active file - `image` is always the *active* one, so mapping
                    [image, paired] directly would swap the labels on each toggle. */}
                {[image, paired]
                  .sort((a, b) => {
                    const rank = (t: string) => (t === "raw" ? 0 : 1);
                    return rank(a.file_type) - rank(b.file_type) || a.id.localeCompare(b.id);
                  })
                  .map((member) => (
                    <button
                      key={member.id}
                      className={activeId === member.id ? "active" : ""}
                      onClick={() => setActiveId(member.id)}
                    >
                      {member.file_type.toUpperCase()}
                    </button>
                  ))}
              </span>
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <RatingStars rating={image.rating} onChange={setRating} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <ColorLabelPicker value={image.color_label} onChange={setColor} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <TagEditor tags={image.tags} onAdd={addTag} onRemove={removeTag} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <AlbumPicker onAdd={addToAlbum} currentAlbumIds={image.album_ids} onRemove={removeFromAlbum} />
          </div>

          <table className="exif-table">
            <tbody>
              <tr>
                <td>Taken</td>
                <td>{image.taken_at ? new Date(image.taken_at).toLocaleString() : "—"}</td>
              </tr>
              <tr>
                <td>Camera</td>
                <td>
                  {image.camera_make} {image.camera_model}
                </td>
              </tr>
              <tr>
                <td>Dimensions</td>
                <td>
                  {image.width}×{image.height}
                </td>
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
                <td>{image.shutter_speed ?? "—"}</td>
              </tr>
              <tr>
                <td>Focal length</td>
                <td>{image.focal_length ? `${image.focal_length}mm` : "—"}</td>
              </tr>
            </tbody>
          </table>

          <a className="btn" href={api.images.originalUrl(image.id)} style={{ display: "block", marginTop: 16, textAlign: "center" }}>
            Download original
          </a>

          {similar && similar.length > 0 && (
            <>
              <h4 className="section-title" style={{ marginTop: 24 }}>
                Similar photos
              </h4>
              <div className="thumbnail-grid similar-grid">
                {similar.map((r) => (
                  <div
                    key={r.image.id}
                    className="thumb-card"
                    onClick={() => navigate(`/image/${r.image.id}`)}
                  >
                    <img
                      src={api.images.thumbnailUrl(r.image.id, editVersion(r.image))}
                      alt={r.image.original_filename}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {editorOpen && <ImageEditor image={image} onClose={() => setEditorOpen(false)} />}
    </div>
  );
}

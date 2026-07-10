import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, editVersion } from "../api/client";
import { RatingStars } from "../components/RatingStars";
import { ColorLabelPicker } from "../components/ColorLabelPicker";
import { PhotoEditor } from "../components/PhotoEditor";
import { TagEditor } from "../components/TagEditor";
import { AlbumPicker } from "../components/AlbumPicker";
import { useSelects } from "../state/selects";
import { useMergePairs } from "../state/viewPrefs";
import type { ColorLabel } from "../api/types";

export function ImageDetail() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState(id!);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [bgMode, setBgMode] = useState<"light" | "dark">("light");
  const mergePairs = useMergePairs();
  // Click-to-zoom loupe: click toggles a 2.5x zoom centred on the click point,
  // then moving the mouse pans (transform-origin follows the cursor).
  const [zoomed, setZoomed] = useState(false);
  const [zoomOrigin, setZoomOrigin] = useState({ x: 50, y: 50 });
  const selects = useSelects();

  const ZOOM_SCALE = 2.5;

  function cursorOrigin(e: ReactMouseEvent<HTMLImageElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    };
  }

  // Passed from the Library grid so arrow keys can zap through the same
  // filtered/ordered set of photos you were browsing, not the whole library.
  const imageIds = (location.state as { imageIds?: string[] } | null)?.imageIds;

  // The route param changes on arrow-key navigation (same component instance,
  // React Router just re-renders it) - activeId must follow it, or the RAW/JPEG
  // toggle state from the previous photo would stick around on the new one.
  useEffect(() => {
    setActiveId(id!);
  }, [id]);

  // Drop back to fit-view whenever the shown photo changes (arrow-key nav or
  // the RAW/JPEG toggle), so a new image never opens already zoomed-in.
  useEffect(() => {
    setZoomed(false);
  }, [activeId]);

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

  // "Add to Immich" only shows when the integration is configured in Settings.
  const { data: immich } = useQuery({ queryKey: ["immich-settings"], queryFn: () => api.settings.getImmich() });
  const immichConfigured = Boolean(immich?.base_url && immich?.api_key_set);
  const [immichBusy, setImmichBusy] = useState(false);
  const [immichMsg, setImmichMsg] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (adjustOpen) return;

      // Esc closes the lightbox - but first step out of a zoomed-in loupe if the
      // photo is currently zoomed, so one press doesn't do both.
      if (e.key === "Escape") {
        if (zoomed) setZoomed(false);
        else navigate(-1);
        return;
      }

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
  }, [imageIds, id, navigate, adjustOpen, image, paired, activeId, zoomed]);

  const { data: similar } = useQuery({
    queryKey: ["similar", activeId],
    queryFn: () => api.images.similar(activeId),
    enabled: !!activeId,
  });

  if (!image) return <div className="page empty-state">Loading...</div>;

  // With "Merge RAW+JPG" on, rating/coloring the shown file also writes the
  // partner - and we refresh its cached copy so the other tab reflects it.
  function invalidateActiveAndPair() {
    queryClient.invalidateQueries({ queryKey: ["image", activeId] });
    if (mergePairs && image!.paired_image_id) {
      queryClient.invalidateQueries({ queryKey: ["image", image!.paired_image_id] });
    }
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }

  async function setRating(rating: number) {
    await api.images.update(image!.id, { rating, apply_to_pair: mergePairs });
    invalidateActiveAndPair();
  }

  async function setColor(color_label: ColorLabel) {
    await api.images.update(image!.id, { color_label, apply_to_pair: mergePairs });
    invalidateActiveAndPair();
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

  async function addToImmich() {
    if (!image) return;
    setImmichBusy(true);
    setImmichMsg(null);
    // Push both halves of a pair so the JPEG is uploaded regardless of which is
    // shown (the backend skips RAW files itself).
    const ids = paired ? [image.id, paired.id] : [image.id];
    try {
      const result = await api.images.pushToImmich(ids);
      setImmichMsg(result.message);
    } catch (e) {
      setImmichMsg((e as Error).message);
    } finally {
      setImmichBusy(false);
    }
  }

  async function deletePhoto() {
    if (!image) return;
    // A RAW+JPEG pair is one shot - delete both halves so we never leave an
    // orphaned RAW (or JPEG) behind.
    const ids = paired ? [image.id, paired.id] : [image.id];
    const what = ids.length > 1 ? "this RAW+JPEG shot (2 files)" : "this photo";
    if (!window.confirm(`Delete ${what}? This removes the original file(s) too - it can't be undone.`)) {
      return;
    }
    await api.images.bulkDelete(ids);
    ids.forEach((delId) => selects.has(delId) && selects.remove(delId));
    queryClient.invalidateQueries({ queryKey: ["images"] });

    // Move to the next remaining photo in the set you were browsing; if none is
    // left (or we arrived here without a set), fall back to where we came from.
    if (imageIds && imageIds.length > 0) {
      const remaining = imageIds.filter((x) => !ids.includes(x));
      if (remaining.length > 0) {
        const currentIndex = imageIds.indexOf(id!);
        const next =
          remaining.find((x) => imageIds.indexOf(x) > currentIndex) ?? remaining[remaining.length - 1];
        navigate(`/image/${next}`, { replace: true, state: { imageIds: remaining } });
        return;
      }
    }
    navigate(-1);
  }

  return (
    <div className="page detail-page">
      <button className="icon-btn back-btn" onClick={() => navigate(-1)} title="Back (Esc)" aria-label="Back">
        ←
      </button>
      <div className="detail-layout" style={{ marginTop: 16 }}>
        <div style={{ flex: "999 1 400px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div className={`detail-image${bgMode === "dark" ? " detail-image-dark" : ""}`}>
            <img
              className={`detail-photo${bgMode === "dark" ? " framed" : ""}${zoomed ? " zoomed" : ""}`}
              style={{
                transform: zoomed ? `scale(${ZOOM_SCALE})` : undefined,
                transformOrigin: `${zoomOrigin.x}% ${zoomOrigin.y}%`,
              }}
              src={api.images.previewUrl(image.id, editVersion(image))}
              alt={image.original_filename}
              onClick={(e) => {
                setZoomOrigin(cursorOrigin(e));
                setZoomed((z) => !z);
              }}
              onMouseMove={(e) => {
                if (zoomed) setZoomOrigin(cursorOrigin(e));
              }}
            />
          </div>
          <div className="detail-image-toolbar">
            <span className="segmented">
              <button className={bgMode === "light" ? "active" : ""} onClick={() => setBgMode("light")}>
                Light background
              </button>
              <button className={bgMode === "dark" ? "active" : ""} onClick={() => setBgMode("dark")}>
                Black background
              </button>
            </span>
            <span className="detail-zoom-hint">
              {zoomed ? "Click to zoom out · move to pan" : "Click photo to zoom"}
            </span>
          </div>
        </div>
        <div className="detail-panel">
          <h3 className="section-title">{image.original_filename}</h3>

          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <button className="btn primary" onClick={() => setAdjustOpen(true)}>
              Edit
            </button>
            <button
              className={`btn${selects.has(image.id) ? " primary" : ""}`}
              onClick={() => selects.toggle(image!.id)}
            >
              {selects.has(image.id) ? "✓ In selects" : "+ Add to selects"}
            </button>
            {immichConfigured && (
              <button
                className="btn"
                onClick={addToImmich}
                disabled={immichBusy}
                title="Upload this photo's JPEG to your configured Immich server (RAW is skipped)"
              >
                {immichBusy ? "Uploading..." : "Add to Immich"}
              </button>
            )}
            <button
              className="btn"
              style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
              onClick={deletePhoto}
              title="Delete this photo (and its RAW/JPEG partner) - removes the original file too"
            >
              Delete
            </button>
          </div>
          {immichMsg && (
            <p style={{ color: "var(--text-muted)", marginTop: -8, marginBottom: 16 }}>{immichMsg}</p>
          )}

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
                    // Replace (don't push) so exploring similars doesn't stack
                    // history - one Back returns straight to the grid you came
                    // from instead of walking back through each similar you viewed.
                    onClick={() =>
                      navigate(`/image/${r.image.id}`, { replace: true, state: { imageIds } })
                    }
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

      {adjustOpen && <PhotoEditor image={image} onClose={() => setAdjustOpen(false)} />}
    </div>
  );
}

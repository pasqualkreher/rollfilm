import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
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
import { deleteConfirmMessage } from "../utils/deleteMessage";
import type { ColorLabel } from "../api/types";

// exiftool delivers the exposure time as a plain decimal ("0.003571428571");
// photographers read shutter speeds as fractions ("1/280") or whole seconds.
function formatShutterSpeed(value: string | null): string {
  if (!value) return "—";
  const secs = Number(value);
  if (!isFinite(secs) || secs <= 0) return value; // already "1/280"-style or unparseable
  if (secs >= 1) return `${Number(secs.toFixed(1))}s`;
  return `1/${Math.round(1 / secs)}`;
}

export function ImageDetail() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState(id!);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [bgMode, setBgMode] = useState<"light" | "dark">("light");
  const mergePairs = useMergePairs();
  // Scroll / trackpad-pinch to zoom (toward the cursor), drag to pan. scale 1 =
  // fit; pan is a pixel translation applied before the scale.
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Swap the preview for the full-resolution render once the user zooms in, so
  // 100% shows true original pixels instead of an upscaled preview. If the
  // full render can't be fetched we fall back to the preview (never a broken img).
  const [hiRes, setHiRes] = useState(false);
  const [fullFailed, setFullFailed] = useState(false);
  const imageBoxRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const selects = useSelects();

  const MAX_ZOOM = 6;
  const zoomed = scale > 1.001;

  function resetZoom() {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }

  // Passed from the Library grid so arrow keys can zap through the same
  // filtered/ordered set of photos you were browsing, not the whole library.
  const imageIds = (location.state as { imageIds?: string[] } | null)?.imageIds;
  // Where the back arrow should lead. Set e.g. after "Save copy" (which jumps
  // here directly) so back goes to the Library instead of replaying history.
  const backTo = (location.state as { backTo?: string } | null)?.backTo;

  function goBack() {
    if (backTo) navigate(backTo);
    else navigate(-1);
  }

  // The route param changes on arrow-key navigation (same component instance,
  // React Router just re-renders it) - activeId must follow it, or the RAW/JPEG
  // toggle state from the previous photo would stick around on the new one.
  useEffect(() => {
    setActiveId(id!);
  }, [id]);

  // Drop back to fit-view whenever the shown photo changes (arrow-key nav or
  // the RAW/JPEG toggle), so a new image never opens already zoomed-in.
  useEffect(() => {
    resetZoom();
    setHiRes(false);
    setFullFailed(false);
  }, [activeId]);

  // Once zoomed in, upgrade to the full-resolution render (loaded lazily) unless
  // it already failed for this photo.
  useEffect(() => {
    if (zoomed && !fullFailed) setHiRes(true);
  }, [zoomed, fullFailed]);

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

  // Scroll / pinch to zoom toward the cursor. A native, non-passive listener so
  // we can preventDefault - otherwise ctrl+wheel (trackpad pinch) would zoom the
  // whole app and a plain wheel would scroll the page. Keyed to image?.id so it
  // (re)attaches once the .detail-image element actually mounts - the component
  // early-returns a loading state before the photo is ready.
  useEffect(() => {
    const el = imageBoxRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      setScale((prevScale) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const next = Math.min(MAX_ZOOM, Math.max(1, prevScale * factor));
        setPan((prevPan) => {
          if (next <= 1.001) return { x: 0, y: 0 };
          const ratio = next / prevScale;
          return { x: dx - (dx - prevPan.x) * ratio, y: dy - (dy - prevPan.y) * ratio };
        });
        return next;
      });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [image?.id]);

  // "Add to Immich" only shows when the integration is configured in Settings.
  const { data: immich } = useQuery({ queryKey: ["immich-settings"], queryFn: () => api.settings.getImmich() });
  const immichConfigured = Boolean(immich?.base_url && immich?.api_key_set);
  const [immichBusy, setImmichBusy] = useState(false);
  const [immichMsg, setImmichMsg] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (adjustOpen) return;

      // Esc closes the lightbox - but first drop back to fit if zoomed in, so
      // one press doesn't do both.
      if (e.key === "Escape") {
        if (zoomed) resetZoom();
        else goBack();
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

  // With merged pairs the photo stands for the whole RAW+JPEG shot, so album
  // membership changes cover the hidden partner too.
  function idsWithPair(): string[] {
    return mergePairs && image!.paired_image_id ? [image!.id, image!.paired_image_id] : [image!.id];
  }

  async function addToAlbum(albumId: string) {
    await api.albums.addImages(albumId, idsWithPair());
    queryClient.invalidateQueries({ queryKey: ["image", activeId] });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
  }

  async function removeFromAlbum(albumId: string) {
    await Promise.all(idsWithPair().map((x) => api.albums.removeImage(albumId, x)));
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
    const items = paired ? [image, paired] : [image];
    if (!window.confirm(deleteConfirmMessage(items))) {
      return;
    }
    await api.images.bulkDelete(ids);
    ids.forEach((delId) => selects.has(delId) && selects.remove(delId));
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["trash"] });

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
    goBack();
  }

  return (
    <div className="page detail-page">
      <button className="icon-btn back-btn" onClick={goBack} title="Back (Esc)" aria-label="Back">
        ←
      </button>
      <div className="detail-layout" style={{ marginTop: 16 }}>
        <div style={{ flex: "999 1 400px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div className={`detail-image${bgMode === "dark" ? " detail-image-dark" : ""}`} ref={imageBoxRef}>
            <img
              className={`detail-photo${bgMode === "dark" ? " framed" : ""}${zoomed ? " zoomed" : ""}`}
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                cursor: zoomed ? (dragRef.current ? "grabbing" : "grab") : "default",
              }}
              draggable={false}
              src={
                hiRes
                  ? api.images.fullUrl(image.id, editVersion(image))
                  : api.images.previewUrl(image.id, editVersion(image))
              }
              alt={image.original_filename}
              onError={() => {
                // Full render unavailable - fall back to the preview so the
                // photo never shows as a broken image.
                if (hiRes) {
                  setFullFailed(true);
                  setHiRes(false);
                }
              }}
              onMouseDown={(e: ReactMouseEvent<HTMLImageElement>) => {
                if (!zoomed) return;
                e.preventDefault();
                dragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
              }}
              onMouseMove={(e: ReactMouseEvent<HTMLImageElement>) => {
                if (!dragRef.current) return;
                setPan({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y });
              }}
              onMouseUp={() => {
                dragRef.current = null;
              }}
              onMouseLeave={() => {
                dragRef.current = null;
              }}
              onDoubleClick={(e: ReactMouseEvent<HTMLImageElement>) => {
                // Lightroom-style: double-click toggles fit <-> 100% at the cursor.
                const box = imageBoxRef.current!.getBoundingClientRect();
                const dx = e.clientX - (box.left + box.width / 2);
                const dy = e.clientY - (box.top + box.height / 2);
                if (zoomed) {
                  resetZoom();
                } else {
                  const img = e.currentTarget;
                  const target = Math.min(MAX_ZOOM, Math.max(1.5, img.naturalWidth / img.getBoundingClientRect().width));
                  setScale(target);
                  setPan({ x: dx * (1 - target), y: dy * (1 - target) });
                }
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
              {zoomed ? "Drag to pan · double-click or Esc to fit" : "Scroll, pinch, or double-click to zoom"}
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
              className="btn danger"
              onClick={deletePhoto}
              title="Delete this photo (and its RAW/JPEG partner) - library photos move to the Trash, external photos are only removed from the catalog"
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

          <div className="detail-section">
            <div className="detail-section-label">Rating</div>
            <RatingStars rating={image.rating} onChange={setRating} />
          </div>
          <div className="detail-section">
            <div className="detail-section-label">Color label</div>
            <ColorLabelPicker value={image.color_label} onChange={setColor} />
          </div>
          <div className="detail-section">
            <div className="detail-section-label">Tags</div>
            <TagEditor tags={image.tags} onAdd={addTag} onRemove={removeTag} />
          </div>
          <div className="detail-section">
            <div className="detail-section-label">Albums</div>
            <AlbumPicker onAdd={addToAlbum} currentAlbumIds={image.album_ids} onRemove={removeFromAlbum} />
          </div>

          <div className="detail-section">
            <div className="detail-section-label">Info</div>
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
                <td>{formatShutterSpeed(image.shutter_speed)}</td>
              </tr>
              <tr>
                <td>Focal length</td>
                <td>{image.focal_length ? `${image.focal_length}mm` : "—"}</td>
              </tr>
            </tbody>
          </table>

            <a
              className="btn"
              href={api.images.originalUrl(image.id)}
              style={{ display: "block", marginTop: 14, textAlign: "center" }}
            >
              Download original
            </a>
          </div>

          {similar && similar.length > 0 && (
            <div className="detail-section">
              <div className="detail-section-label">Similar photos</div>
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
            </div>
          )}
        </div>
      </div>

      {adjustOpen && <PhotoEditor image={image} onClose={() => setAdjustOpen(false)} />}
    </div>
  );
}

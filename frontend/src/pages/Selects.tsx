import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import { api, editVersion } from "../api/client";
import type { ImageOut } from "../api/types";
import { useSelects } from "../state/selects";

export function Selects() {
  const { ids, count, remove, clear } = useSelects();
  const navigate = useNavigate();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One query per selected id; deleted photos simply resolve to nothing and are
  // filtered out below so the list never shows a broken tile.
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["image", id],
      queryFn: () => api.images.get(id),
    })),
  });

  const images = results
    .map((r) => r.data)
    .filter((img): img is ImageOut => Boolean(img));

  async function downloadAll() {
    if (count === 0) return;
    setDownloading(true);
    setError(null);
    try {
      await api.images.downloadZip(ids);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="page">
      <h2 className="section-title">
        Selects
        <span className="count-pill">{count} photos</span>
      </h2>

      {count === 0 ? (
        <div className="empty-state">
          No selects yet. Gather photos from the library, an album, or a photo's page to collect the shots you want to
          edit or download.
        </div>
      ) : (
        <>
          <div className="filter-bar">
            <button className="btn primary" onClick={downloadAll} disabled={downloading}>
              {downloading ? "Preparing zip..." : `Download all (${count})`}
            </button>
            <button className="btn ghost" onClick={clear}>
              Clear selects
            </button>
            {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
          </div>

          <div className="thumbnail-grid">
            {images.map((image) => (
              <div key={image.id} className="thumb-card">
                <img
                  src={api.images.thumbnailUrl(image.id, editVersion(image))}
                  loading="lazy"
                  alt={image.original_filename}
                  onClick={() => navigate(`/image/${image.id}`)}
                />
                {image.paired_image_id && <span className="badge">RAW+JPG</span>}
                <button
                  className="selects-remove"
                  title="Remove from selects"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(image.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

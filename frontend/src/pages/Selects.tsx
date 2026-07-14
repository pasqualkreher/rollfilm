import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ImageOut } from "../api/types";
import { useSelects } from "../state/selects";
import { collapsePairs, useMergePairs } from "../state/viewPrefs";
import { ViewPrefsControls } from "../components/ViewPrefsControls";
import { ThumbnailGrid } from "../components/ThumbnailGrid";

export function Selects() {
  const { ids, count, remove, clear } = useSelects();
  const mergePairs = useMergePairs();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [immichBusy, setImmichBusy] = useState(false);
  const [immichMsg, setImmichMsg] = useState<string | null>(null);

  // The "Add to Immich" action only appears when the integration is configured
  // in Settings (both host and API key present).
  const { data: immich } = useQuery({
    queryKey: ["immich-settings"],
    queryFn: () => api.settings.getImmich(),
  });
  const immichConfigured = Boolean(immich?.base_url && immich?.api_key_set);

  // One query per selected id; deleted photos simply resolve to nothing and are
  // filtered out below so the list never shows a broken tile.
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["image", id],
      queryFn: () => api.images.get(id),
    })),
  });

  const loadedImages = results
    .map((r) => r.data)
    .filter((img): img is ImageOut => Boolean(img));
  // When merging, a selected RAW+JPEG pair shows as its single JPEG card.
  const images = mergePairs ? collapsePairs(loadedImages) : loadedImages;

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

  async function addToImmich() {
    if (count === 0) return;
    setImmichBusy(true);
    setImmichMsg(null);
    setError(null);
    try {
      const result = await api.images.pushToImmich(ids);
      setImmichMsg(result.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImmichBusy(false);
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
            {/* Hidden in full sync mode - everything uploads automatically there. */}
            {immichConfigured && immich?.sync_mode !== "full" && (
              <button
                className="btn"
                onClick={addToImmich}
                disabled={immichBusy}
                title="Upload the selected JPEGs to your configured Immich server (RAW files are skipped)"
              >
                {immichBusy ? "Uploading to Immich..." : "Add to Immich"}
              </button>
            )}
            <button className="btn ghost" onClick={clear}>
              Clear selects
            </button>
            <ViewPrefsControls />
            {immichMsg && <span style={{ color: "var(--text-muted)" }}>{immichMsg}</span>}
            {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
          </div>

          {/* The shared grid handles justified tile sizing (--ar + filler) and
              the enlarged 1-2 photo layout - the previous hand-rolled grid
              lacked both, so a lone select stretched huge and got cut off. */}
          <ThumbnailGrid images={images} onRemove={remove} removeTitle="Remove from selects" />
        </>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api, editVersion } from "../api/client";
import type { ImageOut } from "../api/types";

// Photos that carry GPS coordinates, de-duplicated across RAW+JPEG pairs so a
// paired shot drops a single pin instead of two stacked on the same spot.
function geotagged(images: ImageOut[]): ImageOut[] {
  const out: ImageOut[] = [];
  const placed = new Set<string>();
  for (const img of images) {
    if (img.gps_lat == null || img.gps_lon == null) continue;
    if (placed.has(img.id)) continue;
    out.push(img);
    placed.add(img.id);
    if (img.paired_image_id) placed.add(img.paired_image_id);
  }
  return out;
}

export function MapView() {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  const { data: images, isLoading } = useQuery({
    queryKey: ["images", { view_mode: "combined", limit: 2000 }],
    queryFn: () => api.images.list({ view_mode: "combined", limit: 2000 }),
  });

  const points = useMemo(() => geotagged(images ?? []), [images]);

  // Initialise the Leaflet map once, then keep it for the component's lifetime.
  useEffect(() => {
    const el = containerRef.current;
    if (mapRef.current || !el) return;
    const map = L.map(el, { center: [20, 0], zoom: 2, worldCopyJump: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // The flex container often isn't at its final size on first mount, which
    // leaves Leaflet thinking it's 0×0 and rendering a blank/gray map. Re-measure
    // after layout settles and whenever the container resizes.
    const invalidate = () => map.invalidateSize();
    const raf = requestAnimationFrame(invalidate);
    const ro = new ResizeObserver(invalidate);
    ro.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // Rebuild markers whenever the geotagged set changes.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (points.length === 0) return;

    for (const img of points) {
      const icon = L.divIcon({
        className: "map-pin",
        html: `<img src="${api.images.thumbnailUrl(img.id, editVersion(img))}" alt="" />`,
        iconSize: [46, 46],
        iconAnchor: [23, 23],
      });
      L.marker([img.gps_lat as number, img.gps_lon as number], { icon, title: img.original_filename })
        .on("click", () => navigate(`/image/${img.id}`))
        .addTo(layer);
    }

    const bounds = L.latLngBounds(points.map((img) => [img.gps_lat as number, img.gps_lon as number]));
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 14 });
  }, [points, navigate]);

  return (
    <div className="page map-page">
      <h2 className="section-title">
        Map
        <span className="count-pill">{points.length} located</span>
      </h2>
      <div className="map-wrap">
        <div ref={containerRef} className="map-container" />
        {!isLoading && points.length === 0 && (
          <div className="map-empty">No photos with location data yet.</div>
        )}
      </div>
    </div>
  );
}

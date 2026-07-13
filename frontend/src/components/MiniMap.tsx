import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// A small, non-interactive map showing a single photo's location. All Leaflet
// interactions are disabled so the whole thing reads as one button: clicking it
// opens the full Map focused on this spot.
export function MiniMap({
  lat,
  lon,
  onClick,
  zoom = 13,
}: {
  lat: number;
  lon: number;
  onClick?: () => void;
  zoom?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (mapRef.current || !el) return;
    const map = L.map(el, {
      center: [lat, lon],
      zoom,
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
    markerRef.current = L.marker([lat, lon]).addTo(map);
    mapRef.current = map;

    // The panel is often not at its final size on first mount, leaving Leaflet
    // rendering a blank/gray tile; re-measure once layout settles and on resize.
    const invalidate = () => map.invalidateSize();
    const raf = requestAnimationFrame(invalidate);
    const ro = new ResizeObserver(invalidate);
    ro.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Created once; coordinate updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-centre when the active photo changes (the detail view reuses this map
  // as you page through shots).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setView([lat, lon], zoom);
    markerRef.current?.setLatLng([lat, lon]);
  }, [lat, lon, zoom]);

  return (
    <div
      ref={containerRef}
      className="mini-map"
      onClick={onClick}
      role={onClick ? "button" : undefined}
      title={onClick ? "Show on map" : undefined}
    />
  );
}

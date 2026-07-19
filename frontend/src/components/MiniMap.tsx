import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

// Leaflet's default marker locates its icon images at runtime relative to its
// stylesheet, which breaks under Vite's bundling - the pin renders as a
// broken-image placeholder. Import the images through the bundler instead.
const pinIcon = L.icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  shadowSize: [41, 41],
});

// A small, non-interactive map showing a single photo's location. All Leaflet
// interactions are disabled so the whole thing reads as one button: clicking it
// opens the full Map focused on this spot. The map stays hidden behind a
// spinner until every visible tile has loaded, so the panel never shows a
// half-gray map while tiles trickle in.
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
  const tilesRef = useRef<L.TileLayer | null>(null);
  const [ready, setReady] = useState(false);

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
    const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
    }).addTo(map);
    // "load" fires whenever all tiles for the current view have finished
    // (including after a later re-centre), so this also re-reveals the map
    // when paging to another photo re-hides it below.
    tiles.on("load", () => setReady(true));
    markerRef.current = L.marker([lat, lon], { icon: pinIcon }).addTo(map);
    mapRef.current = map;
    tilesRef.current = tiles;

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
      tilesRef.current = null;
    };
    // Created once; coordinate updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-centre when the active photo changes (the detail view reuses this map
  // as you page through shots). If the jump needs tiles that aren't in yet,
  // hide the map again until they are - otherwise keep it shown (a same-area
  // move loads nothing new, so no "load" event would ever re-reveal it).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setView([lat, lon], zoom);
    markerRef.current?.setLatLng([lat, lon]);
    if (tilesRef.current?.isLoading()) setReady(false);
  }, [lat, lon, zoom]);

  return (
    <div
      className={`mini-map${ready ? " is-loaded" : ""}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      title={onClick ? "Show on map" : undefined}
    >
      <div ref={containerRef} className="mini-map-canvas" />
      {!ready && (
        <div className="mini-map-loading" aria-hidden>
          <span className="spinner" />
        </div>
      )}
    </div>
  );
}

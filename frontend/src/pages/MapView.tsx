import { useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "../api/client";
import type { GeoImage } from "../api/types";

// De-duplicate RAW+JPEG pairs so a paired shot drops a single pin instead of
// two stacked on the same spot.
function geotagged(images: GeoImage[]): GeoImage[] {
  const out: GeoImage[] = [];
  const placed = new Set<string>();
  for (const img of images) {
    if (placed.has(img.id)) continue;
    out.push(img);
    placed.add(img.id);
    if (img.paired_image_id) placed.add(img.paired_image_id);
  }
  return out;
}

// Optional target passed from a photo's mini-map: centre here instead of
// fitting the whole set, and single out its pin.
type Focus = { id: string; lat: number; lon: number };

export function MapView() {
  const navigate = useNavigate();
  const location = useLocation();
  const focus = (location.state as { focus?: Focus } | null)?.focus ?? null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  // Whether the initial fit-all-points framing already happened (it must not
  // repeat on background refetches of the geo data).
  const fittedRef = useRef(false);

  // Slim geo rows for EVERY located photo (the old page-limited full-row query
  // silently capped the map at 2000 photos). Clustering below keeps the marker
  // count small no matter how many points come back.
  const { data, isLoading } = useQuery({
    queryKey: ["images", "geo"],
    queryFn: () => api.images.geo(),
    // Keep the pins on screen through background refetches.
    placeholderData: (prev) => prev,
    staleTime: 15_000,
  });

  const points = useMemo(() => geotagged(data?.images ?? []), [data]);

  // Initialise the Leaflet map once, then keep it for the component's lifetime.
  useEffect(() => {
    const el = containerRef.current;
    if (mapRef.current || !el) return;
    const map = L.map(el, {
      center: focus ? [focus.lat, focus.lon] : [20, 0],
      zoom: focus ? 15 : 2,
      worldCopyJump: true,
    });
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
    // Initialised once; `focus` is only read to pick the opening view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild markers whenever the geotagged set or the view changes. Points are
  // clustered on a screen-space grid per zoom level and only materialized for
  // the visible area (plus margin): a library with tens of thousands of
  // located photos still renders only the few dozen pins that are actually
  // distinguishable, instead of one thumbnail request + DOM marker per photo.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;

    type Pin = { id: string; count: number; latlng: L.LatLng; marker: L.Marker };
    let pins: Pin[] = [];

    const addPin = (id: string, lat: number, lon: number, count: number, title?: string) => {
      const badge =
        count > 1 ? `<span class="map-pin-count">${count > 99 ? "99+" : count}</span>` : "";
      const icon = L.divIcon({
        className: "map-pin",
        html: `<div style="position:relative"><img src="${api.images.thumbnailUrl(id)}" alt="" />${badge}</div>`,
        iconSize: [46, 46],
        iconAnchor: [23, 23],
      });
      const latlng = L.latLng(lat, lon);
      // Plain interactive markers: with clustering there are only a few dozen
      // pins on screen, so Leaflet's own hover/click handling is reliable and
      // riseOnHover keeps the enlarged photo above its neighbors. (The old
      // cursor-distance hit-testing predates clustering, when thousands of
      // overlapping pins made per-marker events unusable.)
      const marker = L.marker(latlng, { icon, title, riseOnHover: true }).addTo(layer);
      const pin: Pin = { id, count, latlng, marker };
      marker.on("mouseover", () => marker.getElement()?.classList.add("map-pin-active"));
      marker.on("mouseout", () => marker.getElement()?.classList.remove("map-pin-active"));
      marker.on("click", () => {
        // A cluster zooms in toward its photos; a single pin opens the photo.
        if (pin.count > 1) map.setView(pin.latlng, Math.min(map.getZoom() + 2, 18));
        else navigate(`/image/${pin.id}`);
      });
      pins.push(pin);
    };

    // One pin per ~72px screen cell at the current zoom; the newest photo of
    // the cell fronts it (points arrive newest-first) with a count badge.
    const CELL = 72;
    const rebuild = () => {
      layer.clearLayers();
      pins = [];
      const zoom = map.getZoom();
      const bounds = map.getBounds().pad(0.5);
      const cells = new Map<string, { rep: GeoImage; count: number }>();
      for (const p of points) {
        if (!bounds.contains([p.lat, p.lon])) continue;
        const pt = map.project([p.lat, p.lon], zoom);
        const key = `${Math.floor(pt.x / CELL)}:${Math.floor(pt.y / CELL)}`;
        const cell = cells.get(key);
        if (cell) cell.count++;
        else cells.set(key, { rep: p, count: 1 });
      }
      for (const { rep, count } of cells.values()) {
        addPin(rep.id, rep.lat, rep.lon, count, rep.original_filename);
      }
      // The focused shot always gets a pin to zoom to and enlarge, even when
      // its cell is fronted by a newer photo.
      if (focus && !pins.some((p) => p.id === focus.id)) {
        addPin(focus.id, focus.lat, focus.lon, 1);
      }
      if (focus) {
        pins
          .find((p) => p.id === focus.id)
          ?.marker.getElement()
          ?.classList.add("map-pin-active");
      }
    };

    map.on("moveend zoomend", rebuild);

    // Arriving from a photo's mini-map: hold on that spot and pop it big.
    // Otherwise frame them all - but only when the photo set first arrives,
    // not on every background refetch (which used to yank the view back).
    if (focus) {
      map.setView([focus.lat, focus.lon], 15);
    } else if (points.length > 0 && !fittedRef.current) {
      fittedRef.current = true;
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number]));
      map.fitBounds(bounds, { padding: [60, 60], maxZoom: 14 });
    }
    rebuild();

    return () => {
      map.off("moveend zoomend", rebuild);
    };
  }, [points, navigate, focus]);

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

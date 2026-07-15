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

  // Slim geo rows for EVERY located photo (the old page-limited full-row query
  // silently capped the map at 2000 photos). Clustering below keeps the marker
  // count small no matter how many points come back.
  const { data, isLoading } = useQuery({
    queryKey: ["images", "geo"],
    queryFn: () => api.images.geo(),
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
    let active: Pin | null = null;

    const setActive = (pin: Pin | null) => {
      if (pin === active) return;
      active?.marker.getElement()?.classList.remove("map-pin-active");
      active = pin;
      active?.marker.getElement()?.classList.add("map-pin-active");
      map.getContainer().style.cursor = pin ? "pointer" : "";
    };

    const addPin = (id: string, lat: number, lon: number, count: number, title?: string) => {
      const badge =
        count > 1 ? `<span class="map-pin-count">${count > 99 ? "99+" : count}</span>` : "";
      const icon = L.divIcon({
        className: "map-pin",
        html: `<div style="position:relative"><img src="${api.images.thumbnailUrl(id)}" alt="" />${badge}</div>`,
        iconSize: [46, 46],
        iconAnchor: [23, 23],
      });
      // Non-interactive: the marker never captures the pointer, so moves and
      // clicks reach the map and we resolve them against the nearest pin.
      const latlng = L.latLng(lat, lon);
      const marker = L.marker(latlng, { icon, title, interactive: false }).addTo(layer);
      pins.push({ id, count, latlng, marker });
    };

    // One pin per ~72px screen cell at the current zoom; the newest photo of
    // the cell fronts it (points arrive newest-first) with a count badge.
    const CELL = 72;
    const rebuild = () => {
      layer.clearLayers();
      pins = [];
      active = null;
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
      if (focus) setActive(pins.find((p) => p.id === focus.id) ?? null);
    };

    // Which pin is blown up. Picked by cursor distance rather than by which
    // element sits on top, so an enlarged photo never blocks the pins beneath
    // it. With clustering the pin count is small, so the per-move scan stays
    // cheap even while panning across a dense library.
    const HIT_RADIUS = 46; // px in screen space
    const nearest = (pt: L.Point): Pin | null => {
      let best: Pin | null = null;
      let bestD = HIT_RADIUS;
      for (const pin of pins) {
        const d = pt.distanceTo(map.latLngToContainerPoint(pin.latlng));
        if (d <= bestD) {
          bestD = d;
          best = pin;
        }
      }
      return best;
    };
    const onMove = (e: L.LeafletMouseEvent) => setActive(nearest(e.containerPoint));
    const onClick = (e: L.LeafletMouseEvent) => {
      const pin = nearest(e.containerPoint);
      if (!pin) return;
      // A cluster zooms in toward its photos; a single pin opens the photo.
      if (pin.count > 1) map.setView(pin.latlng, Math.min(map.getZoom() + 2, 18));
      else navigate(`/image/${pin.id}`);
    };
    const onOut = () => setActive(null);
    map.on("mousemove", onMove);
    map.on("click", onClick);
    map.on("mouseout", onOut);
    map.on("moveend zoomend", rebuild);

    // Arriving from a photo's mini-map: hold on that spot and pop it big.
    // Otherwise frame them all. Both trigger moveend -> rebuild; still rebuild
    // once directly for the no-op-view case (e.g. world view already fits).
    if (focus) {
      map.setView([focus.lat, focus.lon], 15);
    } else if (points.length > 0) {
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number]));
      map.fitBounds(bounds, { padding: [60, 60], maxZoom: 14 });
    }
    rebuild();

    return () => {
      map.off("mousemove", onMove);
      map.off("click", onClick);
      map.off("mouseout", onOut);
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

import { useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "../api/client";
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

  const { data: images, isLoading } = useQuery({
    queryKey: ["images", { view_mode: "combined", limit: 2000 }],
    queryFn: () => api.images.list({ view_mode: "combined", limit: 2000 }),
  });

  const points = useMemo(() => geotagged(images ?? []), [images]);

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

  // Rebuild markers whenever the geotagged set changes.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    type Pin = { id: string; marker: L.Marker };
    const pins: Pin[] = [];
    const addPin = (id: string, lat: number, lon: number, title?: string) => {
      const icon = L.divIcon({
        className: "map-pin",
        html: `<img src="${api.images.thumbnailUrl(id)}" alt="" />`,
        iconSize: [46, 46],
        iconAnchor: [23, 23],
      });
      // Non-interactive: the marker never captures the pointer, so moves and
      // clicks reach the map and we resolve them against the nearest pin.
      const marker = L.marker([lat, lon], { icon, title, interactive: false }).addTo(layer);
      pins.push({ id, marker });
    };
    for (const img of points) {
      addPin(img.id, img.gps_lat as number, img.gps_lon as number, img.original_filename);
    }
    // The focused shot may fall outside the loaded page; drop a pin for it anyway
    // so there is always something to zoom to and enlarge.
    if (focus && !pins.some((p) => p.id === focus.id)) {
      addPin(focus.id, focus.lat, focus.lon);
    }
    if (pins.length === 0) return;

    // Which pin is blown up. We pick it by distance from the cursor rather than
    // by which element sits on top, so an already-enlarged photo never blocks
    // you from reaching the pins beneath it. Its image is non-interactive (CSS
    // pointer-events), so all moves/clicks land on the map and we resolve them
    // here against the nearest marker.
    const HIT_RADIUS = 46; // px in screen space
    let active: Pin | null = null;
    const setActive = (pin: Pin | null) => {
      if (pin === active) return;
      active?.marker.getElement()?.classList.remove("map-pin-active");
      active = pin;
      active?.marker.getElement()?.classList.add("map-pin-active");
      map.getContainer().style.cursor = pin ? "pointer" : "";
    };
    const nearest = (pt: L.Point): Pin | null => {
      let best: Pin | null = null;
      let bestD = HIT_RADIUS;
      for (const pin of pins) {
        const d = pt.distanceTo(map.latLngToContainerPoint(pin.marker.getLatLng()));
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
      if (pin) navigate(`/image/${pin.id}`);
    };
    const onOut = () => setActive(null);
    map.on("mousemove", onMove);
    map.on("click", onClick);
    map.on("mouseout", onOut);

    // Arriving from a photo's mini-map: hold on that spot and pop it big.
    // Otherwise frame them all.
    if (focus) {
      map.setView([focus.lat, focus.lon], 15);
      setActive(pins.find((p) => p.id === focus.id) ?? null);
    } else {
      const bounds = L.latLngBounds(points.map((img) => [img.gps_lat as number, img.gps_lon as number]));
      map.fitBounds(bounds, { padding: [60, 60], maxZoom: 14 });
    }

    return () => {
      map.off("mousemove", onMove);
      map.off("click", onClick);
      map.off("mouseout", onOut);
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

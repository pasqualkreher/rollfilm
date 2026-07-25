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

// Last centre/zoom the user was looking at. Module-level so it survives the
// unmount that `navigate(-1)` triggers when returning from a photo - the map
// then reopens exactly where it was left instead of re-fitting the whole world.
let lastMapView: { center: [number, number]; zoom: number } | null = null;

// Great-circle distance in km, used to gather the photos "near" a clicked one
// so the lightbox arrow keys page through the neighbourhood, not just the pin.
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// How far "nearby" reaches when paging through neighbours in the lightbox.
const NEARBY_KM = 50;

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
    // Opening view: a mini-map focus wins; otherwise resume the remembered view
    // (returning from a photo) and skip the fit-all so it isn't reframed; only a
    // genuinely fresh visit falls back to the whole-world default + fit.
    const initial = focus
      ? { center: [focus.lat, focus.lon] as [number, number], zoom: 15 }
      : lastMapView ?? { center: [20, 0] as [number, number], zoom: 2 };
    if (!focus && lastMapView) fittedRef.current = true;
    const map = L.map(el, {
      center: initial.center,
      zoom: initial.zoom,
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

    type Pin = { id: string; members: string[]; latlng: L.LatLng; marker: L.Marker };
    let pins: Pin[] = [];

    // At most this many thumbnails fan out when a cluster explodes; anything
    // beyond collapses into a single "+N" tile (all members stay reachable in
    // the lightbox via the arrow keys).
    const MAX_SPIDER = 24;
    type Spider = { pin: Pin; layers: L.Layer[] };
    let spider: Spider | null = null;

    // The set the lightbox arrow keys page through: every located photo within
    // ~50km of the one being opened, kept newest-first (points arrive that way).
    // Lets you flip through the surrounding shots, not just what shared the pin.
    const nearbyIds = (lat: number, lon: number): string[] =>
      points.filter((p) => haversineKm(lat, lon, p.lat, p.lon) <= NEARBY_KM).map((p) => p.id);

    const unspiderfy = () => {
      if (!spider) return;
      for (const l of spider.layers) layer.removeLayer(l);
      spider.pin.marker.getElement()?.classList.remove("map-pin-dimmed");
      spider = null;
    };

    // Pixel offsets for the exploded thumbnails: a ring while they fit on one,
    // an expanding spiral beyond that (constant ~58px arc separation, each full
    // turn moving ~56px further out so rings of 46px thumbnails don't overlap).
    const spiderOffsets = (count: number): L.Point[] => {
      const pts: L.Point[] = [];
      if (count <= 9) {
        const radius = Math.max(60, (count * 58) / (2 * Math.PI));
        for (let i = 0; i < count; i++) {
          const a = (2 * Math.PI * i) / count - Math.PI / 2;
          pts.push(L.point(Math.round(radius * Math.cos(a)), Math.round(radius * Math.sin(a))));
        }
      } else {
        let angle = 0;
        let radius = 62;
        for (let i = 0; i < count; i++) {
          pts.push(L.point(Math.round(radius * Math.cos(angle)), Math.round(radius * Math.sin(angle))));
          angle += 58 / radius;
          radius += (56 * 58) / (2 * Math.PI * radius);
        }
      }
      return pts;
    };

    // Explode a same-spot cluster: fan its photos out around the pin with legs
    // back to the true location, so every shot becomes visible and clickable.
    const spiderfy = (pin: Pin, members: GeoImage[]) => {
      unspiderfy();
      const center = map.latLngToLayerPoint(pin.latlng);
      const shown = members.slice(0, MAX_SPIDER);
      const overflow = members.length - shown.length;
      const offsets = spiderOffsets(shown.length + (overflow > 0 ? 1 : 0));
      const layers: L.Layer[] = [];

      offsets.forEach((off, i) => {
        const latlng = map.layerPointToLatLng(center.add(off));
        layers.push(
          L.polyline([pin.latlng, latlng], {
            color: "#fff",
            weight: 1.5,
            opacity: 0.85,
            interactive: false,
          }).addTo(layer)
        );
        const isOverflow = i >= shown.length;
        const html = isOverflow
          ? `<div class="map-pin-overflow">+${overflow}</div>`
          : `<div style="position:relative"><img src="${api.images.thumbnailUrl(shown[i].id)}" alt="" /></div>`;
        const icon = L.divIcon({
          className: "map-pin map-pin-spider",
          html,
          iconSize: [46, 46],
          iconAnchor: [23, 23],
        });
        const marker = L.marker(latlng, {
          icon,
          title: isOverflow ? undefined : shown[i].original_filename,
          riseOnHover: true,
          zIndexOffset: 1000,
        }).addTo(layer);
        marker.on("mouseover", () => marker.getElement()?.classList.add("map-pin-active"));
        marker.on("mouseout", () => marker.getElement()?.classList.remove("map-pin-active"));
        // Opening from the fan hands the lightbox every photo within ~50km, so
        // the arrow keys page through the whole neighbourhood (which includes
        // all the shots stacked here on this spot).
        const targetId = isOverflow ? members[shown.length].id : shown[i].id;
        marker.on("click", () =>
          navigate(`/image/${targetId}`, {
            state: { imageIds: nearbyIds(pin.latlng.lat, pin.latlng.lng) },
          })
        );
        layers.push(marker);
      });

      pin.marker.getElement()?.classList.add("map-pin-dimmed");
      spider = { pin, layers };
    };

    // The deepest zoom a cluster click drives toward. Photos whose pixel
    // spread at THIS zoom still fits one grid cell can never be separated by
    // zooming - clicking such a cluster must open the photos instead.
    const MAX_PIN_ZOOM = 18;

    // Would zooming all the way in actually break this cluster apart?
    const splittable = (members: GeoImage[]): boolean => {
      if (members.length < 2) return false;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const m of members) {
        const pt = map.project([m.lat, m.lon], MAX_PIN_ZOOM);
        minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x);
        minY = Math.min(minY, pt.y); maxY = Math.max(maxY, pt.y);
      }
      const cell = cellFor(MAX_PIN_ZOOM);
      return maxX - minX >= cell || maxY - minY >= cell;
    };

    const addPin = (rep: GeoImage, members: GeoImage[], title?: string) => {
      const count = members.length;
      const badge =
        count > 1 ? `<span class="map-pin-count">${count > 99 ? "99+" : count}</span>` : "";
      const icon = L.divIcon({
        className: "map-pin",
        html: `<div style="position:relative"><img src="${api.images.thumbnailUrl(rep.id)}" alt="" />${badge}</div>`,
        iconSize: [46, 46],
        iconAnchor: [23, 23],
      });
      const latlng = L.latLng(rep.lat, rep.lon);
      // Plain interactive markers: with clustering there are only a few dozen
      // pins on screen, so Leaflet's own hover/click handling is reliable and
      // riseOnHover keeps the enlarged photo above its neighbors. (The old
      // cursor-distance hit-testing predates clustering, when thousands of
      // overlapping pins made per-marker events unusable.)
      const marker = L.marker(latlng, { icon, title, riseOnHover: true }).addTo(layer);
      const canSplit = splittable(members);
      const pin: Pin = { id: rep.id, members: members.map((m) => m.id), latlng, marker };
      marker.on("mouseover", () => marker.getElement()?.classList.add("map-pin-active"));
      marker.on("mouseout", () => marker.getElement()?.classList.remove("map-pin-active"));
      marker.on("click", () => {
        // A splittable cluster zooms in toward its photos. A cluster of photos
        // taken at (virtually) the same spot - which no zoom level can
        // separate - explodes into a fan of individual thumbnails instead
        // (clicking the pin again folds it back up). Only a true single pin
        // opens the photo directly.
        if (pin.members.length > 1 && canSplit && map.getZoom() < MAX_PIN_ZOOM) {
          map.setView(pin.latlng, Math.min(map.getZoom() + 2, MAX_PIN_ZOOM));
        } else if (pin.members.length > 1) {
          if (spider?.pin === pin) unspiderfy();
          else spiderfy(pin, members);
        } else {
          navigate(`/image/${pin.id}`, {
            state: { imageIds: nearbyIds(pin.latlng.lat, pin.latlng.lng) },
          });
        }
      });
      pins.push(pin);
    };

    // One pin per screen cell at the current zoom; the newest photo of the
    // cell fronts it (points arrive newest-first) with a count badge. The cell
    // shrinks at low zooms so a zoomed-out view packs in many more photos
    // (pins may nearly touch - hover lifts and enlarges them).
    const cellFor = (zoom: number) => (zoom <= 5 ? 48 : zoom <= 9 ? 58 : 72);
    const rebuild = () => {
      // Remember wherever the user is now, so returning from a photo lands here.
      const c = map.getCenter();
      lastMapView = { center: [c.lat, c.lng], zoom: map.getZoom() };
      layer.clearLayers();
      // clearLayers already removed the fan's markers and legs.
      spider = null;
      pins = [];
      const zoom = map.getZoom();
      const CELL = cellFor(zoom);
      const bounds = map.getBounds().pad(0.5);
      const cells = new Map<string, GeoImage[]>();
      for (const p of points) {
        if (!bounds.contains([p.lat, p.lon])) continue;
        const pt = map.project([p.lat, p.lon], zoom);
        const key = `${Math.floor(pt.x / CELL)}:${Math.floor(pt.y / CELL)}`;
        const cell = cells.get(key);
        if (cell) cell.push(p);
        else cells.set(key, [p]);
      }
      for (const members of cells.values()) {
        // Newest photo of the cell fronts it (points arrive newest-first).
        addPin(members[0], members, members[0].original_filename);
      }
      // The focused shot always gets a pin to zoom to and enlarge, even when
      // its cell is fronted by a newer photo.
      if (focus && !pins.some((p) => p.id === focus.id)) {
        const rep =
          points.find((p) => p.id === focus.id) ??
          ({ id: focus.id, lat: focus.lat, lon: focus.lon } as GeoImage);
        addPin(rep, [rep]);
      }
      if (focus) {
        pins
          .find((p) => p.id === focus.id)
          ?.marker.getElement()
          ?.classList.add("map-pin-active");
      }
    };

    map.on("moveend zoomend", rebuild);
    // Clicking empty map folds an exploded cluster back up (marker clicks
    // don't bubble to the map, so the fan's own thumbnails are unaffected).
    map.on("click", unspiderfy);

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
      map.off("click", unspiderfy);
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

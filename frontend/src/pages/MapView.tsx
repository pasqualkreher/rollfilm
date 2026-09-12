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
  // clustered by pixel radius per zoom level and only materialized for the
  // visible area (plus margin): a library with tens of thousands of located
  // photos still renders only the few dozen pins that are actually
  // distinguishable, instead of one thumbnail request + DOM marker per photo.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;

    type Cluster = {
      key: string;
      rep: GeoImage;
      members: GeoImage[];
      latlng: L.LatLng;
      point: L.Point;
    };

    // Minimum centre-to-centre distance between two pins at a zoom. Pins are
    // 46px, so this guarantees they never overlap; tighter when zoomed out so
    // a world view still packs in plenty of photos.
    const radiusFor = (zoom: number) => (zoom <= 5 ? 50 : zoom <= 9 ? 58 : 72);

    // The deepest zoom a cluster click drives toward.
    const MAX_PIN_ZOOM = 18;

    // At most this many thumbnails fan out around a pin; anything beyond
    // collapses into a single "+N" tile (all members stay reachable in the
    // lightbox via the arrow keys).
    const MAX_SPIDER = 30;

    // Greedy radius clustering over ALL points at a zoom, cached per zoom:
    // each photo joins the nearest existing cluster within the radius or
    // founds a new one, so cluster centres are always at least a radius apart
    // and no two pins can overlap (the old grid cells let pins from adjacent
    // cells sit right on top of each other). Clustering the whole set rather
    // than the viewport keeps clusters stable while panning, which is what
    // lets an open fan survive a pan.
    const clusterCache = new Map<number, Cluster[]>();
    const clustersFor = (zoom: number): Cluster[] => {
      const cached = clusterCache.get(zoom);
      if (cached) return cached;
      const R = radiusFor(zoom);
      const grid = new Map<string, Cluster[]>();
      const out: Cluster[] = [];
      // Newest photo founds (and fronts) each cluster - points arrive
      // newest-first. The focused shot goes first so it fronts its own.
      const ordered = focus
        ? [...points.filter((p) => p.id === focus.id), ...points.filter((p) => p.id !== focus.id)]
        : points;
      for (const p of ordered) {
        const pt = map.project([p.lat, p.lon], zoom);
        const cx = Math.floor(pt.x / R);
        const cy = Math.floor(pt.y / R);
        let best: Cluster | null = null;
        let bestD = R;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const cell = grid.get(`${cx + dx}:${cy + dy}`);
            if (!cell) continue;
            for (const c of cell) {
              const d = pt.distanceTo(c.point);
              if (d < bestD) {
                bestD = d;
                best = c;
              }
            }
          }
        }
        if (best) {
          best.members.push(p);
          continue;
        }
        const c: Cluster = { key: p.id, rep: p, members: [p], latlng: L.latLng(p.lat, p.lon), point: pt };
        out.push(c);
        const k = `${cx}:${cy}`;
        const cell = grid.get(k);
        if (cell) cell.push(c);
        else grid.set(k, [c]);
      }
      clusterCache.set(zoom, out);
      return out;
    };

    // Pins currently on the map, by cluster key.
    let pinsByKey = new Map<string, L.Marker>();

    // The exploded cluster lives on its own layer so rebuilding the pins after
    // a pan doesn't tear it down - its tiles are anchored to coordinates and
    // simply move with the map.
    const spiderLayer = L.layerGroup().addTo(map);
    let spider: { key: string } | null = null;

    // The set the lightbox arrow keys page through: every located photo within
    // ~50km of the one being opened, kept newest-first (points arrive that way).
    // Lets you flip through the surrounding shots, not just what shared the pin.
    const nearbyIds = (lat: number, lon: number): string[] =>
      points.filter((p) => haversineKm(lat, lon, p.lat, p.lon) <= NEARBY_KM).map((p) => p.id);

    const unspiderfy = () => {
      if (!spider) return;
      spiderLayer.clearLayers();
      pinsByKey.get(spider.key)?.getElement()?.classList.remove("map-pin-dimmed");
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

    // Explode a cluster: fan its photos out around the pin with legs back to
    // the pin, so every shot becomes visible and clickable. Nudges the map if
    // the fan would hang off the edge.
    const spiderfy = (c: Cluster) => {
      unspiderfy();
      const { members } = c;
      const center = map.latLngToLayerPoint(c.latlng);
      const shown = members.slice(0, MAX_SPIDER);
      const overflow = members.length - shown.length;
      const offsets = spiderOffsets(shown.length + (overflow > 0 ? 1 : 0));

      offsets.forEach((off, i) => {
        const latlng = map.layerPointToLatLng(center.add(off));
        L.polyline([c.latlng, latlng], {
          color: "#fff",
          weight: 1.5,
          opacity: 0.85,
          interactive: false,
        }).addTo(spiderLayer);
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
        }).addTo(spiderLayer);
        marker.on("mouseover", () => marker.getElement()?.classList.add("map-pin-active"));
        marker.on("mouseout", () => marker.getElement()?.classList.remove("map-pin-active"));
        // Opening from the fan hands the lightbox every photo within ~50km, so
        // the arrow keys page through the whole neighbourhood (which includes
        // all the shots stacked here on this spot).
        const targetId = isOverflow ? members[shown.length].id : shown[i].id;
        marker.on("click", () =>
          navigate(`/image/${targetId}`, {
            state: { imageIds: nearbyIds(c.latlng.lat, c.latlng.lng) },
          })
        );
      });

      pinsByKey.get(c.key)?.getElement()?.classList.add("map-pin-dimmed");
      spider = { key: c.key };

      // Keep the whole fan on screen: pan just far enough that its extent
      // (plus half a tile and a little margin) sits inside the container.
      let reach = 0;
      for (const o of offsets) reach = Math.max(reach, Math.abs(o.x), Math.abs(o.y));
      reach += 23 + 12;
      const cp = map.latLngToContainerPoint(c.latlng);
      const size = map.getSize();
      let px = 0;
      let py = 0;
      if (cp.x - reach < 0) px = cp.x - reach;
      else if (cp.x + reach > size.x) px = cp.x + reach - size.x;
      if (cp.y - reach < 0) py = cp.y - reach;
      else if (cp.y + reach > size.y) py = cp.y + reach - size.y;
      if (px || py) map.panBy([px, py]);
    };

    // Would zooming all the way in actually break this cluster apart? Photos
    // whose pixel spread at the deepest zoom still fits one radius can never
    // be separated by zooming.
    const splittable = (members: GeoImage[]): boolean => {
      if (members.length < 2) return false;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const m of members) {
        const pt = map.project([m.lat, m.lon], MAX_PIN_ZOOM);
        minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x);
        minY = Math.min(minY, pt.y); maxY = Math.max(maxY, pt.y);
      }
      const r = radiusFor(MAX_PIN_ZOOM);
      return maxX - minX >= r || maxY - minY >= r;
    };

    // Zoom so a crowd's photos fill the view - in one go, not two levels at a
    // time; if they're already too tight for that to change anything, step in
    // two levels anyway so the click always does something.
    const zoomInto = (c: Cluster) => {
      const b = L.latLngBounds(c.members.map((m) => [m.lat, m.lon] as [number, number]));
      const zoom = map.getZoom();
      let target = Math.min(map.getBoundsZoom(b, false, L.point(80, 80)), MAX_PIN_ZOOM);
      if (target <= zoom) target = Math.min(zoom + 2, MAX_PIN_ZOOM);
      map.setView(b.getCenter(), target);
    };

    const addPin = (c: Cluster, title?: string) => {
      const count = c.members.length;
      const badge =
        count > 1 ? `<span class="map-pin-count">${count > 99 ? "99+" : count}</span>` : "";
      const icon = L.divIcon({
        className: "map-pin",
        html: `<div style="position:relative"><img src="${api.images.thumbnailUrl(c.rep.id)}" alt="" />${badge}</div>`,
        iconSize: [46, 46],
        iconAnchor: [23, 23],
      });
      // Plain interactive markers: with clustering there are only a few dozen
      // pins on screen, so Leaflet's own hover/click handling is reliable and
      // riseOnHover keeps the enlarged photo above its neighbors.
      const marker = L.marker(c.latlng, { icon, title, riseOnHover: true }).addTo(layer);
      marker.on("mouseover", () => marker.getElement()?.classList.add("map-pin-active"));
      marker.on("mouseout", () => marker.getElement()?.classList.remove("map-pin-active"));
      marker.on("click", () => {
        // A single photo opens directly. A group fans out around its pin so
        // every photo is visible and clickable (clicking the pin again folds
        // it back up). Only a crowd too big for one fan zooms in instead -
        // unless no zoom could ever pull it apart, or we're already as deep as
        // pins go: then it fans out too, with a "+N" tile for the rest.
        const n = c.members.length;
        if (n === 1) {
          navigate(`/image/${c.key}`, {
            state: { imageIds: nearbyIds(c.latlng.lat, c.latlng.lng) },
          });
          return;
        }
        if (spider?.key === c.key) {
          unspiderfy();
          return;
        }
        if (n <= MAX_SPIDER || !splittable(c.members) || map.getZoom() >= MAX_PIN_ZOOM) {
          spiderfy(c);
          return;
        }
        zoomInto(c);
      });
      pinsByKey.set(c.key, marker);
    };

    const rebuild = () => {
      // Remember wherever the user is now, so returning from a photo lands here.
      const centre = map.getCenter();
      lastMapView = { center: [centre.lat, centre.lng], zoom: map.getZoom() };
      layer.clearLayers();
      pinsByKey = new Map();
      const bounds = map.getBounds().pad(0.5);
      for (const c of clustersFor(map.getZoom())) {
        if (!bounds.contains(c.latlng)) continue;
        addPin(c, c.rep.original_filename);
      }
      // The focused shot always gets a pin to zoom to and enlarge, even before
      // the geo data has arrived.
      if (focus && !pinsByKey.has(focus.id)) {
        const rep = { id: focus.id, lat: focus.lat, lon: focus.lon } as GeoImage;
        addPin({
          key: rep.id,
          rep,
          members: [rep],
          latlng: L.latLng(rep.lat, rep.lon),
          point: map.project([rep.lat, rep.lon], map.getZoom()),
        });
      }
      if (focus) pinsByKey.get(focus.id)?.getElement()?.classList.add("map-pin-active");
      // An open fan keeps its pin stepped back through pans.
      if (spider) pinsByKey.get(spider.key)?.getElement()?.classList.add("map-pin-dimmed");
    };

    map.on("moveend", rebuild);
    // Clusters regroup at a new zoom, so a fan can't survive one; folding it
    // before the zoom animation keeps its tiles from stretching apart.
    map.on("zoomstart", unspiderfy);
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
      map.off("moveend", rebuild);
      map.off("zoomstart", unspiderfy);
      map.off("click", unspiderfy);
      spiderLayer.remove();
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

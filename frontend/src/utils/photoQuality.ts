// Progressive photo quality for the canvas views.
//
// A placed photo paints a small derivative the moment it mounts and then
// climbs, in the background, to the 2048px preview and finally the
// full-resolution render: a canvas opens instantly, and ends up with every
// photo at true pixel quality - for zooming in, for the print view, for the
// Canvas Shelf on the Albums page and for the export.
//
// One download at a time, sharpest need first. /full is rendered on demand
// (around 14s for a raw) and the backend serves only the NEWEST outstanding
// full request, answering the others 409 - firing one per frame at once would
// lose all but one of them. Sequencing also keeps the climb from starving
// whatever the user is doing right now: a frame that is zoomed far in (the
// need/have ratio) goes to the head of the queue, and the whole climb stands
// still while the docked editor is open, so the editor's live preview
// renders never wait behind a stack of full-resolution ones.
//
// A URL that has decoded once is remembered for the session, so turning back
// to a page - or reopening the canvas - paints its sharp photos straight away
// instead of stepping down to the thumbnail again.
import { useEffect, useMemo, useState, type RefObject } from "react";
import { api } from "../api/client";

export type PhotoTier = 0 | 1 | 2; // thumbnail, preview, full
// The longest side each tier's bitmap has, for "how much more do I need".
const TIER_PX: Record<PhotoTier, number> = { 0: 1600, 1: 2048, 2: Infinity };

export function tierUrl(id: string, version: string | undefined, tier: PhotoTier): string {
  if (tier === 0) return api.images.thumbnailUrl(id, version);
  if (tier === 1) return api.images.previewUrl(id, version);
  return api.images.fullUrl(id, version);
}

type QualityWant = { url: string; need: () => number; onReady: () => void };

const decodedUrls = new Set<string>();
const qualityWants = new Set<QualityWant>();
const qualityRetries = new Map<string, { tries: number; retryAt: number }>();
let qualityInflight: { url: string; img: HTMLImageElement } | null = null;
let qualityTimer: number | undefined;
let qualityPaused = false;

// Hold the climb (docked editor open) or let it run again.
export function setQualityPaused(paused: boolean) {
  qualityPaused = paused;
  if (!paused) pumpQuality();
}

// Ask for `url` to be fetched and decoded; `onReady` fires once it is, and
// the returned function withdraws the request (frame unmounted, photo swapped).
export function requestQuality(url: string, need: () => number, onReady: () => void): () => void {
  if (decodedUrls.has(url)) {
    onReady();
    return () => {};
  }
  const want: QualityWant = { url, need, onReady };
  qualityWants.add(want);
  pumpQuality();
  return () => {
    qualityWants.delete(want);
    // Nobody is waiting on the download in flight any more: abandon it so the
    // page the user turned TO isn't queued behind the one they left.
    if (qualityInflight?.url === url && ![...qualityWants].some((other) => other.url === url)) {
      const { img } = qualityInflight;
      qualityInflight = null;
      img.onload = null;
      img.onerror = null;
      img.src = "";
      pumpQuality();
    }
  };
}

function pumpQuality() {
  if (qualityPaused || qualityInflight || qualityWants.size === 0) return;
  const now = Date.now();
  let best: QualityWant | null = null;
  let bestNeed = -Infinity;
  let soonest = Infinity;
  for (const want of qualityWants) {
    const retry = qualityRetries.get(want.url);
    if (retry && retry.retryAt > now) {
      soonest = Math.min(soonest, retry.retryAt);
      continue;
    }
    const need = want.need();
    if (need > bestNeed) {
      best = want;
      bestNeed = need;
    }
  }
  if (!best) {
    // Everything left is waiting out a retry delay: come back when it ends.
    if (soonest < Infinity) {
      window.clearTimeout(qualityTimer);
      qualityTimer = window.setTimeout(pumpQuality, soonest - now + 50);
    }
    return;
  }
  const { url } = best;
  const img = new Image();
  qualityInflight = { url, img };
  img.onload = () => {
    if (qualityInflight?.img !== img) return;
    qualityInflight = null;
    decodedUrls.add(url);
    qualityRetries.delete(url);
    for (const want of [...qualityWants]) {
      if (want.url !== url) continue;
      qualityWants.delete(want);
      want.onReady();
    }
    pumpQuality();
  };
  img.onerror = () => {
    if (qualityInflight?.img !== img) return;
    qualityInflight = null;
    // A 409 (a lightbox zoom elsewhere superseded this render) or a render
    // that failed outright: try again a few times with a growing pause, then
    // let the frame keep the tier it has - never a broken image.
    const retry = qualityRetries.get(url) ?? { tries: 0, retryAt: 0 };
    retry.tries += 1;
    if (retry.tries >= 4) {
      qualityRetries.delete(url);
      for (const want of [...qualityWants]) if (want.url === url) qualityWants.delete(want);
    } else {
      retry.retryAt = Date.now() + 1500 * retry.tries;
      qualityRetries.set(url, retry);
    }
    pumpQuality();
  };
  img.src = url;
}

// The tier a placed photo shows right now. It starts at `base` (or the
// sharpest tier this session has already decoded, whichever is higher) and
// climbs from there; the <img> keeps showing the old bitmap until the
// sharper one has decoded, so a step never flashes. A new version (an edit
// saved) or a swapped photo restarts the climb. `ref` is the <img> itself:
// its on-screen size, at the moment the queue picks what to fetch next, is
// how badly it needs more pixels - so the frame the user just zoomed into
// goes first, whatever transform put it there. `paused` holds this photo's
// climb (the editor's live frames are showing instead).
export function usePhotoTier(
  id: string | null,
  version: string | undefined,
  base: PhotoTier,
  ref: RefObject<HTMLImageElement | null>,
  paused = false
): PhotoTier {
  const key = id ? `${id}:${version ?? ""}` : "";
  const baseTier = useMemo<PhotoTier>(() => {
    if (!id) return base;
    if (decodedUrls.has(tierUrl(id, version, 2))) return 2;
    if (base < 1 && decodedUrls.has(tierUrl(id, version, 1))) return 1;
    return base;
    // The URLs are a pure function of the key; `base` never changes for a
    // mounted photo.
  }, [key]);
  const [climbed, setClimbed] = useState<{ key: string; tier: PhotoTier }>({ key, tier: baseTier });
  const tier: PhotoTier = climbed.key === key ? (Math.max(climbed.tier, baseTier) as PhotoTier) : baseTier;
  const nextUrl = id && tier < 2 ? tierUrl(id, version, (tier + 1) as PhotoTier) : null;
  useEffect(() => {
    if (!nextUrl || paused) return;
    const have = TIER_PX[tier];
    const need = () => {
      const box = ref.current?.getBoundingClientRect();
      const px = box ? Math.max(box.width, box.height) : 0;
      return (px * (window.devicePixelRatio || 1)) / have;
    };
    return requestQuality(nextUrl, need, () => setClimbed({ key, tier: (tier + 1) as PhotoTier }));
  }, [nextUrl, paused, key, tier, ref]);
  return tier;
}

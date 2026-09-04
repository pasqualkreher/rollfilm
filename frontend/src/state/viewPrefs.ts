import { useSyncExternalStore } from "react";
import type { ImageOut } from "../api/types";
import { collapsePairsBy } from "../utils/pairing";

// Global, persisted "light table" view preferences shared by every grid
// (Library, Album detail, Selects). Kept outside React-Query/router state so a
// single control on one screen changes the look everywhere at once and the
// choice survives reloads.

// Grid tile minimum width in px. "combined" grids look best a touch larger, but
// the value is purely how big each thumbnail renders - bigger = fewer per row.
export const THUMB_SIZES = [
  { key: "xs", label: "XS", px: 130 },
  { key: "s", label: "S", px: 180 },
  { key: "m", label: "M", px: 260 },
  { key: "l", label: "L", px: 360 },
  { key: "xl", label: "XL", px: 500 },
] as const;

export type ThumbSizeKey = (typeof THUMB_SIZES)[number]["key"];

const THUMB_KEY = "pm.thumbSize";
const MERGE_KEY = "pm.mergePairs";
// When on, deleting a photo that has a RAW/JPEG partner first asks whether to
// remove only the shown file or the whole pair. Off (default) keeps the old
// behaviour: a pair is one shot, so both halves go together, no prompt.
const ASK_DELETE_KEY = "pm.askDeletePartner";
// Pinned filter panel: the Filter chip's menu stays open, docked as a second row
// of the filter bar, instead of being a popover that closes on the next click.
// Shared by every screen with a filter bar (Library, Album detail, Import
// review), so pinning it once keeps it open wherever you cull.
const FILTER_PIN_KEY = "pm.filterPinned";
// When on, the editor's "Save copy" button opens the options dialog (JPEG
// quality slider + size cap) first. Off (default) is one click: the copy is
// baked at full quality and full size, which is what a copy you keep in the
// library should be - the dialog exists for the rarer case of deliberately
// making a smaller or lighter copy.
const ASK_SAVE_COPY_KEY = "pm.askSaveCopyOptions";
// Surround behind a photo shown big, in four steps from near-white to black.
// The steps are named rather than numbered - a row of percentages beside the
// zoom control's percentages reads as the same kind of setting, and nobody
// picks a surround by its ink coverage. The exact value (6%, 25% ink, the way
// a print shop and Photoshop mean it) stays in the tooltip. One preference for
// the library's photo view, the import review's preview and the editor - the
// whole point of the setting is judging a photo against a KNOWN neutral, which
// only works if it doesn't change when you move between the three. Gray is the
// default: it sits between the two extremes without pulling the photo either
// way. A key that is no longer offered (an older build's "medium") simply
// fails the check in readStageBg and falls back to it.
// Whether the lightbox shows its side panel (title, rating, tags, info,
// similar). Collapsing it gives the photo the whole window, which is what you
// want while actually LOOKING at pictures - so it is a preference, not a
// per-photo toggle: paging to the next photo must not bring the panel back.
// Stored inverted (only the closed state is written) so the default stays open
// for anyone who has never touched it.
const DETAIL_PANEL_KEY = "pm.detailPanel";
// How long the slideshow rests on each photo before moving on. A preference,
// not per-run state: the pace that suits someone's photos suits their next
// slideshow too, so the picker in the slideshow's control bar writes it here.
const SLIDESHOW_KEY = "pm.slideshowSeconds";
export const SLIDESHOW_SPEEDS = [3, 5, 10] as const;
export type SlideshowSeconds = (typeof SLIDESHOW_SPEEDS)[number];
const DEFAULT_SLIDESHOW_SECONDS: SlideshowSeconds = 5;
const STAGE_BG_KEY = "pm.stageBg";
export const STAGE_BACKGROUNDS = [
  { key: "lightest", label: "Paper", title: "Paper white (6% grey)" },
  { key: "light", label: "Gray", title: "Gray (25%) - the neutral to judge a photo against" },
  { key: "dark", label: "Black", title: "Black" },
] as const;
export type StageBg = (typeof STAGE_BACKGROUNDS)[number]["key"];
const DEFAULT_STAGE_BG: StageBg = "light";
const DEFAULT_THUMB: ThumbSizeKey = "m";
// The canvas filmstrip's chip width in px, set by dragging the strip's top
// edge up or down. null means "follow the shared thumbnail Size" - the
// default, and what a double-click on the edge goes back to.
const CANVAS_STRIP_KEY = "pm.canvasStripChip";
export const CANVAS_STRIP_MIN_PX = 48;
export const CANVAS_STRIP_MAX_PX = 360;

// Minimal external store so a preference change re-renders every subscribed grid
// in the same tab (the native "storage" event only fires in *other* tabs).
const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function readThumb(): ThumbSizeKey {
  const v = localStorage.getItem(THUMB_KEY);
  return THUMB_SIZES.some((s) => s.key === v) ? (v as ThumbSizeKey) : DEFAULT_THUMB;
}

function readCanvasStrip(): number | null {
  const v = Number(localStorage.getItem(CANVAS_STRIP_KEY));
  return Number.isFinite(v) && v >= CANVAS_STRIP_MIN_PX && v <= CANVAS_STRIP_MAX_PX ? Math.round(v) : null;
}

export function setCanvasStripChip(px: number | null) {
  if (px === null) localStorage.removeItem(CANVAS_STRIP_KEY);
  else localStorage.setItem(CANVAS_STRIP_KEY, String(Math.round(px)));
  emit();
}

export function useCanvasStripChip(): number | null {
  return useSyncExternalStore(subscribe, readCanvasStrip, () => null);
}

function readMerge(): boolean {
  return localStorage.getItem(MERGE_KEY) === "1";
}

function readAskDeletePartner(): boolean {
  return localStorage.getItem(ASK_DELETE_KEY) === "1";
}

function readFilterPinned(): boolean {
  return localStorage.getItem(FILTER_PIN_KEY) === "1";
}

function readAskSaveCopyOptions(): boolean {
  return localStorage.getItem(ASK_SAVE_COPY_KEY) === "1";
}

function readDetailPanel(): boolean {
  return localStorage.getItem(DETAIL_PANEL_KEY) !== "0";
}

function readSlideshowSeconds(): SlideshowSeconds {
  const v = Number(localStorage.getItem(SLIDESHOW_KEY));
  return (SLIDESHOW_SPEEDS as readonly number[]).includes(v)
    ? (v as SlideshowSeconds)
    : DEFAULT_SLIDESHOW_SECONDS;
}

function readStageBg(): StageBg {
  const v = localStorage.getItem(STAGE_BG_KEY);
  return STAGE_BACKGROUNDS.some((b) => b.key === v) ? (v as StageBg) : DEFAULT_STAGE_BG;
}

export function thumbPx(key: ThumbSizeKey): number {
  return THUMB_SIZES.find((s) => s.key === key)?.px ?? 200;
}

// Which thumbnail tier a grid size should request. XS/S get the 640px
// small.jpg: on a 4K display those sizes put several hundred tiles on screen,
// and full 1600px thumbnails (~6.4MB decoded each) overflow the renderer's
// decoded-image budget - Chromium then drops decoded tiles, which paint as
// empty cards until something (a hover) repaints them. 640px still covers the
// largest XS/S tile on a 2x display.
//
// A middle 1024px tier for M was tried and taken back out. The sizing argument
// held - an M tile is nowhere near 1600px on screen - but every existing photo
// would have had to have that file derived before it could be shown, and with a
// library on a slow disk that derivation landed squarely on the path of tiles
// scrolling into view. Any new tier needs the files to exist BEFORE the grid
// asks for them, i.e. a background backfill first and the client switched over
// only afterwards; a tier that has to be built on demand is a tier that makes
// browsing worse for exactly as long as it takes to build.
export function thumbTier(key: ThumbSizeKey): "small" | undefined {
  return key === "xs" || key === "s" ? "small" : undefined;
}

// Push the current size into CSS variables the grid reads, so we don't have to
// thread inline styles through every `.thumbnail-grid`. --row-h is the target
// height of a justified row (see .thumbnail-grid); --thumb-min is kept for any
// non-justified grids that still use a column min-width.
function applyThumbVar() {
  const px = thumbPx(readThumb());
  document.documentElement.style.setProperty("--thumb-min", `${px}px`);
  document.documentElement.style.setProperty("--row-h", `${px}px`);
}
applyThumbVar();

export function setThumbSize(key: ThumbSizeKey) {
  localStorage.setItem(THUMB_KEY, key);
  applyThumbVar();
  emit();
}

export function setMergePairs(on: boolean) {
  localStorage.setItem(MERGE_KEY, on ? "1" : "0");
  emit();
}

export function setAskDeletePartner(on: boolean) {
  localStorage.setItem(ASK_DELETE_KEY, on ? "1" : "0");
  emit();
}

export function setFilterPinned(on: boolean) {
  localStorage.setItem(FILTER_PIN_KEY, on ? "1" : "0");
  emit();
}

export function setAskSaveCopyOptions(on: boolean) {
  localStorage.setItem(ASK_SAVE_COPY_KEY, on ? "1" : "0");
  emit();
}

export function setDetailPanelOpen(on: boolean) {
  localStorage.setItem(DETAIL_PANEL_KEY, on ? "1" : "0");
  emit();
}

export function setStageBg(bg: StageBg) {
  localStorage.setItem(STAGE_BG_KEY, bg);
  emit();
}

export function setSlideshowSeconds(seconds: SlideshowSeconds) {
  localStorage.setItem(SLIDESHOW_KEY, String(seconds));
  emit();
}

export function useThumbSize(): ThumbSizeKey {
  return useSyncExternalStore(subscribe, readThumb, () => DEFAULT_THUMB);
}

export function useMergePairs(): boolean {
  return useSyncExternalStore(subscribe, readMerge, () => false);
}

export function useAskDeletePartner(): boolean {
  return useSyncExternalStore(subscribe, readAskDeletePartner, () => false);
}

export function useFilterPinned(): boolean {
  return useSyncExternalStore(subscribe, readFilterPinned, () => false);
}

export function useAskSaveCopyOptions(): boolean {
  return useSyncExternalStore(subscribe, readAskSaveCopyOptions, () => false);
}

export function useDetailPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, readDetailPanel, () => true);
}

export function useStageBg(): StageBg {
  return useSyncExternalStore(subscribe, readStageBg, () => DEFAULT_STAGE_BG);
}

export function useSlideshowSeconds(): SlideshowSeconds {
  return useSyncExternalStore(subscribe, readSlideshowSeconds, () => DEFAULT_SLIDESHOW_SECONDS);
}

// Collapse each RAW+JPEG pair down to a single representative card (the JPEG,
// which is what everyone actually looks at). The RAW partner is dropped from the
// list but the representative keeps `paired_image_id`, so it still shows the
// "RAW+JPG" badge and rating it can fan out to the RAW (see apply_to_pair).
export function collapsePairs(images: ImageOut[]): ImageOut[] {
  return collapsePairsBy(
    images,
    (img) => img.file_type,
    (img) => img.paired_image_id
  );
}

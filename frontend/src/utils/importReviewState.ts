// Where the user was in an import review, per session: the filters, the open
// preview and the scroll position. The wizard unmounts the moment another nav
// tab is clicked, and the session itself survives that (state/importSession)
// - but every one of these used to reset to its default on the way back,
// so "Hide duplicates" was ticked again, the lightbox was gone and the grid
// sat at the top. Sessions also outlive the app (they are resumable from the
// Import page's list), so this lives in localStorage rather than in memory.

import type { ColorLabel, ViewMode } from "../api/types";

export interface ReviewScrollAnchor {
  // First tile of the row that sat at the top of the viewport.
  id: string;
  // How far into that row the viewport top was, as a fraction of the row
  // height - the same measure useLayoutScrollAnchor keeps, so the grid can
  // be put back regardless of how the layout has reflowed in between.
  frac: number;
}

export interface ImportReviewState {
  hideDuplicates: boolean;
  viewMode: ViewMode;
  ratingMin: number;
  colorFilter: ColorLabel;
  uploadToImmich: boolean;
  syncAllToImmich: boolean;
  // The preview that was open, or null for none.
  lightboxFileId: string | null;
  scroll: ReviewScrollAnchor | null;
}

export const DEFAULT_REVIEW_STATE: ImportReviewState = {
  hideDuplicates: true,
  viewMode: "combined",
  ratingMin: 0,
  colorFilter: "none",
  uploadToImmich: false,
  syncAllToImmich: false,
  lightboxFileId: null,
  scroll: null,
};

const KEY = "pm:import-review-state";
// Sessions that were committed or discarded clear their entry; this cap only
// catches the ones that ended some other way (deleted from the list on
// another launch, a wiped library) so the record cannot grow without bound.
const MAX_ENTRIES = 20;

type Stored = Record<string, ImportReviewState & { at: number }>;

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage full/blocked - coming back to defaults is an acceptable loss */
  }
}

export function readReviewState(sessionId: string): ImportReviewState {
  const entry = readAll()[sessionId];
  if (!entry) return DEFAULT_REVIEW_STATE;
  // Fill in anything a record written by an older build lacks.
  const { hideDuplicates, viewMode, ratingMin, colorFilter, uploadToImmich, syncAllToImmich, lightboxFileId, scroll } = entry;
  return {
    ...DEFAULT_REVIEW_STATE,
    hideDuplicates,
    viewMode,
    ratingMin,
    colorFilter,
    uploadToImmich,
    syncAllToImmich,
    lightboxFileId,
    scroll,
  };
}

export function updateReviewState(sessionId: string, patch: Partial<ImportReviewState>): void {
  const all = readAll();
  const prev = all[sessionId];
  all[sessionId] = { ...DEFAULT_REVIEW_STATE, ...prev, ...patch, at: Date.now() };
  const ids = Object.keys(all);
  if (ids.length > MAX_ENTRIES) {
    ids
      .sort((a, b) => all[a].at - all[b].at)
      .slice(0, ids.length - MAX_ENTRIES)
      .forEach((id) => delete all[id]);
  }
  writeAll(all);
}

export function clearReviewState(sessionId: string): void {
  const all = readAll();
  if (!(sessionId in all)) return;
  delete all[sessionId];
  writeAll(all);
}

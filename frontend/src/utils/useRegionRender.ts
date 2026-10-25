// The photo view's full resolution, the editor's way: what is on screen is
// rendered from the full-resolution decode the server keeps for one photo
// (POST editor-preview, native tier). Zoomed in that is the visible part
// alone (`region`); at fit it is the whole frame at the screen's size (`px`,
// no region - the server refuses a region of nearly the whole frame anyway).
// A whole-frame full.jpg of an edited 40MP raw was the decode plus half a
// minute of pipeline at sensor size; either render here is about a second
// once the decode is in.
//
// The first ask of a photo starts that decode: the server answers "pending"
// (`nativeOnly`) until it has landed, and this comes back every few seconds -
// the half tier under the tile stands meanwhile, so nothing is rendered twice.
// A new ask leaves the last tile on screen until the next one has decoded.
// `viewer` keeps these renders out of the editor's bookkeeping (activity,
// newest-render slot).

import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { ImageOut } from "../api/types";
import { adjustmentsAreNeutral, editsFromImage } from "./adjustments";

/** Fractions of the finished frame, plus the tile's long edge in device pixels. */
export interface RegionAsk {
  x: number;
  y: number;
  w: number;
  h: number;
  px: number;
}

export interface RegionRender {
  state: "idle" | "loading" | "ready" | "failed";
  /** Object URL of the newest tile for this photo/edit. */
  src: string | null;
  /** Where `src` sits, in fractions of the frame. */
  box: { x: number; y: number; w: number; h: number } | null;
  /** The region asked for last (for "is the view still covered"). */
  asked: RegionAsk | null;
  /** A tile for the current ask is still on its way. */
  pending: boolean;
}

const RETRY_STATUSES = new Set([425, 429, 502, 503, 504]);
const RETRY_MS = 1500;
const MAX_ATTEMPTS = 12;
// How often to ask whether the full-resolution decode has landed.
const NATIVE_POLL_MS = 2500;
const NATIVE_POLLS = 24;

function statusOf(err: unknown): number | null {
  const m = err instanceof Error ? /(\d{3})$/.exec(err.message) : null;
  return m ? Number(m[1]) : null;
}

const IDLE: RegionRender = { state: "idle", src: null, box: null, asked: null, pending: false };

export function useRegionRender(image: ImageOut | undefined, region: RegionAsk | null): RegionRender {
  const identity = image ? `${image.id}:${image.edit_rev}` : null;
  const [result, setResult] = useState<RegionRender & { identity: string | null }>({ ...IDLE, identity: null });
  const publishedRef = useRef<string | null>(null);
  const inflightRef = useRef<{ ctrl: AbortController; timer?: number } | null>(null);
  const imageRef = useRef(image);
  imageRef.current = image;
  const regionKey = region
    ? [region.x, region.y, region.w, region.h].map((n) => n.toFixed(4)).join(",") + `@${region.px}`
    : null;

  const abortInflight = () => {
    const f = inflightRef.current;
    if (!f) return;
    f.ctrl.abort();
    window.clearTimeout(f.timer);
    inflightRef.current = null;
  };

  // A new photo or edit: the tile on screen belongs to the old one.
  useEffect(() => {
    abortInflight();
    if (publishedRef.current) URL.revokeObjectURL(publishedRef.current);
    publishedRef.current = null;
    setResult({ ...IDLE, identity });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  useEffect(() => {
    if (!identity || !region) {
      abortInflight();
      setResult((r) => (r.pending ? { ...r, pending: false } : r));
      return;
    }
    abortInflight();
    const ask = region;
    setResult((r) => ({ ...r, identity, state: r.src ? r.state : "loading", asked: ask, pending: true }));

    const img = imageRef.current!;
    const ctrl = new AbortController();
    const flight: { ctrl: AbortController; timer?: number } = { ctrl };
    inflightRef.current = flight;
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        flight.timer = window.setTimeout(resolve, ms);
      });
    const edits = editsFromImage(img);
    // An edit from before raw bases existed with nothing developed is shown
    // auto-exposed everywhere else (thumbnails._browsing_gain); the editor
    // route only lifts it when asked to.
    const browse =
      img.file_type === "raw" && edits.adjustments.raw_base === "legacy" && adjustmentsAreNeutral(edits.adjustments);

    const publish = async (blob: Awaited<ReturnType<typeof api.images.editorPreview>>) => {
      const url = URL.createObjectURL(blob);
      const el = new Image();
      el.src = url;
      try {
        await el.decode();
      } catch {
        /* sized below from the headers alone */
      }
      if (ctrl.signal.aborted) {
        URL.revokeObjectURL(url);
        return;
      }
      // Without frame headers the server rendered the whole frame (an effect
      // that can't be cut to a region): the tile is the photo.
      let box = { x: 0, y: 0, w: 1, h: 1 };
      if (blob.frame && blob.box) {
        const bw = blob.box.w ?? el.naturalWidth;
        const bh = blob.box.h ?? el.naturalHeight;
        box = { x: blob.box.x / blob.frame.w, y: blob.box.y / blob.frame.h, w: bw / blob.frame.w, h: bh / blob.frame.h };
      }
      const previous = publishedRef.current;
      publishedRef.current = url;
      setResult({ identity, state: "ready", src: url, box, asked: ask, pending: false });
      if (previous) window.setTimeout(() => URL.revokeObjectURL(previous), 1000);
    };

    // Nearly the whole frame: asked for as a whole frame at `px` (the server
    // renders it from the native base at that size), not as a region.
    const whole = ask.w * ask.h > 0.8;

    (async () => {
      let polls = 0;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let blob: Awaited<ReturnType<typeof api.images.editorPreview>>;
        try {
          blob = await api.images.editorPreview(
            img.id,
            edits,
            ctrl.signal,
            "native",
            browse,
            null,
            whole ? null : { x: ask.x, y: ask.y, w: ask.w, h: ask.h },
            false,
            ask.px,
            true,
            null,
            true
          );
        } catch (err) {
          if (ctrl.signal.aborted) return;
          const status = statusOf(err);
          const retry = (err instanceof DOMException && err.name === "AbortError") || (status !== null && RETRY_STATUSES.has(status));
          if (!retry) break;
          await wait(RETRY_MS);
          if (ctrl.signal.aborted) return;
          continue;
        }
        if (ctrl.signal.aborted) return;
        if (blob.servedTier === "pending") {
          // The full-resolution decode is still running; the half tier stands.
          if (++polls > NATIVE_POLLS) break;
          await wait(NATIVE_POLL_MS);
          if (ctrl.signal.aborted) return;
          attempt--;
          continue;
        }
        await publish(blob);
        return;
      }
      if (ctrl.signal.aborted) return;
      setResult((r) => (r.src ? { ...r, pending: false } : { ...r, state: "failed", pending: false }));
    })().finally(() => {
      if (inflightRef.current === flight) inflightRef.current = null;
    });
    // `image` is read through a ref; id/edit_rev are in `identity`, the ask in
    // `regionKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, regionKey]);

  useEffect(
    () => () => {
      abortInflight();
      if (publishedRef.current) URL.revokeObjectURL(publishedRef.current);
      publishedRef.current = null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  if (result.identity !== identity) return IDLE;
  const { identity: _identity, ...out } = result;
  return out;
}

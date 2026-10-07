// The photo view's "other side" of a compare: the original (the photo with
// its tonal edits taken off, in the geometry the edit is shown in) or the
// raw's camera JPEG, rendered by the editor's own preview route so what the
// view compares against is exactly what the editor compares against.
//
// There is no file for either: the original is a server render of neutral
// adjustments (`browse=1` for the library's auto-exposure, not the editor's
// dark native base), the camera JPEG is `reference=pair`. Both go through
// POST editor-preview, which answers with a Blob - so, like
// useFullResUpgrade, this hands the pixels over as a decoded object URL.
//
// Tiers: the fit view asks for the ultra tier sized to the screen; zoomed in,
// the native tier. A native request is answered from the tier below while the
// full-resolution base is still decoding (servedTier != "native"), and this
// comes back for the sharp one with `nativeOnly` until it lands.

import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { ImageOut } from "../api/types";
import { editsFromImage, neutralEdits } from "./adjustments";

export type BaselineKind = "original" | "jpg";
export type BaselineTier = "ultra" | "native";

export interface BaselineAsk {
  image: ImageOut | undefined;
  baseline: BaselineKind;
  /** False: nothing is wanted - the fetch is aborted and the render released. */
  wanted: boolean;
  tier: BaselineTier;
  /** Long edge in device pixels, rounded and capped by the caller. */
  px: number;
}

export interface BaselineRender {
  state: "idle" | "loading" | "ready" | "failed";
  /** Object URL of the best render so far for this photo/edit/baseline. */
  src: string | null;
  /** `src` is up but a sharper (native) frame is still on its way. */
  pending: boolean;
}

// Answers that mean "busy, ask again" (the route sheds load on purpose).
const RETRY_STATUSES = new Set([425, 429, 502, 503, 504]);
const RETRY_MS = 1500;
const MAX_ATTEMPTS = 12;
// How often to ask whether the full-resolution base has landed.
const NATIVE_POLL_MS = 2500;
const NATIVE_POLLS = 24;

function statusOf(err: unknown): number | null {
  const m = err instanceof Error ? /(\d{3})$/.exec(err.message) : null;
  return m ? Number(m[1]) : null;
}

export function useBaselineRender(ask: BaselineAsk): BaselineRender {
  const { image, baseline, wanted, tier, px } = ask;
  const identity = wanted && image ? `${image.id}:${image.edit_rev}:${baseline}` : null;
  const [result, setResult] = useState<BaselineRender & { identity: string | null }>({
    identity: null,
    state: "idle",
    src: null,
    pending: false,
  });
  // What has been asked for under the current identity - a smaller ask is
  // covered by a bigger render already on screen (or on its way).
  const askedRef = useRef<{ identity: string | null; tier: BaselineTier; px: number }>({
    identity: null,
    tier: "ultra",
    px: 0,
  });
  // The published object URL, revoked when the identity moves on.
  const publishedRef = useRef<string | null>(null);
  // The request on its way, if any. Held in a ref rather than the effect's
  // closure: an ask the render on its way already covers must leave it
  // running, and an effect's cleanup would have aborted it first.
  const inflightRef = useRef<{ ctrl: AbortController; timer?: number } | null>(null);
  const imageRef = useRef(image);
  imageRef.current = image;

  const abortInflight = () => {
    const f = inflightRef.current;
    if (!f) return;
    f.ctrl.abort();
    window.clearTimeout(f.timer);
    inflightRef.current = null;
  };

  useEffect(() => {
    if (!identity) {
      abortInflight();
      askedRef.current = { identity: null, tier: "ultra", px: 0 };
      if (publishedRef.current) URL.revokeObjectURL(publishedRef.current);
      publishedRef.current = null;
      setResult({ identity: null, state: "idle", src: null, pending: false });
      return;
    }
    const asked = askedRef.current;
    const sameIdentity = asked.identity === identity;
    // Already covered: a render at least as big, from the same tier or from
    // the native base, serves this ask - so zooming back out after a native
    // render keeps it, and a window resize of a few pixels renders nothing.
    if (sameIdentity && asked.px >= px && (asked.tier === tier || asked.tier === "native")) return;
    abortInflight();
    askedRef.current = { identity, tier, px };
    if (!sameIdentity) {
      if (publishedRef.current) URL.revokeObjectURL(publishedRef.current);
      publishedRef.current = null;
      setResult({ identity, state: "loading", src: null, pending: false });
    } else {
      setResult((r) => ({ ...r, pending: true }));
    }

    const img = imageRef.current!;
    const ctrl = new AbortController();
    const flight: { ctrl: AbortController; timer?: number } = { ctrl };
    inflightRef.current = flight;
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        flight.timer = window.setTimeout(resolve, ms);
      });
    // The pair reference uses the geometry alone; the original is that
    // geometry with neutral adjustments. Same edits object for both.
    const g = editsFromImage(img);
    const edits = neutralEdits(g.rotation, g.crop, g.flipH, g.flipV, g.straighten, g.perspH, g.perspV, g.distortion);
    const reference = baseline === "jpg" ? ("pair" as const) : null;
    const browse = baseline === "original";

    const publish = async (blob: Blob) => {
      const url = URL.createObjectURL(blob);
      try {
        const el = new Image();
        el.src = url;
        await el.decode();
      } catch {
        /* the <img> decodes it itself */
      }
      if (ctrl.signal.aborted) {
        URL.revokeObjectURL(url);
        return false;
      }
      const previous = publishedRef.current;
      publishedRef.current = url;
      setResult({ identity, state: "ready", src: url, pending: false });
      // The <img> has the new URL by the next paint; the old one may go then.
      if (previous) window.setTimeout(() => URL.revokeObjectURL(previous), 1000);
      return true;
    };

    (async () => {
      let nativeOnly = false;
      let polls = 0;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let blob: Awaited<ReturnType<typeof api.images.editorPreview>> | null = null;
        try {
          blob = await api.images.editorPreview(
            img.id,
            edits,
            ctrl.signal,
            tier,
            browse,
            null,
            null,
            false,
            px,
            nativeOnly,
            reference
          );
        } catch (err) {
          if (ctrl.signal.aborted) return;
          const status = statusOf(err);
          // A 409 is the server's "superseded" - a straggler from an earlier
          // ask of ours, not a failure. Busy answers are asked again.
          const retry = (err instanceof DOMException && err.name === "AbortError") || (status !== null && RETRY_STATUSES.has(status));
          if (!retry) break;
          await wait(RETRY_MS);
          if (ctrl.signal.aborted) return;
          continue;
        }
        if (ctrl.signal.aborted) return;
        if (blob.servedTier === "pending") {
          // The native base is still decoding; the frame on screen stands.
          if (++polls > NATIVE_POLLS) {
            setResult((r) => ({ ...r, pending: false }));
            return;
          }
          await wait(NATIVE_POLL_MS);
          if (ctrl.signal.aborted) return;
          attempt--;
          continue;
        }
        if (!(await publish(blob))) return;
        // A native ask answered from the tier below (the base is decoding):
        // come back for the sharp frame. The JPG reference has no base to wait
        // for; its tier header is what was asked.
        if (tier === "native" && reference === null && blob.servedTier !== "native") {
          nativeOnly = true;
          if (++polls > NATIVE_POLLS) {
            setResult((r) => ({ ...r, pending: false }));
            return;
          }
          setResult((r) => ({ ...r, pending: true }));
          await wait(NATIVE_POLL_MS);
          if (ctrl.signal.aborted) return;
          attempt--;
          continue;
        }
        return;
      }
      if (ctrl.signal.aborted) return;
      // Nothing published for this identity: a failure. With a frame already
      // up, the sharper one just isn't coming.
      setResult((r) =>
        r.src && r.identity === identity ? { ...r, pending: false } : { identity, state: "failed", src: null, pending: false }
      );
      // Let a later activation ask again.
      askedRef.current = { identity: null, tier: "ultra", px: 0 };
    })().finally(() => {
      if (inflightRef.current === flight) inflightRef.current = null;
    });
    // `image` is read through a ref: its row object changes identity on every
    // refetch, and only id/edit_rev (both in `identity`) matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, tier, px, baseline]);

  // Release the render and the request when the view goes away.
  useEffect(
    () => () => {
      abortInflight();
      if (publishedRef.current) URL.revokeObjectURL(publishedRef.current);
      publishedRef.current = null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  if (result.identity !== identity) {
    return { state: identity ? "loading" : "idle", src: null, pending: false };
  }
  return { state: result.state, src: result.src, pending: result.pending };
}

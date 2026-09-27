// The off-screen fetch of a raw's full-resolution render, shared by the
// library lightbox and the import review lightbox.
//
// The render is seconds away and the server sheds load on purpose: 409 when a
// newer zoom (or the lightbox's own warm-up) has claimed the render slot, 503
// when the slot stayed busy past the route's wait. Both mean "not yet", not
// "never" - but the old <img>-based loaders could not tell them from a broken
// file, latched a failure on the first one and left the lower tier on screen
// for the rest of the visit, badge gone, looking like the full resolution.
// This asks again on those, gives up only on a real failure, and hands the
// pixels over as a decoded object URL so the swap on the stage is instant.

import { useEffect, useState } from "react";

export type FullResState = "idle" | "loading" | "ready" | "failed";

export interface FullRes {
  state: FullResState;
  /** Object URL of the fetched render once `state` is "ready", else null. */
  src: string | null;
}

// Answers that mean "busy, ask again", and how long to wait when the server
// sends no Retry-After.
const RETRY_STATUSES = new Set([409, 425, 429, 502, 503, 504]);
const RETRY_MS = 1500;
// A render that is merely queued behind others clears well inside this; a
// server that keeps refusing for this long is not going to render it.
const MAX_ATTEMPTS = 12;

// `url` null = not wanted (yet). A new url starts over; the previous fetch is
// aborted and its object URL revoked.
export function useFullResUpgrade(url: string | null): FullRes {
  const [result, setResult] = useState<FullRes & { url: string | null }>({
    url: null,
    state: "idle",
    src: null,
  });

  useEffect(() => {
    if (!url) {
      setResult({ url: null, state: "idle", src: null });
      return;
    }
    const ctrl = new AbortController();
    let objectUrl: string | null = null;
    let timer: number | undefined;
    setResult({ url, state: "loading", src: null });

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = window.setTimeout(resolve, ms);
      });

    (async () => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let res: Response | null = null;
        try {
          res = await fetch(url, { signal: ctrl.signal });
        } catch {
          if (ctrl.signal.aborted) return;
          // Connection hiccup (backend busy restarting a worker, etc.): retry.
        }
        if (ctrl.signal.aborted) return;
        if (res?.ok) {
          let blob: Blob;
          try {
            blob = await res.blob();
          } catch {
            if (ctrl.signal.aborted) return;
            continue;
          }
          if (ctrl.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          // Decode before the swap: a 40MP JPEG decoded at paint time stalls
          // the frame it lands in. A decode that refuses (too large for the
          // off-screen path) still leaves a perfectly usable URL.
          try {
            const img = new Image();
            img.src = objectUrl;
            await img.decode();
          } catch {
            /* the <img> decodes it itself */
          }
          if (ctrl.signal.aborted) return;
          setResult({ url, state: "ready", src: objectUrl });
          return;
        }
        if (res && !RETRY_STATUSES.has(res.status)) break;
        const retryAfter = Number(res?.headers.get("Retry-After"));
        await wait(retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : RETRY_MS);
        if (ctrl.signal.aborted) return;
      }
      setResult({ url, state: "failed", src: null });
    })();

    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  // A render for the previous url must never be reported for this one.
  return result.url === url ? { state: result.state, src: result.src } : { state: url ? "loading" : "idle", src: null };
}

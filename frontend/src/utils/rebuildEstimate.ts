import { useEffect, useRef, useState } from "react";

// Rough "how long will this take?" estimates for the long-running Library
// maintenance jobs (sync, rebuild-all-thumbnails). They run as one blocking
// request with no progress stream, so instead of faking a countdown we show a
// pre-flight estimate and, while it runs, a live elapsed timer.
//
// The estimate is self-calibrating: each finished run records how many seconds
// per photo it actually took (in localStorage), so the next estimate reflects
// this machine and library rather than a hard-coded guess.

// Seconds per photo used before we've measured a real run. Thumbnail rebuilds
// re-decode every original (RAWs are slow); a library sync is mostly a disk +
// DB scan, so it's much cheaper per photo.
// The rebuild key is versioned: ".v2" started when the rebuild went parallel -
// rates calibrated on the old sequential runs would overestimate ~3x, so the
// old key's stored value is deliberately abandoned.
const DEFAULT_SEC_PER_PHOTO: Record<string, number> = {
  "pm.est.rebuildThumbs.v2": 0.35,
  "pm.est.sync": 0.03,
};

function secPerPhoto(key: string): number {
  const stored = parseFloat(localStorage.getItem(key) ?? "");
  if (isFinite(stored) && stored > 0) return stored;
  return DEFAULT_SEC_PER_PHOTO[key] ?? 0.3;
}

// Fold the latest measured rate into the stored one so a single odd run (cold
// cache, laptop asleep mid-job) doesn't swing the estimate wildly.
export function recordRate(key: string, seconds: number, photos: number) {
  if (photos <= 0 || seconds <= 0) return;
  const fresh = seconds / photos;
  const prev = parseFloat(localStorage.getItem(key) ?? "");
  const next = isFinite(prev) && prev > 0 ? prev * 0.6 + fresh * 0.4 : fresh;
  localStorage.setItem(key, String(next));
}

export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

// Estimated total seconds for the whole run, or null when we can't estimate
// yet (count not loaded / empty library).
export function estimateSeconds(count: number | undefined, key: string): number | null {
  if (count == null || count <= 0) return null;
  return count * secPerPhoto(key);
}

// Pre-flight estimate line, e.g. "≈ 3,204 photos · about 24m". null when the
// count isn't loaded yet or the library is empty (nothing to estimate).
export function estimateText(count: number | undefined, key: string): string | null {
  const est = estimateSeconds(count, key);
  if (est == null) return null;
  return `≈ ${count!.toLocaleString()} photos · about ${formatDuration(est)}`;
}

// The live "… elapsed · ~X left" line while a job runs. Falls back to just the
// elapsed time once we pass the estimate (or have none), so it never counts
// into negative or claims a job is done when it isn't.
export function progressText(elapsedMs: number, estimateSec: number | null): string {
  const elapsedSec = elapsedMs / 1000;
  const elapsed = `${formatDuration(elapsedSec)} elapsed`;
  if (estimateSec == null) return elapsed;
  const remaining = estimateSec - elapsedSec;
  if (remaining <= 5) return `${elapsed} · finishing up…`;
  return `${elapsed} · ~${formatDuration(remaining)} left`;
}

// Milliseconds since `active` last turned true; resets to 0 when it's false.
// Drives the "Rebuilding… (1m 12s)" live timer next to a running job.
export function useElapsed(active: boolean): number {
  const [ms, setMs] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active) {
      startRef.current = null;
      setMs(0);
      return;
    }
    startRef.current = Date.now();
    setMs(0);
    const t = window.setInterval(() => {
      setMs(Date.now() - (startRef.current ?? Date.now()));
    }, 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return ms;
}

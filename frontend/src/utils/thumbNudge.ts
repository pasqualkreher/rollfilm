// "The pictures a grid tile may be waiting for have landed."
//
// After a bulk edit the backend re-renders in the background and the tiles find
// their new picture through their retry ladder - whose later steps are tens of
// seconds long. When the app learns that those renders are through
// (state/tasks.tsx) it nudges, and every waiting tile asks again at once
// instead of when its timer runs out (components/ThumbnailGrid.tsx).
const subscribers = new Set<() => void>();

export function onThumbNudge(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function nudgeWaitingThumbs() {
  for (const fn of [...subscribers]) fn();
}

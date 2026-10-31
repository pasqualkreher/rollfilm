// What the menu bar's File and Photo items can act on right now: the view on
// screen says so, the shell greys out the rest (main.js applyMenuTargets).
import { useEffect } from "react";

export interface MenuTargets {
  rate?: boolean;
  color?: boolean;
  flag?: boolean;
  edit?: boolean;
  export?: boolean;
  trash?: boolean;
}

let sent = "";

function send(targets: MenuTargets): void {
  const key = JSON.stringify(targets);
  if (key === sent) return;
  sent = key;
  window.photoManager?.setMenuTargets?.(targets);
}

// A reload starts from nothing, whatever the shell last heard, for the views
// that never report at all (the map, settings).
send({});

// Only one view reports at a time (one route is mounted). Leaving it greys the
// items again until the next view has said what it takes.
export function useMenuTargets(targets: MenuTargets): void {
  const key = JSON.stringify(targets);
  useEffect(() => {
    send(JSON.parse(key) as MenuTargets);
  }, [key]);
  useEffect(() => () => send({}), []);
}

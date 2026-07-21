import type { Adjustments } from "./adjustments";

// A saved editing preset: the whole develop object (tone / colour / presence /
// details / effects, plus the nested curves / grading / masks). Geometry
// (rotation / crop / flip / straighten / perspective / distortion) is
// intentionally excluded - it's per photo, not a look. Stored in localStorage so
// presets persist across sessions.
export interface EditPreset {
  adjustments: Adjustments;
}

const KEY = "pm.editorPresets";

export function loadPresets(): Record<string, EditPreset> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, EditPreset>;
  } catch {
    return {};
  }
}

export function savePreset(name: string, preset: EditPreset): void {
  const all = loadPresets();
  all[name] = preset;
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function deletePreset(name: string): void {
  const all = loadPresets();
  delete all[name];
  localStorage.setItem(KEY, JSON.stringify(all));
}

import type { Adjustments, ColorMix } from "./adjustments";

// A saved editing preset: the tonal sliders + colour mixer + vignette +
// distortion. Geometry (rotation/crop) is intentionally excluded - it's per
// photo, not a look. Stored in localStorage so presets persist across sessions.
export interface EditPreset {
  adj: Adjustments;
  colorMix: ColorMix;
  vignette: number;
  distortion: number;
  grain: number;
  grainSize: number;
  denoise: number;
  clarity: number;
  sharpness: number;
  colorTint: number;
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

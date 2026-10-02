import { normalizeAdjustments, type Adjustments } from "./adjustments";

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

// The develop object applying a preset gives: complete and in range, whatever
// shape it was saved under. A preset that says nothing about the raw base
// (saved before the Normalize switch existed) is applied with Normalize on,
// like every new edit - left as it is, the photo would drop to the dark native
// base with the switch off.
export function presetAdjustments(preset: EditPreset): Adjustments {
  const adj = normalizeAdjustments(preset.adjustments);
  return adj.raw_base === "legacy" ? { ...adj, raw_base: "standard" } : adj;
}

// The look as a preset stores it. A photo still on the base of an older edit
// is shown without the lift in the editor, so that is what the preset keeps.
export function presetFromAdjustments(adj: Adjustments): EditPreset {
  return { adjustments: adj.raw_base === "legacy" ? { ...adj, raw_base: "native" } : adj };
}

// --- Export / import ---------------------------------------------------------
// Presets live in this computer's browser storage; a file carries them to
// another one (or keeps them safe). One JSON file holds any number of presets.

const FILE_FORMAT = "rollfilm-presets";

export function presetsToFile(presets: Record<string, EditPreset>): string {
  return JSON.stringify({ format: FILE_FORMAT, version: 1, presets }, null, 2);
}

// The presets a file holds, by name - each one complete and in range, however
// it was written. Null when the text is not a preset file at all.
export function presetsFromFile(text: string): Record<string, EditPreset> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const file = parsed as { format?: unknown; presets?: unknown } | null;
  if (!file || file.format !== FILE_FORMAT || !file.presets || typeof file.presets !== "object") return null;
  const out: Record<string, EditPreset> = {};
  for (const [name, preset] of Object.entries(file.presets as Record<string, unknown>)) {
    const adjustments = (preset as { adjustments?: unknown } | null)?.adjustments;
    if (!name.trim() || !adjustments || typeof adjustments !== "object") continue;
    out[name.trim()] = { adjustments: presetAdjustments({ adjustments: adjustments as Adjustments }) };
  }
  return out;
}

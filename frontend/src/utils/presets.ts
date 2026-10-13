import { api } from "../api/client";
import { normalizeAdjustments, type Adjustments } from "./adjustments";

// A saved editing preset: the whole develop object (tone / colour / presence /
// details / effects, plus the nested curves / grading / masks). Geometry
// (rotation / crop / flip / straighten / perspective / distortion) is
// intentionally excluded - it's per photo, not a look.
//
// Presets live in the library's database (routes/develop_presets.py), so they
// are in the backup and on every computer that opens the library. The editor
// and the grids read them synchronously, so this module keeps a cache of
// them, filled at start (initPresets) and kept in step by every write here;
// listeners (subscribePresets) hear when it changes. Presets from before -
// in this browser's storage - are moved into the database once.
export interface EditPreset {
  adjustments: Adjustments;
}

const LEGACY_KEY = "pm.editorPresets";

let cache: Record<string, EditPreset> = {};
const ids = new Map<string, string>();
const listeners = new Set<() => void>();
let started: Promise<void> | null = null;

function publish() {
  for (const l of listeners) l();
}

export function subscribePresets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function refresh(): Promise<void> {
  const rows = await api.developPresets.list();
  const next: Record<string, EditPreset> = {};
  ids.clear();
  for (const row of rows) {
    next[row.name] = { adjustments: row.adjustments as unknown as Adjustments };
    ids.set(row.name, row.id);
  }
  cache = next;
  publish();
}

// Once per app start: the old browser presets go to the database first (the
// server's import takes the old file format as it is), then the list is read.
export function initPresets(): Promise<void> {
  if (started) return started;
  started = (async () => {
    let legacy: string | null = null;
    try {
      legacy = localStorage.getItem(LEGACY_KEY);
    } catch {
      legacy = null;
    }
    if (legacy && legacy !== "{}") {
      try {
        await api.developPresets.importFile({ format: FILE_FORMAT, version: 1, presets: JSON.parse(legacy) });
        localStorage.removeItem(LEGACY_KEY);
      } catch {
        // Left in place: the next start tries again.
      }
    }
    try {
      await refresh();
    } catch {
      started = null; // the backend was not up yet: try again on the next call
    }
  })();
  return started;
}

export function loadPresets(): Record<string, EditPreset> {
  return { ...cache };
}

export function savePreset(name: string, preset: EditPreset): void {
  cache = { ...cache, [name]: preset };
  publish();
  const id = ids.get(name);
  const write = id
    ? api.developPresets.update(id, { adjustments: preset.adjustments })
    : api.developPresets.create({ name, adjustments: preset.adjustments });
  void write.then((row) => ids.set(row.name, row.id)).catch(() => void refresh().catch(() => {}));
}

export function deletePreset(name: string): void {
  const { [name]: _gone, ...rest } = cache;
  cache = rest;
  publish();
  const id = ids.get(name);
  ids.delete(name);
  if (id) void api.developPresets.remove(id).catch(() => void refresh().catch(() => {}));
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
// Retouch spots stay out: a healed speck sits where it sat on its own photo,
// so a look carries none (masks do travel - a sky gradient is part of a look).
export function presetFromAdjustments(adj: Adjustments): EditPreset {
  const look = { ...adj, spots: [] };
  return { adjustments: look.raw_base === "legacy" ? { ...look, raw_base: "native" } : look };
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

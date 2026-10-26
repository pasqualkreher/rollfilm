import { useMemo, useState } from "react";
import { loadPresets } from "../utils/presets";
import { noteRecent, shortList } from "../utils/recents";
import { Dropdown, type DropdownOption } from "./Dropdown";
import { IconAlbum, IconCanvas, IconPencil, IconPlus } from "./Icons";
import { PickerDialog } from "./PickerDialog";
import { Presence } from "./Presence";
import { MOTION } from "../utils/usePresence";

interface Props {
  onAutoEdit: () => void | Promise<unknown>;
  onApplyPreset: (name: string) => void | Promise<unknown>;
  // The same, followed by a JPEG copy of every photo with that edit baked in
  // (the originals keep the edit too; the copies carry the tags).
  onAutoEditAndCopy: () => void | Promise<unknown>;
  onApplyPresetAndCopy: (name: string) => void | Promise<unknown>;
  // A copy of every photo with the edit on it, the originals untouched (the
  // copy's kind - a file or a virtual copy - is asked first).
  onAutoEditOnCopy: () => void | Promise<unknown>;
  onApplyPresetOnCopy: (name: string) => void | Promise<unknown>;
  busy?: boolean;
}

// The three ways an edit goes on: on the photos, on the photos with a copy
// saved afterwards, on a copy only.
export type EditRowMode = "apply" | "copy" | "on-copy";
type Mode = EditRowMode;

export const EDIT_MODE_TEXT: Record<Mode, { heading: string; auto: string; suffix: string; title: string }> = {
  apply: { heading: "Apply preset", auto: "Apply auto edit", suffix: "", title: "Apply preset" },
  copy: { heading: "Apply and save copy", auto: "Apply auto edit and save copy", suffix: " and save copy", title: "Apply preset and save copy" },
  "on-copy": { heading: "Edit a copy", auto: "Auto edit a copy", suffix: " on a copy", title: "Preset on a copy" },
};
const MODE_TEXT = EDIT_MODE_TEXT;

// One row of a menu shared by a bar's dropdown and the right-click menu's
// submenu, so both list the same things under the same words: a heading, a
// row to pick, a greyed note, or a rule (the dropdown leaves rules out).
export interface MenuRow {
  kind: "head" | "item" | "note" | "sep";
  id: string;
  label: string;
  // The glyph the bar's dropdown puts in front of the label.
  icon?: "pencil" | "album" | "canvas" | "plus";
  // What typing matches in the dropdown, where the label is not enough.
  search?: string;
}

// The bar's Edit… menu as rows (the right-click menu's "Edit" submenu uses
// the same): per mode a heading, the automatic edit (when offered), the
// presets used last and "More presets… (n)" for the rest. Ids:
// "auto:<mode>", "preset:<mode>:<name>", "more:<mode>" (parseEditRow).
// `presets` newest first.
export function editMenuRows(presets: string[], auto: boolean): MenuRow[] {
  const rows: MenuRow[] = [];
  for (const mode of ["apply", "copy", "on-copy"] as Mode[]) {
    const { heading, auto: autoLabel, suffix } = MODE_TEXT[mode];
    const { shown, hidden } = shortList("preset", presets, (n) => n);
    rows.push({ kind: "head", id: `h-${mode}`, label: heading });
    if (auto) rows.push({ kind: "item", id: `auto:${mode}`, label: autoLabel });
    if (presets.length === 0) {
      rows.push({ kind: "note", id: `none-${mode}`, label: "No presets yet — save one in the editor" });
    } else {
      for (const name of shown) {
        rows.push({ kind: "item", id: `preset:${mode}:${name}`, label: `${name}${suffix}`, icon: "pencil", search: `${name}${suffix}` });
      }
    }
    if (hidden.length > 0) rows.push({ kind: "item", id: `more:${mode}`, label: `More presets… (${hidden.length})`, search: "more" });
  }
  return rows;
}

// An Edit row's id read back: what it does, in which mode, with which preset.
export function parseEditRow(id: string): { kind: "auto" | "preset" | "more"; mode: Mode; name: string } | null {
  const [kind, mode, ...rest] = id.split(":");
  if ((kind !== "auto" && kind !== "preset" && kind !== "more") || !Object.prototype.hasOwnProperty.call(MODE_TEXT, mode)) return null;
  return { kind, mode: mode as Mode, name: rest.join(":") };
}

// Shared rows as the bar's dropdown options: headings and notes greyed, rules
// left out, the glyph in front of the label.
export function menuRowsToOptions(rows: MenuRow[]): DropdownOption[] {
  const glyph = (icon: MenuRow["icon"]) =>
    icon === "pencil" ? (
      <IconPencil size={12} />
    ) : icon === "album" ? (
      <IconAlbum size={13} />
    ) : icon === "canvas" ? (
      <IconCanvas size={13} />
    ) : icon === "plus" ? (
      <IconPlus size={12} />
    ) : null;
  const out: DropdownOption[] = [];
  for (const r of rows) {
    if (r.kind === "sep") continue;
    if (r.kind === "head") {
      out.push({ value: r.id, label: <span className="dropdown-group-label">{r.label}</span>, disabled: true });
    } else if (r.kind === "note") {
      out.push({ value: r.id, label: r.label, disabled: true });
    } else {
      out.push({
        value: r.id,
        label: r.icon ? (
          <>
            {glyph(r.icon)} {r.label}
          </>
        ) : (
          r.label
        ),
        ...(r.search !== undefined ? { search: r.search } : {}),
      });
    }
  }
  return out;
}

// ONE "Edit…" for the bulk action bars, the develop counterpart of "Add
// to...": automatic edits and every saved editor preset in a single dropdown,
// instead of an "Auto develop" button plus a preset dropdown that only showed
// up once a preset existed (so applying one to a selection went unnoticed).
// A third group does the same and saves a copy of each photo as well; a
// fourth puts the edit on a copy only and leaves the originals as they are.
// Each group lists the presets used last and puts the rest behind "More
// presets…" (utils/recents, PickerDialog), so twenty presets do not make an
// eighty-row menu.
export function EditPicker({
  onAutoEdit,
  onApplyPreset,
  onAutoEditAndCopy,
  onApplyPresetAndCopy,
  onAutoEditOnCopy,
  onApplyPresetOnCopy,
  busy = false,
}: Props) {
  // Read once per MOUNT rather than per render: this parses localStorage, and
  // the bars mount with the selection while the editor lives on its own route
  // (/image/:id) - presets saved there are picked up on the way back. Newest
  // last as saved, so newest first here.
  const presetNames = useMemo(() => Object.keys(loadPresets()).reverse(), []);
  const [more, setMore] = useState<Mode | null>(null);

  const runPreset = (mode: Mode, name: string) => {
    noteRecent("preset", name);
    if (mode === "apply") void onApplyPreset(name);
    else if (mode === "copy") void onApplyPresetAndCopy(name);
    else void onApplyPresetOnCopy(name);
  };
  const runAuto = (mode: Mode) => {
    if (mode === "apply") void onAutoEdit();
    else if (mode === "copy") void onAutoEditAndCopy();
    else void onAutoEditOnCopy();
  };


  return (
    <>
      <Dropdown
        value=""
        placeholder={<span className="btn-label"><IconPencil size={13} /> {busy ? "Working…" : "Edit…"}</span>}
        disabled={busy}
        title="Apply automatic edits or a saved editor preset to the selected photos - as they are, with a copy of each, or on a copy only"
        ariaLabel="Apply auto edit or preset"
        onChange={(v) => {
          const row = parseEditRow(v);
          if (!row) return;
          if (row.kind === "auto") runAuto(row.mode);
          else if (row.kind === "preset") runPreset(row.mode, row.name);
          else setMore(row.mode);
        }}
        options={menuRowsToOptions(editMenuRows(presetNames, true))}
      />
      <Presence open={more !== null} ms={MOTION.modal}>
        {more && (
          <PickerDialog
            title={MODE_TEXT[more].title}
            groups={[
              {
                items: presetNames.map((name) => ({
                  id: name,
                  label: (
                    <>
                      <IconPencil size={12} /> {name}
                    </>
                  ),
                  search: name,
                })),
              },
            ]}
            onPick={(name) => {
              const mode = more;
              setMore(null);
              runPreset(mode, name);
            }}
            onClose={() => setMore(null)}
          />
        )}
      </Presence>
    </>
  );
}

import { useMemo } from "react";
import { loadPresets } from "../utils/presets";
import { Dropdown } from "./Dropdown";
import { IconPencil } from "./Icons";

interface Props {
  onAutoEdit: () => void | Promise<unknown>;
  onApplyPreset: (name: string) => void | Promise<unknown>;
  // The same, followed by a JPEG copy of every photo with that edit baked in
  // (the originals keep the edit too; the copies carry the tags).
  onAutoEditAndCopy: () => void | Promise<unknown>;
  onApplyPresetAndCopy: (name: string) => void | Promise<unknown>;
  busy?: boolean;
}

// ONE "Edit…" for the bulk action bars, the develop counterpart of "Add
// to...": automatic edits and every saved editor preset in a single dropdown,
// instead of an "Auto develop" button plus a preset dropdown that only showed
// up once a preset existed (so applying one to a selection went unnoticed).
// A third group does the same and saves a copy of each photo as well.
export function EditPicker({ onAutoEdit, onApplyPreset, onAutoEditAndCopy, onApplyPresetAndCopy, busy = false }: Props) {
  // Read once per MOUNT rather than per render: this parses localStorage, and
  // the bars mount with the selection while the editor lives on its own route
  // (/image/:id) - presets saved there are picked up on the way back.
  const presetNames = useMemo(() => Object.keys(loadPresets()), []);

  const options = [
    { value: "h-auto", label: <span className="dropdown-group-label">Automatic</span>, disabled: true },
    { value: "auto", label: "Apply auto edit" },
    { value: "h-presets", label: <span className="dropdown-group-label">Apply preset</span>, disabled: true },
    ...(presetNames.length > 0
      ? presetNames.map((name) => ({
          value: `preset:${name}`,
          label: (
            <>
              <IconPencil size={12} /> {name}
            </>
          ),
          search: name,
        }))
      : [{ value: "h-none", label: "No presets yet — save one in the editor", disabled: true }]),
    { value: "h-copy", label: <span className="dropdown-group-label">Apply and save copy</span>, disabled: true },
    { value: "auto-copy", label: "Apply auto edit and save copy" },
    ...presetNames.map((name) => ({
      value: `preset-copy:${name}`,
      label: (
        <>
          <IconPencil size={12} /> {name} and save copy
        </>
      ),
      search: `${name} copy`,
    })),
  ];

  return (
    <Dropdown
      value=""
      placeholder={<span className="btn-label"><IconPencil size={13} /> {busy ? "Working…" : "Edit…"}</span>}
      disabled={busy}
      title="Apply automatic edits or a saved editor preset to the selected photos, with or without a copy of each"
      ariaLabel="Apply auto edit or preset"
      onChange={(v) => {
        if (v === "auto") void onAutoEdit();
        else if (v === "auto-copy") void onAutoEditAndCopy();
        else if (v.startsWith("preset-copy:")) void onApplyPresetAndCopy(v.slice("preset-copy:".length));
        else if (v.startsWith("preset:")) void onApplyPreset(v.slice("preset:".length));
      }}
      options={options}
    />
  );
}

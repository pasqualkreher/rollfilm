import { useMemo } from "react";
import { loadPresets } from "../utils/presets";
import { Dropdown } from "./Dropdown";
import { IconPencil } from "./Icons";

interface Props {
  onAutoEdit: () => void | Promise<unknown>;
  onApplyPreset: (name: string) => void | Promise<unknown>;
  busy?: boolean;
}

// ONE "Edit..." for the bulk action bars, the develop counterpart of "Add
// to...": automatic edits and every saved editor preset in a single dropdown,
// instead of an "Auto develop" button plus a preset dropdown that only showed
// up once a preset existed (so applying one to a selection went unnoticed).
export function EditPicker({ onAutoEdit, onApplyPreset, busy = false }: Props) {
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
  ];

  return (
    <Dropdown
      value=""
      placeholder={busy ? "Working…" : "Edit..."}
      disabled={busy}
      title="Apply automatic edits or a saved editor preset to the selected photos"
      ariaLabel="Apply auto edit or preset"
      onChange={(v) => {
        if (v === "auto") void onAutoEdit();
        else if (v.startsWith("preset:")) void onApplyPreset(v.slice("preset:".length));
      }}
      options={options}
    />
  );
}

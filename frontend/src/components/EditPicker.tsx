import { useMemo, useState } from "react";
import { loadPresets } from "../utils/presets";
import { noteRecent, shortList } from "../utils/recents";
import { Dropdown } from "./Dropdown";
import { IconPencil } from "./Icons";
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

type Mode = "apply" | "copy" | "oncopy";

const MODE_TEXT: Record<Mode, { heading: string; auto: string; suffix: string; title: string }> = {
  apply: { heading: "Apply preset", auto: "Apply auto edit", suffix: "", title: "Apply preset" },
  copy: { heading: "Apply and save copy", auto: "Apply auto edit and save copy", suffix: " and save copy", title: "Apply preset and save copy" },
  oncopy: { heading: "Edit a copy", auto: "Auto edit a copy", suffix: " on a copy", title: "Preset on a copy" },
};

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

  const group = (mode: Mode) => {
    const { heading, auto, suffix } = MODE_TEXT[mode];
    const { shown, hidden } = shortList("preset", presetNames, (n) => n);
    return [
      { value: `h-${mode}`, label: <span className="dropdown-group-label">{heading}</span>, disabled: true },
      { value: `auto:${mode}`, label: auto },
      ...(presetNames.length === 0
        ? [{ value: `none-${mode}`, label: "No presets yet — save one in the editor", disabled: true }]
        : shown.map((name) => ({
            value: `preset:${mode}:${name}`,
            label: (
              <>
                <IconPencil size={12} /> {name}
                {suffix}
              </>
            ),
            search: `${name}${suffix}`,
          }))),
      ...(hidden.length > 0 ? [{ value: `more:${mode}`, label: `More presets… (${hidden.length})`, search: "more" }] : []),
    ];
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
          const [kind, mode, ...rest] = v.split(":");
          const name = rest.join(":");
          if (kind === "auto") runAuto(mode as Mode);
          else if (kind === "preset") runPreset(mode as Mode, name);
          else if (kind === "more") setMore(mode as Mode);
        }}
        options={[...group("apply"), ...group("copy"), ...group("oncopy")]}
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

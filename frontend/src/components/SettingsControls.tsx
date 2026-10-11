import type { ReactNode } from "react";

// Shared building blocks so every settings block is styled the same way,
// on the Settings page and wherever a slice of it is shown elsewhere.

// A muted description paragraph.
export function Desc({ children }: { children: ReactNode }) {
  return <p className="settings-desc">{children}</p>;
}

// A radio or checkbox row with a bold title and a muted description.
export function OptionRow({
  type,
  name,
  checked,
  disabled,
  busy,
  onChange,
  title,
  desc,
}: {
  type: "checkbox" | "radio";
  name?: string;
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  onChange: (checked: boolean) => void;
  title: ReactNode;
  desc?: ReactNode;
}) {
  return (
    <label className={`settings-option${busy ? " busy" : ""}`}>
      <input
        type={type}
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="settings-option-body">
        <strong>{title}</strong>
        {desc != null && <span className="settings-option-desc">{desc}</span>}
      </span>
    </label>
  );
}

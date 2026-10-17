import type { Flag } from "../api/types";
import { IconCheck, IconX } from "./Icons";

interface Props {
  // The flag shown: a photo's own, or what a selection agrees on (null when
  // it does not).
  value: Flag | null | undefined;
  // "" takes the flag off. Left out, the picker only shows.
  onChange?: (flag: Flag | "") => void;
  title?: string;
}

// The culling flag beside the stars and the colour swatches: a tick for a
// pick, a cross for a reject. The lit one pressed again takes the flag off,
// the way the filled star does. P / X / U are the keys everywhere.
export function FlagPicker({ value, onChange, title }: Props) {
  const one = (flag: Flag, label: string, key: string, icon: JSX.Element) => (
    <button
      type="button"
      className={`flag-btn flag-btn--${flag}${value === flag ? " active" : ""}`}
      aria-pressed={value === flag}
      disabled={!onChange}
      title={`${label} (${key})`}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange?.(value === flag ? "" : flag);
      }}
    >
      {icon}
    </button>
  );
  return (
    <span className="flag-picker" title={title}>
      {one("pick", "Pick", "A", <IconCheck size={13} />)}
      {one("reject", "Reject", "X", <IconX size={13} />)}
    </span>
  );
}

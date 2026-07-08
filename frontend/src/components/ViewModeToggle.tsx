import type { ViewMode } from "../api/types";

const OPTIONS: { value: ViewMode; label: string }[] = [
  { value: "combined", label: "RAW + JPEG" },
  { value: "jpeg_only", label: "JPEG" },
  { value: "raw_only", label: "RAW" },
];

interface Props {
  value: ViewMode;
  onChange: (value: ViewMode) => void;
}

export function ViewModeToggle({ value, onChange }: Props) {
  return (
    <span className="segmented">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          className={value === opt.value ? "active" : ""}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </span>
  );
}

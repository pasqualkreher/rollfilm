import type { ColorLabel } from "../api/types";

const COLORS: { value: ColorLabel; hex: string }[] = [
  { value: "none", hex: "transparent" },
  { value: "red", hex: "#d0392b" },
  { value: "orange", hex: "#e08a2c" },
  { value: "yellow", hex: "#e0c62c" },
  { value: "green", hex: "#3a9a4d" },
  { value: "blue", hex: "#3a6df0" },
  { value: "magenta", hex: "#b13ad0" },
  { value: "gray", hex: "#8a8a90" },
];

// Shared so overlays (e.g. the thumbnail grid) can render a matching color dot
// without re-declaring these hex values.
export const COLOR_HEX: Record<ColorLabel, string> = Object.fromEntries(
  COLORS.map((c) => [c.value, c.hex])
) as Record<ColorLabel, string>;

interface Props {
  value: ColorLabel;
  onChange?: (value: ColorLabel) => void;
}

// The swatches are buttons: reachable with Tab, pressed with Space, named
// for a screen reader, and disabled where the picker only shows.
export function ColorLabelPicker({ value, onChange }: Props) {
  return (
    <span className="color-label-picker" role="group" aria-label="Color label">
      {COLORS.map((c) => {
        const name = c.value === "none" ? "No color" : c.value[0].toUpperCase() + c.value.slice(1);
        return (
          <button
            type="button"
            key={c.value}
            className={`color-swatch${c.value === "none" ? " color-swatch-none" : ""}${
              value === c.value ? " selected" : ""
            }`}
            style={c.value === "none" ? undefined : { background: c.hex }}
            title={c.value === "none" ? "No color / any" : name}
            aria-label={name}
            aria-pressed={value === c.value}
            disabled={!onChange}
            onClick={(e) => {
              e.stopPropagation();
              onChange?.(c.value);
            }}
          />
        );
      })}
    </span>
  );
}

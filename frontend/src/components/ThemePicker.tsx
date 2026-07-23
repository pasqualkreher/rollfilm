import type { ReactNode } from "react";
import { SKINS, useTheme, type SkinInfo, type Theme } from "../state/theme";

// The colour-skin picker in Settings → Appearance: a "System" tile plus a grid
// of skin tiles grouped Light / Dark. Each preview is a mini mock of the app
// painted in the skin's own colours (never the active theme's) so you can see
// what you'd get before switching.

function SkinTile({
  active,
  onSelect,
  label,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`theme-tile${active ? " active" : ""}`}
      aria-pressed={active}
      onClick={onSelect}
    >
      {children}
      <span className="theme-tile-label">
        {label}
        {active && <span className="theme-tile-check">✓</span>}
      </span>
    </button>
  );
}

// A header row (text line + accent button) over a row of three cards.
function SkinPreview({ skin }: { skin: SkinInfo }) {
  return (
    <span className="theme-tile-preview" style={{ background: skin.bg }}>
      <span className="tp-topbar">
        <span className="tp-line" style={{ background: skin.text }} />
        <span className="tp-pill" style={{ background: skin.accent }} />
      </span>
      <span className="tp-body">
        <span className="tp-swatch" style={{ background: skin.elevated }} />
        <span className="tp-swatch" style={{ background: skin.elevated }} />
        <span className="tp-swatch" style={{ background: skin.accent, opacity: 0.9 }} />
      </span>
    </span>
  );
}

// "System": a light half beside a dark half, each a tiny header line + button.
function SystemPreview() {
  return (
    <span className="theme-tile-preview tp-split">
      <span className="tp-half" style={{ background: "#ffffff" }}>
        <span className="tp-line" style={{ background: "#1a1a1a" }} />
        <span className="tp-pill" style={{ background: "#3a6df0" }} />
      </span>
      <span className="tp-half" style={{ background: "#17181a" }}>
        <span className="tp-line" style={{ background: "#f1f1f2" }} />
        <span className="tp-pill" style={{ background: "#6d93ff" }} />
      </span>
    </span>
  );
}

function SkinGroup({
  skins,
  theme,
  onSelect,
}: {
  skins: SkinInfo[];
  theme: Theme;
  onSelect: (t: Theme) => void;
}) {
  return (
    <div className="theme-picker">
      {skins.map((skin) => (
        <SkinTile
          key={skin.value}
          active={theme === skin.value}
          onSelect={() => onSelect(skin.value)}
          label={skin.label}
        >
          <SkinPreview skin={skin} />
        </SkinTile>
      ))}
    </div>
  );
}

export function ThemePicker() {
  const [theme, setTheme] = useTheme();

  const light = SKINS.filter((s) => s.group === "light");
  const dark = SKINS.filter((s) => s.group === "dark");

  return (
    <div>
      <div className="theme-picker">
        <SkinTile
          active={theme === "system"}
          onSelect={() => setTheme("system")}
          label="System"
        >
          <SystemPreview />
        </SkinTile>
      </div>

      <p className="theme-group-label">Light</p>
      <SkinGroup skins={light} theme={theme} onSelect={setTheme} />

      <p className="theme-group-label">Dark</p>
      <SkinGroup skins={dark} theme={theme} onSelect={setTheme} />
    </div>
  );
}

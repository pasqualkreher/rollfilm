import { IconCheck } from "./Icons";
import {
  DARK_SKINS,
  LIGHT_SKINS,
  setDarkSkin,
  setLightSkin,
  setMode,
  useAppearance,
  type DarkSkin,
  type LightSkin,
  type Mode,
  type Skin,
  type SkinInfo,
} from "../state/theme";

// The appearance picker in Settings → Appearance: the Light / Dark / Auto
// switch on top, then the two skin choices under it - one light, one dark. Both
// are always visible and always editable, because Auto needs both to be set
// before it can follow the system; the group that's on screen right now is
// marked so it's obvious why picking in the other one changes nothing yet.
// Each preview is a mini mock of the app painted in the skin's own colours
// (never the active theme's).

function SkinTile({
  active,
  onSelect,
  skin,
}: {
  active: boolean;
  onSelect: () => void;
  skin: SkinInfo;
}) {
  return (
    <button
      type="button"
      className={`theme-tile${active ? " active" : ""}`}
      aria-pressed={active}
      onClick={onSelect}
    >
      {/* A header row (text line + accent button) over a row of three cards. */}
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
      <span className="theme-tile-label">
        {skin.label}
        {active && (
          <span className="theme-tile-check">
            <IconCheck size={13} />
          </span>
        )}
      </span>
      <span className="theme-tile-hint">{skin.hint}</span>
    </button>
  );
}

function SkinGroup({
  skins,
  selected,
  onSelect,
}: {
  skins: SkinInfo[];
  selected: Skin;
  onSelect: (s: Skin) => void;
}) {
  return (
    <div className="theme-picker">
      {skins.map((skin) => (
        <SkinTile
          key={skin.value}
          active={selected === skin.value}
          onSelect={() => onSelect(skin.value)}
          skin={skin}
        />
      ))}
    </div>
  );
}

const MODES: { value: Mode; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "auto", label: "Auto" },
];

export function ThemePicker() {
  const { mode, light, dark, resolved } = useAppearance();
  const showingLight = LIGHT_SKINS.some((s) => s.value === resolved);

  return (
    <div>
      <div className="theme-mode-row">
        <span className="settings-option-body">
          <strong>Mode</strong>
          <span className="settings-option-desc">
            {mode === "auto"
              ? "Following your system's light/dark setting."
              : `Always ${mode}, whatever the system is set to.`}
          </span>
        </span>
        <span className="segmented">
          {MODES.map((m) => (
            <button
              key={m.value}
              className={mode === m.value ? "active" : ""}
              aria-pressed={mode === m.value}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </span>
      </div>

      <p className="theme-group-label">
        Light skin
        {showingLight && <span className="theme-group-badge">On screen</span>}
      </p>
      <SkinGroup
        skins={LIGHT_SKINS}
        selected={light}
        onSelect={(s) => setLightSkin(s as LightSkin)}
      />

      <p className="theme-group-label">
        Dark skin
        {!showingLight && <span className="theme-group-badge">On screen</span>}
      </p>
      <SkinGroup skins={DARK_SKINS} selected={dark} onSelect={(s) => setDarkSkin(s as DarkSkin)} />
    </div>
  );
}

import { STAGE_BACKGROUNDS, setStageBg, useStageBg } from "../state/viewPrefs";

// The surround behind a photo shown big: Paper, Gray or Black (the grey each
// one stands for is in the tooltip). One control, one shared preference
// (see viewPrefs), used by the library's photo view, the import review's
// preview and the editor - a photo has to sit on the same grey in all three,
// or comparing what you saw in one with what you see in the next means nothing.
//
// Each step is a swatch of the grey it sets - the swatch IS the label, so the
// control needs no caption and the three toolbars stay one compact line; the
// names live in the tooltips.
export function StageBackgroundToggle() {
  const bg = useStageBg();
  return (
    <span className="segmented" role="group" aria-label="Background">
      {STAGE_BACKGROUNDS.map((option) => (
        <button
          key={option.key}
          className={bg === option.key ? "active" : ""}
          onClick={() => setStageBg(option.key)}
          title={option.title}
          aria-label={option.label}
        >
          <span className={`stage-swatch stage-swatch--${option.key}`} aria-hidden />
        </button>
      ))}
    </span>
  );
}

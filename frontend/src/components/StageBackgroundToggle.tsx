import { STAGE_BACKGROUNDS, setStageBg, useStageBg } from "../state/viewPrefs";

// The surround behind a photo shown big: light grey (25%), mid grey (50%) or
// black. One control, one shared preference (see viewPrefs), used by the
// library's photo view, the import review's preview and the editor - a photo
// has to sit on the same grey in all three, or comparing what you saw in one
// with what you see in the next means nothing.
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
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}

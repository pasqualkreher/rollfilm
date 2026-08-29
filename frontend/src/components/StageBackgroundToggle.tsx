import { STAGE_BACKGROUNDS, setStageBg, useStageBg } from "../state/viewPrefs";

// The surround behind a photo shown big: Paper, Gray or Black (the grey each
// one stands for is in the tooltip). One control, one shared preference
// (see viewPrefs), used by the library's photo view, the import review's
// preview and the editor - a photo has to sit on the same grey in all three,
// or comparing what you saw in one with what you see in the next means nothing.
export function StageBackgroundToggle() {
  const bg = useStageBg();
  return (
    // The caption says what the steps set: they share a row with the zoom
    // control, and an unlabelled tone switch beside it invites the guess that
    // it is a second zoom.
    <span className="labeled-control">
      <span className="control-caption">Background</span>
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
    </span>
  );
}

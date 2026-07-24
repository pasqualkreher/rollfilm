import { useEffect, useState } from "react";

// Guided walk through the Settings page: steps through every rendered
// settings section, scrolls it into view and highlights it, with a floating
// card explaining what the section is for. Started from the onboarding wizard
// (via the sessionStorage flag below) or anytime with the "Show me around"
// button on the Settings page - and skippable at every step.

export const SETTINGS_TOUR_KEY = "pm:settings-tour";

// One-liners per section title. Sections are discovered from the DOM (so
// desktop-only ones only appear in the desktop build); a section without an
// entry here still gets a stop, just with a generic line.
const TOUR_TEXT: Record<string, string> = {
  Appearance:
    "Pick a colour skin or follow your system's light/dark mode. Purely cosmetic - change it whenever you like.",
  "Library folder":
    "Where your photo files live. Point the app at a different folder anytime to switch to a separate library - for example one for work and one for personal.",
  "Library data":
    "The library's database and thumbnails sit in a hidden .photomanager subfolder inside the library folder, so the whole library travels with the folder. Exclude it from cloud sync if the folder is synced.",
  "Immich integration":
    "Optional: connect an Immich server to upload JPEGs and mirror albums, manually or automatically. Skip this if you don't use Immich.",
  "RAW files":
    "How unedited RAW photos look while browsing: automatically brightened to a normal exposure (default), or native and dark with all their headroom, like in the editor.",
  "Auto develop":
    "Adds an Auto button to the editor that suggests develop settings learned from your own saved edits. The more you edit, the better it gets.",
  "Smart albums":
    "Automatic collections on the Albums page - similar photos, places, countries and time groups. Tick the ones you want; nothing is stored as a real album.",
  Trash:
    "Deleted photos stay in the Trash and can be restored. Choose how long they're kept before being removed for good (0 = forever).",
  Tags: "Housekeeping for tags no photo uses anymore - remove them to keep the tag filter tidy.",
  "Library maintenance":
    "The library folder on disk is the source of truth. Run this if things look out of sync - it cleans up stale entries and regenerates missing thumbnails.",
  "Backup & restore":
    "Download a backup of your managed library (photos, ratings, albums, edits) and restore it later - worth doing every now and then.",
};

type Stop = { title: string; text: string; el: HTMLElement };

export function SettingsTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [index, setIndex] = useState(0);

  // Discover the stops from what's actually rendered, fresh on every start -
  // desktop-only sections are simply absent in the web build. Must run in an
  // effect (after the DOM commit): when the tour auto-starts on mount, the
  // sections don't exist yet during the first render.
  const [stops, setStops] = useState<Stop[]>([]);
  useEffect(() => {
    if (!open) {
      setStops([]);
      return;
    }
    setIndex(0);
    setStops(
      Array.from(document.querySelectorAll<HTMLElement>("[data-settings-section]")).map((el) => {
        const title = el.dataset.settingsSection ?? "";
        return { title, text: TOUR_TEXT[title] ?? "Everything in this section can be changed anytime.", el };
      })
    );
  }, [open]);

  // Highlight + scroll the current stop; clean the highlight up on leave/close.
  const stop = stops[Math.min(index, stops.length - 1)];
  useEffect(() => {
    if (!open || !stop) return;
    stop.el.classList.add("tour-highlight");
    stop.el.scrollIntoView({ block: "center", behavior: "smooth" });
    return () => stop.el.classList.remove("tour-highlight");
  }, [open, stop]);

  if (!open || stops.length === 0 || !stop) return null;

  const isLast = index >= stops.length - 1;

  return (
    <div className="settings-tour-card" role="dialog" aria-label="Settings tour">
      <div className="settings-tour-head">
        <strong>{stop.title}</strong>
        <span className="settings-tour-progress">
          {index + 1} / {stops.length}
        </span>
      </div>
      <p className="settings-tour-text">{stop.text}</p>
      <div className="settings-tour-actions">
        <button className="btn subtle" onClick={onClose}>
          Skip tour
        </button>
        <div className="settings-tour-actions-right">
          {index > 0 && (
            <button className="btn" onClick={() => setIndex(index - 1)}>
              Back
            </button>
          )}
          {isLast ? (
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <button className="btn primary" onClick={() => setIndex(index + 1)}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

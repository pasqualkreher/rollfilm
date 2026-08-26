import { useEffect, useRef, useState } from "react";

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

export function SettingsTour({
  open,
  onClose,
  sections,
  onShowSection,
}: {
  open: boolean;
  onClose: () => void;
  // Every section this build shows, in the order the tour should visit them.
  // Handed in rather than read off the DOM: the sections live under tabs now,
  // so at any moment all but one tab's worth of them are unrendered - and a
  // desktop-only section is absent from this list in the web build, which is
  // what DOM discovery used to give us for free.
  sections: string[];
  // Opens the tab a section sits under, before the tour looks for it.
  onShowSection?: (title: string) => void;
}) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  // Held in a ref so an inline arrow from the page doesn't re-run the effect
  // below (and re-scroll) on every one of the page's renders.
  const showSectionRef = useRef(onShowSection);
  showSectionRef.current = onShowSection;

  const clamped = Math.min(index, Math.max(0, sections.length - 1));
  const title = sections[clamped];

  // Open the stop's tab, then highlight and scroll to it. The element only
  // exists after that tab switch has been rendered, hence the frame's wait;
  // a second frame covers a tab whose contents mount a beat later.
  useEffect(() => {
    if (!open || !title) return;
    showSectionRef.current?.(title);
    let found: HTMLElement | null = null;
    let second = 0;
    const reveal = () => {
      found = document.querySelector<HTMLElement>(
        `[data-settings-section="${CSS.escape(title)}"]`
      );
      if (found) {
        found.classList.add("tour-highlight");
        found.scrollIntoView({ block: "center", behavior: "smooth" });
        return true;
      }
      return false;
    };
    const first = requestAnimationFrame(() => {
      if (!reveal()) second = requestAnimationFrame(reveal);
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      found?.classList.remove("tour-highlight");
    };
  }, [open, title]);

  if (!open || !title) return null;

  const text = TOUR_TEXT[title] ?? "Everything in this section can be changed anytime.";
  const isLast = clamped >= sections.length - 1;

  return (
    <div className="settings-tour-card" role="dialog" aria-label="Settings tour">
      <div className="settings-tour-head">
        <strong>{title}</strong>
        <span className="settings-tour-progress">
          {clamped + 1} / {sections.length}
        </span>
      </div>
      <p className="settings-tour-text">{text}</p>
      <div className="settings-tour-actions">
        <button className="btn subtle" onClick={onClose}>
          Skip tour
        </button>
        <div className="settings-tour-actions-right">
          {clamped > 0 && (
            <button className="btn" onClick={() => setIndex(clamped - 1)}>
              Back
            </button>
          )}
          {isLast ? (
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <button className="btn primary" onClick={() => setIndex(clamped + 1)}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

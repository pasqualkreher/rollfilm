import { Fragment, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Presence } from "./Presence";
import { MOTION } from "../utils/usePresence";
import { useEnterToConfirm, useEscapeToClose } from "../utils/modalKeys";
import { CHANGELOG, changesSince, changesUpTo, type ChangelogEntry } from "../utils/changelog";

// "What's new": the CHANGELOG sections the user hasn't seen, once, on the
// first start after an update. The About window opens it any time
// (openWhatsNew) with every version up to the running one.
//
// The last version seen lives in localStorage. A first install has nothing
// to catch up on, so it only notes the version; someone who used the app
// before this sheet existed (onboarding done, no version noted) is shown the
// running version's section.

const SEEN_KEY = "pm:whats-new-seen";
const ONBOARDING_DONE_KEY = "pm:onboarding-done";
const OPEN_EVENT = "pm:whats-new";

export function openWhatsNew() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function noteSeen() {
  try {
    localStorage.setItem(SEEN_KEY, __APP_VERSION__);
  } catch {
    // Without storage the sheet simply doesn't come by itself.
  }
}

// What to show at startup, or null.
function unseen(): ChangelogEntry[] | null {
  const seen = read(SEEN_KEY);
  if (seen === null) {
    if (read(ONBOARDING_DONE_KEY) !== "1") {
      noteSeen();
      return null;
    }
    const current = CHANGELOG.filter((e) => e.version === __APP_VERSION__);
    return current.length > 0 ? current : null;
  }
  const entries = changesSince(seen, __APP_VERSION__);
  return entries.length > 0 ? entries : null;
}

// **bold** and `code`, the two marks the CHANGELOG uses.
function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

// The versions with their groups and points. `titled` puts each version's
// number above it (off when the sheet shows a single version in its title);
// `foldOlder` folds every version but the newest away (Settings).
export function ChangelogList({
  entries,
  titled = true,
  foldOlder = false,
}: {
  entries: ChangelogEntry[];
  titled?: boolean;
  foldOlder?: boolean;
}) {
  if (entries.length === 0) return <p className="whats-new-empty">Nothing noted for this version.</p>;
  const groups = (entry: ChangelogEntry) =>
    entry.groups.map((group, gi) => (
      <div key={gi} className="whats-new-group">
        {group.title && <div className="whats-new-group-title">{group.title}</div>}
        <ul>
          {group.points.map((point, pi) => (
            <li key={pi}>{inline(point)}</li>
          ))}
        </ul>
      </div>
    ));
  const title = (entry: ChangelogEntry) => (
    <>
      {entry.version}
      {entry.date && <span className="whats-new-date">{entry.date}</span>}
    </>
  );
  return (
    <div className="whats-new-list">
      {entries.map((entry, i) =>
        foldOlder && i > 0 ? (
          <details key={entry.version} className="whats-new-version">
            <summary className="whats-new-version-title">{title(entry)}</summary>
            {groups(entry)}
          </details>
        ) : (
          <section key={entry.version} className="whats-new-version">
            {titled && <h4 className="whats-new-version-title">{title(entry)}</h4>}
            {groups(entry)}
          </section>
        )
      )}
    </div>
  );
}

export function WhatsNew() {
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);
  const [manual, setManual] = useState(false);
  const open = entries !== null;

  useEffect(() => {
    const found = unseen();
    if (found) setEntries(found);
    const show = () => {
      setManual(true);
      setEntries(changesUpTo(__APP_VERSION__));
    };
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, []);

  const close = () => {
    noteSeen();
    setEntries(null);
    setManual(false);
  };
  useEscapeToClose(open, close);
  useEnterToConfirm(open, close);

  // Opened from the About window it is the release notes: every version,
  // the newest open and the others folded, as in Settings › Maintenance.
  const single = !manual && entries?.length === 1 ? entries[0] : null;

  return createPortal(
    <Presence open={open} ms={MOTION.modal}>
      {open && (
        <div className="modal-overlay" onClick={close}>
          <div
            className="modal whats-new-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="whats-new-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="whats-new-head">
              <h3 id="whats-new-title">
                {manual ? "Release notes" : `What's new${single ? ` in Rollfilm ${single.version}` : ""}`}
              </h3>
            </div>
            <div className="whats-new-body">
              <ChangelogList entries={entries} titled={!single} foldOlder={manual} />
            </div>
            <div className="whats-new-actions">
              <button type="button" className="btn primary" onClick={close} autoFocus>
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </Presence>,
    document.body
  );
}

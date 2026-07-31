import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTransientMessage } from "../utils/transientMessage";
import { ThemePicker } from "./ThemePicker";
import { SETTINGS_TOUR_KEY } from "./SettingsTour";
import { IconX } from "./Icons";

// First-start onboarding: a short multi-step wizard shown once (completion is
// remembered in localStorage). It walks a new user through the things that
// aren't obvious from the UI: clearing leftovers from an older install, where
// the library and its database live (and that you can keep several), picking a
// colour style, and the import → edit → Immich workflow.
//
// The clean-up and library steps only appear in the desktop build (they need
// the Electron bridge); in the plain web build the wizard is just Style +
// Workflow. Steps are assembled at runtime from what's actually available.

const DONE_KEY = "pm:onboarding-done";

type LegacyDir = { path: string; sizeBytes: number };
type StepId = "welcome" | "cleanup" | "library" | "style" | "workflow" | "settings";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}

export function OnboardingWizard() {
  const navigate = useNavigate();
  const desktop = typeof window !== "undefined" ? window.photoManager : undefined;

  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(DONE_KEY) !== "1";
    } catch {
      return false;
    }
  });
  const [stepIndex, setStepIndex] = useState(0);

  // Set by the first-run library setup right before it reloads into the app. The
  // folder was just chosen (and the multi-library note shown) there, so the
  // wizard skips its welcome/library steps and goes straight to Style. Cleared
  // after mount so a later manual re-trigger shows the full flow again.
  const [justSetup] = useState(() => {
    try {
      return sessionStorage.getItem("pm:just-setup") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.removeItem("pm:just-setup");
    } catch {
      /* ignore */
    }
  }, []);

  // Desktop-only context, loaded once when the wizard opens.
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);
  const [dataRoot, setDataRoot] = useState<string | null>(null);
  const [legacy, setLegacy] = useState<LegacyDir[] | null>(null); // null = not scanned yet
  const [removing, setRemoving] = useState(false);
  // Flash message - auto-dismisses after a moment.
  const [cleanupResult, setCleanupResult] = useTransientMessage(8000);

  useEffect(() => {
    if (!open || !desktop) return;
    desktop.getLibraryRoot?.().then(setLibraryRoot).catch(() => {});
    desktop.getDataRoot?.().then(setDataRoot).catch(() => {});
    desktop.scanLegacyData?.().then(setLegacy).catch(() => setLegacy([]));
  }, [open, desktop]);

  // Which steps exist this run. The clean-up step only shows when there really
  // are leftovers to remove; the library step only in the desktop build.
  const steps = useMemo<StepId[]>(() => {
    // Fresh setup already covered the welcome and library choice — pick up at Style.
    if (justSetup) return ["style", "workflow", "settings"];
    const s: StepId[] = ["welcome"];
    if (desktop && legacy && legacy.length > 0) s.push("cleanup");
    if (desktop) s.push("library");
    s.push("style", "workflow", "settings");
    return s;
  }, [justSetup, desktop, legacy]);

  // The legacy scan can resolve after the user has already moved past where the
  // clean-up step would sit; clamp so the index can never point past the end.
  const clampedIndex = Math.min(stepIndex, steps.length - 1);
  const step = steps[clampedIndex];

  if (!open) return null;

  function finish() {
    try {
      localStorage.setItem(DONE_KEY, "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  }

  const isLast = clampedIndex === steps.length - 1;

  async function removeLegacy() {
    if (!desktop?.removeLegacyData) return;
    setRemoving(true);
    try {
      const result = await desktop.removeLegacyData();
      setLegacy([]);
      const failed = result.failed.length;
      setCleanupResult(
        failed === 0
          ? "Old files removed."
          : `Removed ${result.removed.length}, but ${failed} folder${failed === 1 ? "" : "s"} couldn't be deleted — you can remove them manually later.`
      );
    } catch {
      setCleanupResult("Couldn't remove the old files. You can try again later.");
    } finally {
      setRemoving(false);
    }
  }

  const totalLegacyBytes = (legacy ?? []).reduce((sum, d) => sum + d.sizeBytes, 0);

  return (
    <div className="modal-overlay" role="dialog" aria-label="Welcome to Rollfilm" aria-modal="true">
      <div className="modal onboarding">
        <div className="onboarding-header">
          <div>
            <h2>Welcome to Rollfilm</h2>
            <span className="onboarding-progress-label">
              Step {clampedIndex + 1} of {steps.length}
            </span>
          </div>
          <button className="modal-close" onClick={finish} aria-label="Skip setup">
            <IconX size={14} />
          </button>
        </div>

        <div className="onboarding-dots" aria-hidden>
          {steps.map((s, i) => (
            <span key={s} className={`onboarding-dot${i === clampedIndex ? " active" : ""}${i < clampedIndex ? " done" : ""}`} />
          ))}
        </div>

        <div className="onboarding-body">
          {step === "welcome" && (
            <div>
              <p className="onboarding-lead">
                Rollfilm is a desktop photo library with a film-look editor — your photos and their
                database stay on your own machine. This quick setup takes about a minute; you can
                skip it anytime and change everything later in <strong>Settings</strong>.
              </p>
              <ul className="onboarding-list">
                <li>Tidy up any leftovers from an older install.</li>
                <li>Choose where your library and its database live.</li>
                <li>Pick a colour style.</li>
                <li>See the workflow, from import to Immich.</li>
                <li>Take a quick tour of the Settings.</li>
              </ul>
            </div>
          )}

          {step === "cleanup" && (
            <div>
              <h3 className="onboarding-step-title">Clean up old files</h3>
              <p className="onboarding-lead">
                An earlier version of this app left some files behind on your system (from back when
                it was called <em>Photo Manager</em>). They're just old caches and logs — safe to
                remove. Your photos and library are <strong>not</strong> affected.
              </p>
              {legacy && legacy.length > 0 ? (
                <>
                  <ul className="onboarding-paths">
                    {legacy.map((d) => (
                      <li key={d.path}>
                        <code>{d.path}</code>
                        <span className="onboarding-size">{formatBytes(d.sizeBytes)}</span>
                      </li>
                    ))}
                  </ul>
                  <button className="btn danger" onClick={removeLegacy} disabled={removing}>
                    {removing
                      ? "Removing…"
                      : `Remove old files (${formatBytes(totalLegacyBytes)})`}
                  </button>
                </>
              ) : (
                <p className="status-note">
                  {cleanupResult ?? "Nothing left to clean up."}
                </p>
              )}
            </div>
          )}

          {step === "library" && (
            <div>
              <h3 className="onboarding-step-title">Where your library lives</h3>
              <p className="onboarding-lead">
                Your photos are stored in the folder you picked when the app started. Its database,
                thumbnails and import staging live in a hidden <code>.photomanager</code> subfolder
                inside it — so the whole library is self-contained and travels with the folder (a
                copy, an external drive, a NAS).
              </p>
              <div className="onboarding-field">
                <span className="onboarding-field-label">Library folder</span>
                <code className="onboarding-field-value">{libraryRoot ?? "…"}</code>
              </div>
              <div className="onboarding-field">
                <span className="onboarding-field-label">Database &amp; thumbnails</span>
                <code className="onboarding-field-value">{dataRoot ?? "…"}</code>
              </div>
              <p style={{ color: "var(--text-muted)", marginTop: 12 }}>
                <strong>You can keep more than one library.</strong> Point the app at a different
                folder anytime (Settings → Library folder) to switch to a separate library — one for
                work and one for personal, say. Each keeps its own database and thumbnails. If the
                folder is cloud-synced (iCloud, Dropbox, Nextcloud), exclude{" "}
                <code>.photomanager</code> from syncing.
              </p>
              {desktop?.changeLibraryRoot && (
                <button className="btn" onClick={() => desktop.changeLibraryRoot()}>
                  Choose a different folder…
                </button>
              )}
            </div>
          )}

          {step === "style" && (
            <div>
              <h3 className="onboarding-step-title">Pick a style</h3>
              <p className="onboarding-lead">
                Choose a colour skin, or follow your system's light/dark setting. The preview on each
                tile shows its own colours. You can change this anytime in Settings.
              </p>
              <ThemePicker />
            </div>
          )}

          {step === "workflow" && (
            <div>
              <h3 className="onboarding-step-title">The workflow</h3>
              <p className="onboarding-lead">
                From a fresh library to finished photos — five steps, all reachable from the top nav.
              </p>
              <ol className="onboarding-workflow">
                <li>
                  <strong>Import</strong> — drop in files or pick a folder. Photos land in a review
                  area first; nothing enters your library until you press <em>Add to library</em>.
                  Duplicates are flagged automatically.
                </li>
                <li>
                  <strong>Browse &amp; cull</strong> — rate with stars, add colour labels and tags,
                  then filter to the keepers. The search box understands plain language like{" "}
                  <em>"dog on a beach"</em>.
                </li>
                <li>
                  <strong>Collect</strong> — add photos to <em>Selects</em> to build a shortlist,
                  then download it as a zip or turn it into an album.
                </li>
                <li>
                  <strong>Edit</strong> — open a photo for tone, colour and film-look effects. Edits
                  never touch the original file.
                </li>
                <li>
                  <strong>Immich</strong> — optionally connect your Immich server in Settings to
                  upload JPEGs and mirror albums, manually or automatically. RAW files always stay in
                  this library only.
                </li>
              </ol>
            </div>
          )}

          {step === "settings" && (
            <div>
              <h3 className="onboarding-step-title">Make it yours in Settings</h3>
              <p className="onboarding-lead">
                Everything you just saw — and a lot more — is adjustable in <strong>Settings</strong>:
                how RAW files look while browsing, auto develop, smart albums, Immich, Trash
                retention, backups. Worth a look once you're settled in.
              </p>
              <p className="onboarding-lead">
                Want a quick guided walk through each section now? It takes under a minute, and you
                can skip out at any step. You can rerun it anytime with{" "}
                <em>"Show me around"</em> at the top of the Settings page.
              </p>
              <button
                className="btn primary"
                onClick={() => {
                  try {
                    sessionStorage.setItem(SETTINGS_TOUR_KEY, "1");
                  } catch {
                    /* ignore */
                  }
                  finish();
                  navigate("/settings");
                }}
              >
                Walk me through the settings
              </button>
            </div>
          )}
        </div>

        <div className="onboarding-footer">
          <button className="btn subtle" onClick={finish}>
            Skip setup
          </button>
          <div className="onboarding-footer-right">
            {clampedIndex > 0 && (
              <button className="btn" onClick={() => setStepIndex(clampedIndex - 1)}>
                Back
              </button>
            )}
            {isLast ? (
              <button
                className="btn primary"
                onClick={() => {
                  finish();
                  navigate("/help");
                }}
              >
                Open the full guide
              </button>
            ) : null}
            {isLast ? (
              <button className="btn primary" onClick={finish}>
                Get started
              </button>
            ) : (
              <button className="btn primary" onClick={() => setStepIndex(clampedIndex + 1)}>
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

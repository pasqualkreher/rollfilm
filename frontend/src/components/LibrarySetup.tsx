import { useState } from "react";

// First-run library picker, shown before the backend is running (the desktop
// shell opens the window with no library configured). This replaces the old
// native "choose your library" message box: the folder is chosen here, in the
// app's own look, as the first step of the onboarding. Picking a folder starts
// the backend; on success we set a one-shot flag and reload into the full app,
// where the onboarding wizard carries on with Style and Workflow.
export function LibrarySetup() {
  const desktop = typeof window !== "undefined" ? window.photoManager : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose() {
    if (!desktop?.setupLibrary) return;
    setError(null);
    setBusy(true);
    try {
      const res = await desktop.setupLibrary();
      if (res.canceled) {
        setBusy(false);
        return;
      }
      if (res.ok) {
        // Tell the reloaded app this session just finished setup, so the wizard
        // skips the welcome/library steps it would otherwise repeat.
        try {
          sessionStorage.setItem("pm:just-setup", "1");
        } catch {
          /* ignore */
        }
        window.location.reload();
        return;
      }
      setError("The library couldn't be set up. Please try a different folder.");
      setBusy(false);
    } catch {
      setError("Something went wrong choosing the folder. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <img
          src={`${import.meta.env.BASE_URL}rollfilm.svg`}
          alt=""
          className="setup-logo"
          width={40}
          height={40}
        />
        <h1 className="setup-title">Welcome to Rollfilm</h1>
        <p className="setup-lead">
          Let's set up your photo library. Choose a folder to hold your photos — its database and
          thumbnails live in a hidden <code>.photomanager</code> subfolder inside it, so the whole
          library is self-contained and travels with the folder.
        </p>

        {busy ? (
          <div className="setup-busy">
            <span className="spinner" aria-hidden="true" />
            <span>Setting up your library… the first launch can take a few minutes.</span>
          </div>
        ) : (
          <button className="btn primary setup-choose" onClick={choose}>
            Choose library folder…
          </button>
        )}

        {error && <p className="setup-error">{error}</p>}

        <p className="setup-note">
          You can keep more than one library and switch between them later in Settings. If the folder
          is cloud-synced (iCloud, Dropbox, Nextcloud), exclude <code>.photomanager</code> from
          syncing.
        </p>
      </div>
    </div>
  );
}

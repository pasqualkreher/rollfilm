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
      setError("The library could not be set up. Please try a different folder.");
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
          Choose a folder for your photo library. The database and thumbnails are stored in a
          hidden <code>.photomanager</code> folder inside it, so the library can be moved as a
          whole.
        </p>

        {busy ? (
          <div className="setup-busy">
            <span className="spinner" aria-hidden="true" />
            <span>Setting up your library… The first start can take a few minutes.</span>
          </div>
        ) : (
          <button className="btn primary setup-choose" onClick={choose}>
            Choose library folder…
          </button>
        )}

        {error && <p className="setup-error">{error}</p>}

        <p className="setup-note">
          You can have more than one library and switch between them in Settings. If the folder is
          synced to the cloud (iCloud, Dropbox, Nextcloud), exclude <code>.photomanager</code> from
          syncing.
        </p>
      </div>
    </div>
  );
}

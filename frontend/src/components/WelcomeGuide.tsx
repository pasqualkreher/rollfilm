import { useState } from "react";
import { useNavigate } from "react-router-dom";

const SEEN_KEY = "pm:welcome-seen";

// Short first-start guide, shown once (dismissal is remembered in
// localStorage). "Open the full guide" jumps to the Help page.
export function WelcomeGuide() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(SEEN_KEY) !== "1";
    } catch {
      return false;
    }
  });

  if (!open) return null;

  function dismiss() {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  }

  return (
    <div className="modal-overlay" role="dialog" aria-label="Welcome to Photo Manager">
      <div className="modal welcome-guide">
        <div className="welcome-guide-header">
          <h2>Welcome to Photo Manager</h2>
          <button className="modal-close" onClick={dismiss} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="welcome-guide-body">
          <p style={{ color: "var(--text-muted)", marginTop: 0 }}>
            The quick version — the <strong>Help</strong> page has the full guide.
          </p>
          <ol className="welcome-steps">
            <li>
              <strong>Import photos</strong> — go to <em>Import</em>, drop in files or pick a
              folder. Duplicates are detected before anything is copied into your library.
            </li>
            <li>
              <strong>Browse &amp; cull</strong> — in <em>Library</em>, give photos star ratings,
              color labels and tags, then filter to find the keepers. The search box understands
              plain language like <em>"dog on a beach"</em>.
            </li>
            <li>
              <strong>Collect your picks</strong> — add photos to <em>Selects</em> to build a
              shortlist, then download it as a zip or add it to an album.
            </li>
            <li>
              <strong>Edit</strong> — open a photo and use the editor: film simulations, tone,
              color and effects. Edits never touch the original file.
            </li>
            <li>
              <strong>Settings</strong> — change the library folder, connect Immich, and make
              backups.
            </li>
          </ol>
        </div>
        <div className="welcome-guide-footer">
          <button
            className="btn"
            onClick={() => {
              dismiss();
              navigate("/help");
            }}
          >
            Open the full guide
          </button>
          <button className="btn primary" onClick={dismiss}>
            Get started
          </button>
        </div>
      </div>
    </div>
  );
}

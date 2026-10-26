import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Presence } from "./Presence";
import { ChangelogList } from "./WhatsNew";
import { MOTION } from "../utils/usePresence";
import { useEscapeToClose } from "../utils/modalKeys";
import { parseNotes } from "../utils/changelog";

// "Update available" / "Update ready": the shell's update prompt
// (electron/updater.js) as a sheet like "What's new", the release notes folded
// away. The bridge acknowledges each notice; without this component mounted
// the shell falls back to its native dialog.

type Action = "download" | "restart" | "open-page" | "dismiss";

export function UpdateNotice() {
  const [notice, setNotice] = useState<UpdateNoticePayload | null>(null);
  const open = notice !== null;

  useEffect(() => {
    const off = window.photoManager?.onUpdate?.((p) => {
      setNotice((cur) => {
        if (p.state === "closed") return cur && cur.version === p.version ? null : cur;
        // Progress only feeds a sheet that is showing this download.
        if (p.state === "downloading") {
          return cur && cur.version === p.version && cur.state === "downloading"
            ? { ...cur, ...p, state: "downloading", retryInSeconds: p.retryInSeconds }
            : cur;
        }
        return p;
      });
    });
    return off;
  }, []);

  const entry = useMemo(() => (notice ? parseNotes(notice.version, notice.notes ?? "") : null), [notice?.version, notice?.notes]);
  const hasNotes = !!entry && entry.groups.some((g) => g.points.length > 0);

  const act = (action: Action) => {
    void window.photoManager?.updateAction?.(action)?.catch(() => {});
    // "Update" keeps the sheet up to show the download.
    if (action === "download") setNotice((cur) => (cur ? { ...cur, state: "downloading", percent: 0 } : cur));
    else setNotice(null);
  };
  // Closing the download view just hides it; the "ready" prompt still comes.
  const close = () => (notice?.state === "downloading" ? setNotice(null) : act("dismiss"));
  useEscapeToClose(open, close);

  const title =
    notice?.state === "ready"
      ? "Update ready"
      : notice?.state === "downloading"
        ? "Downloading update"
        : notice?.state === "failed"
          ? "Update download failed"
          : "Update available";
  const line =
    notice?.state === "ready"
      ? `Rollfilm ${notice.version} has been downloaded.`
      : notice?.state === "failed"
        ? `Rollfilm ${notice.version} could not be downloaded${notice.reason ? ` (${notice.reason})` : ""}.`
        : notice
          ? `Rollfilm ${notice.version} is available${notice.current ? ` (you have ${notice.current})` : ""}.`
          : "";

  return createPortal(
    <Presence open={open} ms={MOTION.modal}>
      {notice && (
        <div className="modal-overlay" onClick={close}>
          <div
            className="modal whats-new-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="update-notice-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="whats-new-head">
              <h3 id="update-notice-title">{title}</h3>
            </div>
            <div className="whats-new-body">
              <p className="update-notice-line">{line}</p>
              {hasNotes && entry && (
                <details className="whats-new-version">
                  <summary className="whats-new-version-title">What's new</summary>
                  <ChangelogList entries={[entry]} titled={false} />
                </details>
              )}
            </div>
            <div className="whats-new-actions">
              {notice.state === "downloading" ? (
                <span className="update-notice-line" role="status">
                  {progressLine(notice)}
                </span>
              ) : (
                <>
                  <button type="button" className="btn" onClick={() => act("dismiss")}>
                    {notice.state === "available" && notice.mode !== "page" ? "Not now" : "Later"}
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    autoFocus
                    onClick={() =>
                      act(notice.state === "ready" ? "restart" : notice.mode === "page" ? "open-page" : "download")
                    }
                  >
                    {notice.state === "ready"
                      ? "Restart now"
                      : notice.mode === "page"
                        ? "Open download page"
                        : notice.state === "failed"
                          ? "Try again"
                          : "Update"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </Presence>,
    document.body
  );
}

// "43 % · 148 of 441 MB · 0.9 MB/s · about 6 min left" - or, between two
// attempts, when the next one comes.
function progressLine(n: UpdateNoticePayload): string {
  if (n.retryInSeconds != null) return `Connection lost, trying again in ${n.retryInSeconds} s`;
  const parts = [`${n.percent ?? 0} %`];
  if (n.total) parts.push(`${megabytes(n.transferred ?? 0)} of ${megabytes(n.total)} MB`);
  if (n.bytesPerSecond) {
    parts.push(n.bytesPerSecond >= 1048576 ? `${(n.bytesPerSecond / 1048576).toFixed(1)} MB/s` : `${Math.round(n.bytesPerSecond / 1024)} KB/s`);
  }
  if (n.etaSeconds != null) parts.push(n.etaSeconds < 60 ? "under a minute left" : `about ${Math.round(n.etaSeconds / 60)} min left`);
  return parts.join(" · ");
}

function megabytes(bytes: number): string {
  return String(Math.round(bytes / 1048576));
}

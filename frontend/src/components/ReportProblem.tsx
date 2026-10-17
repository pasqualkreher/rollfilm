import { IconFolder, IconHelp } from "./Icons";

// Two buttons wherever something went wrong and the user might want to say
// so: a GitHub issue with the version and the system filled in, and - in the
// desktop app - the logs folder, since the backend log is what every report
// needs. Also in Settings › About and the Help menu (main.js has the same
// link), so it can be found without an error on screen.
const REPO = "https://github.com/pasqualkreher/rollfilm";

function osLabel(): string {
  const p = window.photoManager?.platform;
  if (p === "darwin") return "macOS";
  if (p === "win32") return "Windows";
  if (p === "linux") return "Linux (AppImage)";
  return "Web";
}

export function issueUrl(title = ""): string {
  const params = new URLSearchParams({
    template: "bug_report.yml",
    version: __APP_VERSION__,
    os: osLabel(),
  });
  if (title) params.set("title", title);
  return `${REPO}/issues/new?${params.toString()}`;
}

export function ReportProblem({ title, compact = false }: { title?: string; compact?: boolean }) {
  const desktop = window.photoManager;
  const showLogs = async () => {
    const dir = await desktop?.getLogsDir?.();
    if (dir) await desktop?.revealFile?.(`${dir.replace(/[\\/]+$/, "")}/backend.log`);
  };
  const cls = compact ? "btn btn-sm" : "btn";
  return (
    <span className="report-problem">
      <a className={cls} href={issueUrl(title)} target="_blank" rel="noreferrer" title="Open a bug report on GitHub with the version and system filled in">
        <span className="btn-label">
          <IconHelp size={13} /> Report a problem
        </span>
      </a>
      {desktop?.getLogsDir && desktop.revealFile && (
        <button className={cls} onClick={() => void showLogs()} title="The backend log is what a report needs; this shows the logs folder">
          <span className="btn-label">
            <IconFolder size={13} /> Show logs
          </span>
        </button>
      )}
    </span>
  );
}

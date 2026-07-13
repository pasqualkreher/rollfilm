// Kills anything left over from a previous `npm run dev` so every start is
// clean. The usual culprit is an orphaned backend: when the dev terminal is
// Ctrl-C'd, concurrently SIGTERMs Electron, but Electron's will-quit/exit
// backend-stop handlers don't run on an external signal, so the Python backend
// keeps running and holds a write lock on the SQLite DB. The next start's fresh
// backend then hangs on migrations and the app sits on the splash spinner
// forever. We also free the Vite port (5173) in case a renderer dev server is
// still bound.
//
// Best-effort by design: missing tools / "no such process" are fine, so every
// step swallows its own errors and we never fail the start over cleanup.
const { execSync } = require("child_process");

const VITE_PORT = 5173;

// The dev backend (run_server.py) holds a write lock on the SQLite DB. If a
// previous start's backend is still shutting down when the next one boots, the
// new backend hangs on migrations and the app sits on the splash spinner
// forever. So for the backend pattern we don't just signal-and-continue: we
// wait for it to actually be gone, escalating to SIGKILL if it lingers.
const BACKEND_PATTERN = "run_server.py";

// Command-line fragments that uniquely identify *this project's* dev processes,
// so we never touch the user's editor or unrelated node apps.
const PATTERNS = [
  "run_server.py", // dev backend (python run_server.py)
  "photo_manager_backend", // packaged backend exe name, just in case
  // The dev Electron instance. We match a marker passed as a *command-line arg*
  // (electron/package.json: `electron . --pm-dev-electron`), NOT the PM_DEV=1
  // env var: env vars don't appear in argv, so `pkill -f` can't see them and the
  // real Electron process would survive. The arg is in argv, so this reliably
  // kills a leftover dev window. Pattern intentionally has no leading dashes so
  // pkill/pgrep don't parse it as options (we also pass `--`, but this is belt +
  // suspenders). See BACKEND_PATTERN for why the backend is special.
  "pm-dev-electron",
];

function run(cmd) {
  try {
    execSync(cmd, { stdio: "ignore" });
  } catch {
    // Non-zero exit (e.g. nothing matched) is expected and harmless.
  }
}

// True while at least one process matches the command-line pattern.
function anyAlive(pat) {
  try {
    execSync(`pgrep -f -- '${pat}'`, { stdio: "ignore" });
    return true;
  } catch {
    return false; // pgrep exits non-zero when nothing matches
  }
}

// Signal the pattern, then block (busy-wait via a synchronous sleep) until the
// process is actually gone, escalating to SIGKILL. Synchronous on purpose so the
// `predev` step doesn't return before the DB lock is released.
function killAndWait(pat) {
  run(`pkill -f -- '${pat}'`); // SIGTERM: let it shut down cleanly first
  const deadline = Date.now() + 5000;
  while (anyAlive(pat) && Date.now() < deadline) {
    run(`sleep 0.2`);
  }
  if (anyAlive(pat)) {
    run(`pkill -9 -f -- '${pat}'`); // still there — force it, then give it a moment
    const hardDeadline = Date.now() + 2000;
    while (anyAlive(pat) && Date.now() < hardDeadline) {
      run(`sleep 0.2`);
    }
  }
}

function cleanPosix() {
  for (const pat of PATTERNS) {
    if (pat === BACKEND_PATTERN) {
      killAndWait(pat); // wait for the DB lock to actually be released
    } else {
      // -f matches against the full command line; quotes keep it literal.
      // `--` so a pattern that starts with a dash isn't parsed as an option.
      run(`pkill -f -- '${pat}'`);
    }
  }
  // Free the Vite port by killing whatever listens on it.
  run(`lsof -ti tcp:${VITE_PORT} | xargs kill 2>/dev/null`);
}

function cleanWindows() {
  for (const pat of PATTERNS) {
    // WMIC-free: find PIDs whose command line contains the pattern, then kill.
    run(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${pat}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`
    );
  }
  run(
    `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${VITE_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"`
  );
}

if (process.platform === "win32") {
  cleanWindows();
} else {
  cleanPosix();
}

console.log("[dev-clean] cleared stale dev processes / port " + VITE_PORT);

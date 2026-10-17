// Types for the bridge exposed by the Electron preload script (see
// electron/preload.js). Undefined when running as a plain web app.
export {};

declare global {
  interface Window {
    /**
     * The labels of the tasks running in this window that quitting would cut
     * off (state/tasks.tsx): read by the desktop shell's quit dialog.
     */
    __rollfilmTasks?: () => string[];
    photoManager?: {
      /** Base URL of the locally-spawned backend, e.g. http://127.0.0.1:52345. */
      apiBaseUrl: string | null;
      /** Node's process.platform ("darwin", "win32", "linux"). Absent in older builds. */
      platform?: string;
      /** Physical RAM in GB (os.totalmem). Absent in older builds. */
      totalMemoryGb?: number;
      /**
       * Opens the native folder dialog; resolves to an absolute path or null.
       * `opts` names the dialog and where it opens (ignored by older builds).
       */
      pickFolder: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>;
      /** Native multi-file dialog; resolves to picked files (absolute path + size) or null. */
      pickFiles?: () => Promise<{ path: string; size: number }[] | null>;
      // Dropped paths sorted into folders and files (with sizes).
      classifyPaths?: (paths: string[]) => Promise<{ folders: string[]; files: { path: string; size: number }[] }>;
      /**
       * Selects a file in Finder / Explorer / the file manager; opens its
       * folder instead when the file is gone (`missing`). Absent in older builds.
       */
      revealFile?: (
        filePath: string
      ) => Promise<{ ok: boolean; missing?: boolean; error?: string }>;
      /** Current photo-library folder ("" until first-run setup picks one). */
      getLibraryRoot: () => Promise<string>;
      /**
       * First-run setup: opens the folder picker, saves the choice and starts
       * the backend. Resolves { ok: true, path } once the backend is healthy,
       * or { ok: false, canceled? } if the user dismissed the picker.
       */
      setupLibrary: () => Promise<{ ok: boolean; path?: string; canceled?: boolean }>;
      /**
       * Opens the folder dialog to pick a new library folder. If the user
       * confirms, the app restarts itself; otherwise resolves with changed: false.
       */
      changeLibraryRoot: () => Promise<{ changed: boolean; path?: string }>;
      /** Folder holding the database, thumbnails and staging (inside the library). */
      getDataRoot: () => Promise<string>;
      /** Whether this launch is a genuine first run (no library configured yet). */
      isFirstRun: () => Promise<boolean>;
      /** Leftover app-data folders from the old app name, with their sizes. */
      scanLegacyData: () => Promise<{ path: string; sizeBytes: number }[]>;
      /** Deletes those leftover folders; resolves with what was removed/failed. */
      removeLegacyData: () => Promise<{
        removed: string[];
        failed: { path: string; error: string }[];
      }>;
      /**
       * Prints a finished HTML document (the album canvas) to a PDF at a
       * location the user picks. Absent in builds that predate the export.
       */
      exportPdf?: (payload: {
        html: string;
        suggestedName: string;
        widthMm: number;
        heightMm: number;
      }) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      /**
       * Settings › Download backup: a save dialog, then the backup zip written
       * there. Resolves once it is on disk. Absent in older builds.
       */
      downloadBackup?: (url: string) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      /** The logs folder (backend.log, main.log, updater.log). Absent in older builds. */
      getLogsDir?: () => Promise<string>;
      /** Whether the window is fullscreen. Absent in older builds. */
      isFullScreen?: () => Promise<boolean>;
      /** Fullscreen changes; returns the unsubscribe. Absent in older builds. */
      onFullScreen?: (callback: (on: boolean) => void) => () => void;
      /** The page zoom factor (1 = actual size). Absent in older builds. */
      getZoom?: () => Promise<number>;
      /** Zoom changes; returns the unsubscribe. Absent in older builds. */
      onZoom?: (callback: (factor: number) => void) => () => void;
      /** macOS: show/hide the traffic lights (focus mode). Absent in older builds. */
      setWindowButtonsVisible?: (visible: boolean) => Promise<void>;
      /** View → Focus in the menu bar; returns the unsubscribe. Absent in older builds. */
      onToggleFocus?: (callback: () => void) => () => void;
      /** The menu bar's commands ("settings", "find", "import", "help", "shortcuts", "about"); returns the unsubscribe. Absent in older builds. */
      onMenu?: (callback: (command: string) => void) => () => void;
      /** The skin in force: native dialogs and the window's own paint follow it. Absent in older builds. */
      setTheme?: (theme: { mode: "light" | "dark" | "auto"; bg: string }) => Promise<void>;
      /** Dock / taskbar progress, 0–1; anything else clears it. Absent in older builds. */
      setProgress?: (fraction: number) => Promise<void>;
      /**
       * The Go and Photo menus and File → Export… in the macOS menu bar.
       * Actions: go:library, go:albums, go:canvas, go:map, go:import,
       * go:trash, go:stats, photo:rate (value 0–5), photo:color (value
       * "none" | "red" | "yellow" | "green" | "blue"), photo:flag (value
       * "pick" | "reject" | "" to unflag), photo:edit, photo:export,
       * photo:trash. The single-key shortcuts shown in the labels (0–5, P, X,
       * U, E, ⌫) are not registered by the menu - the renderer keeps handling
       * those keys. Returns the unsubscribe. Absent in older builds.
       */
      onAppMenu?: (callback: (msg: { action: string; value?: string | number }) => void) => () => void;
      /**
       * Drags these originals out to the Finder / Explorer as real files. Call
       * it from dragstart (after preventDefault). The shell drops the whole
       * drag if any path is not an existing file. Absent in older builds.
       */
      startDrag?: (paths: string[]) => void;
    };
  }

  /**
   * Files or folders dropped on the desktop window from outside, as absolute
   * paths. The preload dispatches it on `window` only for drops that carry
   * files and that no handler in the page already took (preventDefault);
   * drags within the app never fire it. Never fired in the browser build.
   */
  interface WindowEventMap {
    "pm:files-dropped": CustomEvent<{ paths: string[] }>;
  }
}

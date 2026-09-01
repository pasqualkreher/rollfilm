// Types for the bridge exposed by the Electron preload script (see
// electron/preload.js). Undefined when running as a plain web app.
export {};

declare global {
  interface Window {
    photoManager?: {
      /** Base URL of the locally-spawned backend, e.g. http://127.0.0.1:52345. */
      apiBaseUrl: string | null;
      /** Opens the native folder dialog; resolves to an absolute path or null. */
      pickFolder: () => Promise<string | null>;
      /** Native multi-file dialog; resolves to picked files (absolute path + size) or null. */
      pickFiles?: () => Promise<{ path: string; size: number }[] | null>;
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
    };
  }
}

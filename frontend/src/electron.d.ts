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
      /** Current photo-library folder (chosen on first start). */
      getLibraryRoot: () => Promise<string>;
      /**
       * Opens the folder dialog to pick a new library folder. If the user
       * confirms, the app restarts itself; otherwise resolves with changed: false.
       */
      changeLibraryRoot: () => Promise<{ changed: boolean; path?: string }>;
      /** Folder holding the database, thumbnails and staging (inside the library). */
      getDataRoot: () => Promise<string>;
    };
  }
}

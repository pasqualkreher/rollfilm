# Immich API key and the system keychain (not implemented)

**Today:** the Immich API key is a plain row in the backend's `app_settings`
table (`immich_api_key`, see `backend/app/services/settings_store.py`). Anyone
who can read the library's database file (`.photomanager/` inside the library,
or the local copy for a network library) can read the key. Library backups
already leave it out (`BACKUP_SECRET_SETTINGS` in `services/maintenance.py`).

**With `safeStorage`:** Electron's `safeStorage` encrypts a string with a key
held by the OS: the Keychain on macOS, DPAPI on Windows, and libsecret/kwallet
on Linux, with a weak fallback there when neither exists. Only the shell can
use it; the Python backend can't. So the shell would own the secret and hand it
over at every launch, the same way it hands over the API token:

1. **Storage (shell):** keep `safeStorage.encryptString(key)` as base64 in
   `userData/app-config.json` (per machine), or keyed by library path if
   libraries should keep separate Immich accounts.
2. **Handoff (shell → backend):** `startBackend` already writes the token as
   the first stdin line (`PM_API_TOKEN_STDIN=1`). A second line (or one JSON
   line `{ token, immichKey }`) would carry the decrypted key. `run_server.py`
   reads it once and keeps it in memory, never in env or argv, because `ps`
   can read those.
3. **Setting it (renderer → shell → backend):** Settings → Immich saves the
   key through a new IPC call (`pm:set-immich-key`) instead of `PUT
   /settings/immich`. The shell encrypts and stores it, then tells the running
   backend over an authenticated local route that only accepts the key in
   memory. The browser build would keep the database row.
4. **Migration:** on first start, move an existing `immich_api_key` row into
   the keychain and blank the row, but only after the keychain write
   succeeded.
5. **Reading it back:** settings routes that report "key set" read the
   in-memory value. Nothing returns the key to the page, same as today.

**Costs:** a second secret channel in `run_server.py`, a split between the
desktop and browser builds in the settings route and the Immich client
(`immich_sync.py` reads the key through `settings_store`), a migration, and on
macOS a Keychain prompt if the app's signature changes. The release builds are
unsigned (`identity: null`), so the prompt may come back after every update
until the app is signed. That last point is the main reason it isn't done yet.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bumpThumbnailCacheBust } from "../api/client";
import type { ImmichTestResult } from "../api/types";
import { useTheme, type Theme } from "../state/theme";
import { useTasks } from "../state/tasks";

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function Settings() {
  const queryClient = useQueryClient();
  const [theme, setTheme] = useTheme();
  const { setBusyLabel } = useTasks();
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [rebuildResult, setRebuildResult] = useState<string | null>(null);
  const [restoreConfirmation, setRestoreConfirmation] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreResult, setRestoreResult] = useState<string | null>(null);
  const restoreFileInputRef = useRef<HTMLInputElement | null>(null);

  // Library folder: only available in the desktop app (Electron bridge).
  const desktop = window.photoManager;
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);
  const [dataRoot, setDataRoot] = useState<string | null>(null);
  useEffect(() => {
    desktop?.getLibraryRoot?.().then(setLibraryRoot).catch(() => {});
    desktop?.getDataRoot?.().then(setDataRoot).catch(() => {});
  }, [desktop]);

  const [immichUrl, setImmichUrl] = useState("");
  const [immichKey, setImmichKey] = useState("");
  const [immichSaved, setImmichSaved] = useState(false);
  const [immichTest, setImmichTest] = useState<ImmichTestResult | null>(null);

  const { data: immich } = useQuery({
    queryKey: ["immich-settings"],
    queryFn: () => api.settings.getImmich(),
  });

  // Background uploads are fire-and-forget on the server; this is the only
  // place their outcome is visible. Poll while the page is open so results
  // appear shortly after an import finishes.
  const { data: immichUploads } = useQuery({
    queryKey: ["immich-uploads"],
    queryFn: () => api.settings.immichUploads(),
    refetchInterval: 10_000,
  });

  // Seed the host field from the server once, without clobbering edits in
  // progress. The API key is never sent back down (only whether one is set),
  // so its field stays blank and acts as "leave unchanged unless you type one".
  useEffect(() => {
    if (immich) setImmichUrl(immich.base_url ?? "");
  }, [immich]);

  const saveImmich = useMutation({
    mutationFn: () =>
      api.settings.updateImmich({
        base_url: immichUrl.trim(),
        // Blank = keep the existing key rather than wiping it.
        api_key: immichKey.trim() ? immichKey.trim() : undefined,
      }),
    onSuccess: () => {
      setImmichSaved(true);
      setImmichKey("");
      setImmichTest(null);
      queryClient.invalidateQueries({ queryKey: ["immich-settings"] });
    },
  });

  const testImmich = useMutation({
    mutationFn: () => api.settings.testImmich(),
    onSuccess: (result) => setImmichTest(result),
  });

  // Trash auto-cleanup: how many days deleted photos stay restorable before
  // the startup purge removes them for good (0 = keep forever).
  const [trashDays, setTrashDays] = useState<string>("");
  const [trashSaved, setTrashSaved] = useState(false);
  const { data: trashSettings } = useQuery({
    queryKey: ["trash-settings"],
    queryFn: () => api.settings.getTrash(),
  });
  useEffect(() => {
    if (trashSettings) setTrashDays(String(trashSettings.retention_days));
  }, [trashSettings]);
  const saveTrash = useMutation({
    mutationFn: () => api.settings.updateTrash(Math.max(0, parseInt(trashDays, 10) || 0)),
    onSuccess: (result) => {
      setTrashDays(String(result.retention_days));
      setTrashSaved(true);
      queryClient.invalidateQueries({ queryKey: ["trash-settings"] });
    },
  });

  const sync = useMutation({
    mutationFn: () => api.maintenance.sync(),
    onSuccess: (result) => {
      const parts = [
        `Removed ${result.removed_missing_files} entr${result.removed_missing_files === 1 ? "y" : "ies"} for files no longer on disk`,
        `cleaned up ${result.orphan_thumbnails_removed} orphaned thumbnail folder(s)`,
      ];
      if (result.thumbnails_queued > 0) {
        parts.push(
          `queued ${result.thumbnails_queued} missing thumbnail(s) for rebuild (finishes in the background)`
        );
      }
      setSyncResult(
        `${parts.join(", ")}. Found ${result.untracked_files_found} file(s) in the library folder that aren't imported yet.`
      );
      // Stale browser-cached thumbnails (e.g. for re-created derivatives) must
      // reload, not be served from cache.
      bumpThumbnailCacheBust();
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["trash"] });
    },
  });

  const rebuildThumbnails = useMutation({
    mutationFn: () => api.maintenance.rebuildThumbnails(),
    onSuccess: (result) => {
      setRebuildResult(`Rebuilt thumbnails/previews for ${result.rebuilt} photo(s).`);
      // Bump the cache-bust so the freshly rebuilt (e.g. higher-res) images
      // actually reload instead of being served from the browser cache.
      bumpThumbnailCacheBust();
      queryClient.invalidateQueries({ queryKey: ["images"] });
    },
  });

  const restore = useMutation({
    mutationFn: () => api.maintenance.restore(restoreFile!, restoreConfirmation),
    onSuccess: (result) => {
      setRestoreResult(`Restored ${result.images_restored} photo(s) and ${result.albums_restored} album(s).`);
      setRestoreConfirmation("");
      setRestoreFile(null);
      if (restoreFileInputRef.current) restoreFileInputRef.current.value = "";
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["albums"] });
    },
  });

  const { data: tagUsage } = useQuery({ queryKey: ["tag-usage"], queryFn: () => api.tags.usage() });
  const unusedTags = (tagUsage ?? []).filter((t) => t.count === 0);

  function invalidateTags() {
    queryClient.invalidateQueries({ queryKey: ["tag-usage"] });
    queryClient.invalidateQueries({ queryKey: ["tags"] });
  }

  const removeTag = useMutation({
    mutationFn: (name: string) => api.tags.remove(name),
    onSuccess: invalidateTags,
  });

  const pruneTags = useMutation({
    mutationFn: () => api.tags.pruneUnused(),
    onSuccess: invalidateTags,
  });

  // Surface the running maintenance task to the app shell, which locks the nav
  // (so the page can't be switched away and unmounted mid-task) and shows a
  // spinner. Cleared when idle and on unmount.
  const runningLabel = sync.isPending
    ? "Syncing library…"
    : rebuildThumbnails.isPending
      ? "Rebuilding thumbnails…"
      : restore.isPending
        ? "Restoring backup…"
        : null;
  useEffect(() => {
    setBusyLabel(runningLabel);
  }, [runningLabel, setBusyLabel]);
  useEffect(() => () => setBusyLabel(null), [setBusyLabel]);

  return (
    <div className="page settings-page">
      <h2 className="section-title">Settings</h2>

      <section style={{ marginBottom: 32 }}>
        <h3 className="section-title" style={{ fontSize: 15 }}>
          Appearance
        </h3>
        <p style={{ color: "var(--text-muted)" }}>
          Choose a light or dark look, or follow your system setting.
        </p>
        <span className="segmented">
          {THEME_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={theme === o.value ? "active" : ""}
              onClick={() => setTheme(o.value)}
            >
              {o.label}
            </button>
          ))}
        </span>
      </section>

      {desktop?.changeLibraryRoot && (
        <section style={{ marginBottom: 32 }}>
          <h3 className="section-title" style={{ fontSize: 15 }}>
            Library folder
          </h3>
          <p style={{ color: "var(--text-muted)" }}>
            Where your photo files are stored (chosen on first start), together with this library's
            database, thumbnails and staging. Changing the folder restarts the app and switches to
            that folder's library; your existing photo files are not moved automatically.
          </p>
          <p style={{ fontFamily: "monospace", fontSize: 13, wordBreak: "break-all" }}>
            {libraryRoot ?? "…"}
          </p>
          <button className="btn" onClick={() => desktop.changeLibraryRoot()}>
            Change library folder…
          </button>
        </section>
      )}

      {desktop?.getDataRoot && (
        <section style={{ marginBottom: 32 }}>
          <h3 className="section-title" style={{ fontSize: 15 }}>
            Library data
          </h3>
          <p style={{ color: "var(--text-muted)" }}>
            The database, thumbnails and import staging live in a hidden{" "}
            <code>.photomanager</code> subfolder inside the library folder, so the whole library is
            self-contained and moves with the folder — point the app at a different library folder
            to switch to a separate library. If the folder is cloud-synced, exclude{" "}
            <code>.photomanager</code> from syncing. (The model cache and logs stay in the standard
            app-data location.)
          </p>
          <p style={{ fontFamily: "monospace", fontSize: 13, wordBreak: "break-all" }}>
            {dataRoot ?? "…"}
          </p>
        </section>
      )}

      <section style={{ marginBottom: 32 }}>
        <h3 className="section-title" style={{ fontSize: 15 }}>
          Immich integration
        </h3>
        <p style={{ color: "var(--text-muted)" }}>
          Add your Immich host and an API key here to enable the{" "}
          <em>"Also upload to Immich"</em> option during import. Only JPEGs are uploaded - RAW files
          stay in this library only. Create an API key in Immich under{" "}
          <strong>Account Settings → API Keys</strong>.
        </p>
        <label className="filter-field" style={{ display: "block", marginBottom: 10 }}>
          <span style={{ display: "block", marginBottom: 4, color: "var(--text-muted)" }}>
            Immich host
          </span>
          <input
            type="text"
            placeholder="http://your-immich:2283"
            value={immichUrl}
            onChange={(e) => {
              setImmichUrl(e.target.value);
              setImmichSaved(false);
            }}
            style={{ width: "100%", boxSizing: "border-box" }}
          />
        </label>
        <label className="filter-field" style={{ display: "block", marginBottom: 10 }}>
          <span style={{ display: "block", marginBottom: 4, color: "var(--text-muted)" }}>
            API key {immich?.api_key_set && <em>(a key is saved - leave blank to keep it)</em>}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            placeholder={immich?.api_key_set ? "••••••••  (unchanged)" : "Paste your Immich API key"}
            value={immichKey}
            onChange={(e) => {
              setImmichKey(e.target.value);
              setImmichSaved(false);
            }}
            style={{ width: "100%", boxSizing: "border-box" }}
          />
        </label>
        <div className="import-toolbar">
          <button
            className="btn primary"
            onClick={() => saveImmich.mutate()}
            disabled={!immichUrl.trim() || saveImmich.isPending}
          >
            {saveImmich.isPending ? "Saving..." : "Save Immich settings"}
          </button>
          <button
            className="btn"
            onClick={() => testImmich.mutate()}
            disabled={!immich?.api_key_set || testImmich.isPending}
            title={!immich?.api_key_set ? "Save a host and API key first" : undefined}
          >
            {testImmich.isPending ? "Testing..." : "Test connection"}
          </button>
        </div>
        {immichSaved && <p style={{ color: "var(--text-muted)" }}>Immich settings saved.</p>}
        {saveImmich.isError && (
          <p style={{ color: "var(--danger)" }}>{(saveImmich.error as Error).message}</p>
        )}
        {immichTest && (
          <p style={{ color: immichTest.ok ? "var(--text-muted)" : "var(--danger)" }}>
            {immichTest.ok ? "✓ " : "✗ "}
            {immichTest.message}
          </p>
        )}
        {immichUploads && immichUploads.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>Recent uploads</h4>
            <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", fontSize: 13 }}>
              {immichUploads.slice(0, 8).map((u) => (
                <li key={`${u.filename}-${u.at}`} style={{ padding: "3px 0" }}>
                  <span style={{ color: u.ok ? "var(--text-muted)" : "var(--danger)" }}>
                    {u.ok ? "✓" : "✗"}
                  </span>{" "}
                  {u.filename}{" "}
                  <span style={{ color: u.ok ? "var(--text-muted)" : "var(--danger)" }}>
                    — {u.ok ? u.detail : `failed after 3 attempts: ${u.detail}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section style={{ marginBottom: 32 }}>
        <h3 className="section-title" style={{ fontSize: 15 }}>
          Trash
        </h3>
        <p style={{ color: "var(--text-muted)" }}>
          Deleted library photos stay in the Trash and can be restored. On every app start, photos
          that have been in the Trash longer than this are deleted for good, in the background.
          Set 0 to keep them forever. (Photos from external sources never go to the Trash -
          deleting one only removes it from the catalog, the file on the source is untouched.)
        </p>
        <div className="import-toolbar" style={{ alignItems: "center" }}>
          <label className="filter-field">
            <span style={{ marginRight: 6, color: "var(--text-muted)" }}>Delete after</span>
            <input
              type="number"
              min={0}
              max={3650}
              value={trashDays}
              onChange={(e) => {
                setTrashDays(e.target.value);
                setTrashSaved(false);
              }}
              style={{ width: 80 }}
            />
            <span style={{ marginLeft: 6, color: "var(--text-muted)" }}>days</span>
          </label>
          <button
            className="btn primary"
            onClick={() => saveTrash.mutate()}
            disabled={trashDays === "" || saveTrash.isPending}
          >
            {saveTrash.isPending ? "Saving..." : "Save"}
          </button>
          {trashSaved && (
            <span style={{ color: "var(--text-muted)" }}>
              Saved{parseInt(trashDays, 10) === 0 ? " — photos are kept forever." : "."}
            </span>
          )}
        </div>
        {saveTrash.isError && (
          <p style={{ color: "var(--danger)" }}>{(saveTrash.error as Error).message}</p>
        )}
      </section>

      <section style={{ marginBottom: 32 }}>
        <h3 className="section-title" style={{ fontSize: 15 }}>
          Tags
        </h3>
        <p style={{ color: "var(--text-muted)" }}>
          Unused tags are ones no photo carries anymore (left behind after retagging or deleting
          photos). Remove them to keep the tag filter tidy.
        </p>
        {unusedTags.length === 0 ? (
          <p style={{ color: "var(--text-muted)" }}>No unused tags — nothing to clean up.</p>
        ) : (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {unusedTags.map((t) => (
                <span key={t.name} className="tag-chip">
                  {t.name}
                  <button
                    type="button"
                    onClick={() => removeTag.mutate(t.name)}
                    disabled={removeTag.isPending}
                    aria-label={`Remove tag ${t.name}`}
                    title={`Remove “${t.name}”`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <button className="btn" onClick={() => pruneTags.mutate()} disabled={pruneTags.isPending}>
              {pruneTags.isPending
                ? "Removing…"
                : `Remove all ${unusedTags.length} unused tag${unusedTags.length === 1 ? "" : "s"}`}
            </button>
          </>
        )}
        {(removeTag.isError || pruneTags.isError) && (
          <p style={{ color: "var(--danger)" }}>
            {((removeTag.error || pruneTags.error) as Error).message}
          </p>
        )}
      </section>

      <section style={{ marginBottom: 32 }}>
        <h3 className="section-title" style={{ fontSize: 15 }}>
          Library maintenance
        </h3>
        <p style={{ color: "var(--text-muted)" }}>
          The library folder on disk is the source of truth. This removes database entries whose
          files are no longer there (e.g. deleted outside the app), cleans up thumbnails that belong
          to no photo anymore, and regenerates missing thumbnails in the background.
        </p>
        <button className="btn" onClick={() => sync.mutate()} disabled={sync.isPending}>
          {sync.isPending ? "Syncing..." : "Sync database to library"}
        </button>
        {syncResult && <p style={{ color: "var(--text-muted)" }}>{syncResult}</p>}

        <p style={{ color: "var(--text-muted)", marginTop: 16 }}>
          Emergency reset: rebuilds <em>every</em> cached thumbnail/preview from the original files,
          which can take a long time. Normally "Sync database to library" above is all you need -
          use this only if thumbnails still look wrong afterwards (e.g. after an image rendering
          fix).
        </p>
        <button className="btn" onClick={() => rebuildThumbnails.mutate()} disabled={rebuildThumbnails.isPending}>
          {rebuildThumbnails.isPending ? "Rebuilding..." : "Rebuild all thumbnails"}
        </button>
        {rebuildResult && <p style={{ color: "var(--text-muted)" }}>{rebuildResult}</p>}
      </section>

      <section style={{ marginBottom: 32 }}>
        <h3 className="section-title" style={{ fontSize: 15 }}>
          Backup &amp; restore
        </h3>
        <p style={{ color: "var(--text-muted)" }}>
          Download a backup of your managed library: every imported photo file plus its ratings,
          color labels, albums, and edits. Photos from external sources are not bundled - they stay
          on their own storage and can be re-indexed by re-adding the source. Tags are not included
          in the backup.
        </p>
        <a className="btn primary" href={api.maintenance.backupUrl()} style={{ display: "inline-block" }}>
          Download backup
        </a>

        <p style={{ color: "var(--text-muted)", marginTop: 20 }}>
          Restoring a backup <strong>replaces everything currently in your library</strong> with the
          backup's contents. Files on external sources are not touched; their catalog entries are
          rebuilt on the next scan.
        </p>
        <input
          ref={restoreFileInputRef}
          type="file"
          accept=".zip"
          onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)}
          style={{ marginBottom: 8, display: "block" }}
        />
        <div className="import-toolbar">
          <input
            type="text"
            placeholder="Type delete to confirm"
            value={restoreConfirmation}
            onChange={(e) => setRestoreConfirmation(e.target.value)}
          />
          <button
            className="btn danger"
            disabled={!restoreFile || restoreConfirmation.trim().toLowerCase() !== "delete" || restore.isPending}
            onClick={() => restore.mutate()}
          >
            {restore.isPending ? "Restoring..." : "Restore from backup"}
          </button>
        </div>
        {restoreResult && <p style={{ color: "var(--text-muted)" }}>{restoreResult}</p>}
        {restore.isError && (
          <p style={{ color: "var(--danger)" }}>{(restore.error as Error).message}</p>
        )}
      </section>
    </div>
  );
}

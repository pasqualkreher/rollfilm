import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ImmichTestResult } from "../api/types";

export function Settings() {
  const queryClient = useQueryClient();
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [rebuildResult, setRebuildResult] = useState<string | null>(null);
  const [wipeConfirmation, setWipeConfirmation] = useState("");
  const [restoreConfirmation, setRestoreConfirmation] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreResult, setRestoreResult] = useState<string | null>(null);
  const restoreFileInputRef = useRef<HTMLInputElement | null>(null);

  const [immichUrl, setImmichUrl] = useState("");
  const [immichKey, setImmichKey] = useState("");
  const [immichSaved, setImmichSaved] = useState(false);
  const [immichTest, setImmichTest] = useState<ImmichTestResult | null>(null);

  const { data: immich } = useQuery({
    queryKey: ["immich-settings"],
    queryFn: () => api.settings.getImmich(),
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

  const sync = useMutation({
    mutationFn: () => api.maintenance.sync(),
    onSuccess: (result) => {
      setSyncResult(
        `Removed ${result.removed_missing_files} entr${result.removed_missing_files === 1 ? "y" : "ies"} for files no longer on disk. ` +
          `Found ${result.untracked_files_found} file(s) in the library folder that aren't imported yet.`
      );
      queryClient.invalidateQueries({ queryKey: ["images"] });
    },
  });

  const rebuildThumbnails = useMutation({
    mutationFn: () => api.maintenance.rebuildThumbnails(),
    onSuccess: (result) => {
      setRebuildResult(`Rebuilt thumbnails/previews for ${result.rebuilt} photo(s).`);
      queryClient.invalidateQueries({ queryKey: ["images"] });
    },
  });

  const wipe = useMutation({
    mutationFn: () => api.maintenance.wipe(wipeConfirmation),
    onSuccess: () => {
      setWipeConfirmation("");
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["albums"] });
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

  return (
    <div className="page" style={{ maxWidth: 640 }}>
      <h2 className="section-title">Settings</h2>

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
      </section>

      <section style={{ marginBottom: 32 }}>
        <h3 className="section-title" style={{ fontSize: 15 }}>
          Library maintenance
        </h3>
        <p style={{ color: "var(--text-muted)" }}>
          The library folder on disk is the source of truth. This removes any database entries whose
          files are no longer there (e.g. deleted outside the app).
        </p>
        <button className="btn" onClick={() => sync.mutate()} disabled={sync.isPending}>
          {sync.isPending ? "Syncing..." : "Sync database to library"}
        </button>
        {syncResult && <p style={{ color: "var(--text-muted)" }}>{syncResult}</p>}

        <p style={{ color: "var(--text-muted)", marginTop: 16 }}>
          Rebuilds every cached thumbnail/preview from the original files - use this after an image
          rendering fix that only applies to newly-generated thumbnails.
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
          Download a backup containing every photo plus all ratings, colors, albums, and edits.
        </p>
        <a className="btn primary" href={api.maintenance.backupUrl()} style={{ display: "inline-block" }}>
          Download backup
        </a>

        <p style={{ color: "var(--text-muted)", marginTop: 20 }}>
          Restoring a backup <strong>replaces everything currently in your library</strong> with the
          backup's contents.
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
            className="btn"
            style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
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

      <section>
        <h3 className="section-title" style={{ fontSize: 15, color: "var(--danger)" }}>
          Danger zone
        </h3>
        <p style={{ color: "var(--text-muted)" }}>
          Permanently deletes every photo, album, and rating. This cannot be undone - download a backup
          first if you're not sure.
        </p>
        <div className="import-toolbar">
          <input
            type="text"
            placeholder="Type delete to confirm"
            value={wipeConfirmation}
            onChange={(e) => setWipeConfirmation(e.target.value)}
          />
          <button
            className="btn"
            style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
            disabled={wipeConfirmation.trim().toLowerCase() !== "delete" || wipe.isPending}
            onClick={() => {
              if (window.confirm("This will permanently delete your entire library. Are you sure?")) {
                wipe.mutate();
              }
            }}
          >
            {wipe.isPending ? "Deleting..." : "Delete entire library"}
          </button>
        </div>
        {wipe.isSuccess && <p style={{ color: "var(--text-muted)" }}>Library deleted.</p>}
      </section>
    </div>
  );
}

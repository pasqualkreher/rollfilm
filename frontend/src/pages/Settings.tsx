import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bumpThumbnailCacheBust } from "../api/client";
import type { ImmichSyncMode, ImmichTestResult } from "../api/types";
import { ThemePicker } from "../components/ThemePicker";
import { useTasks } from "../state/tasks";

// A collapsible Settings section, driven as an accordion: opening one closes
// the others (the parent tracks a single open title). Clicking the open one
// closes it, so all sections can be shut. Nothing is open by default.
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3 className="settings-section-header">{title}</h3>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

// The adjustment groups the Auto develop suggestion may touch. Keys mirror the
// backend's AUTO_DEVELOP_GROUP_NAMES (services/settings_store.py); the field
// lists live in services/auto_develop.py (GROUP_FIELDS).
const AUTO_DEVELOP_GROUPS: { key: string; label: string; desc: string }[] = [
  { key: "tone", label: "Tone", desc: "Exposure, contrast, highlights, shadows, whites, blacks" },
  { key: "white_balance", label: "White balance", desc: "Temperature, tint" },
  { key: "color", label: "Color", desc: "Vibrance, saturation, hue, HSL mixer, color grading, calibration" },
  { key: "details", label: "Details", desc: "Sharpness, clarity, dehaze, structure, noise reduction" },
  { key: "curves", label: "Curves", desc: "Point and parametric tone curves" },
  { key: "effects", label: "Effects", desc: "Grain, vignette, glow, halation, mist, LUT strength" },
];

export function Settings() {
  const queryClient = useQueryClient();
  const { setBusyLabel } = useTasks();

  // Sections are always open (no accordion) - sectionProps just carries the
  // title so every call site stays unchanged.
  const sectionProps = (title: string) => ({ title });
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [rebuildResult, setRebuildResult] = useState<string | null>(null);
  const [repairDatesResult, setRepairDatesResult] = useState<string | null>(null);
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

  // Sync progress (X of Y on Immich) + pause state. Polled so the counter
  // visibly climbs while the background sync works through the library.
  const { data: immichActivity } = useQuery({
    queryKey: ["immich-activity"],
    queryFn: () => api.settings.immichActivity(),
    refetchInterval: 5_000,
  });

  const setImmichPaused = useMutation({
    mutationFn: (paused: boolean) => api.settings.setImmichPaused(paused),
    onSuccess: (activity) => queryClient.setQueryData(["immich-activity"], activity),
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

  const setSyncMode = useMutation({
    mutationFn: (mode: ImmichSyncMode) =>
      api.settings.updateImmich({
        base_url: (immich?.base_url ?? immichUrl).trim(),
        sync_mode: mode,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["immich-settings"] }),
  });

  // Auto develop: opt-in for the editor's Auto button, which suggests develop
  // settings learned from the user's own saved edits.
  const { data: autoDevelop } = useQuery({
    queryKey: ["auto-develop-settings"],
    queryFn: () => api.settings.getAutoDevelop(),
  });
  const setAutoDevelop = useMutation({
    mutationFn: (patch: { enabled: boolean; enabled_groups?: string[] }) =>
      api.settings.updateAutoDevelop(patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auto-develop-settings"] }),
  });
  function toggleAutoGroup(key: string, on: boolean) {
    if (!autoDevelop) return;
    const next = on
      ? [...autoDevelop.enabled_groups, key]
      : autoDevelop.enabled_groups.filter((g) => g !== key);
    setAutoDevelop.mutate({ enabled: autoDevelop.enabled, enabled_groups: next });
  }

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

  // RAW decoding: whether RAWs load with no brightness processing (native
  // sensor exposure) or are self-normalized to a consistent brightness.
  const { data: rawDecode } = useQuery({
    queryKey: ["raw-decode-settings"],
    queryFn: () => api.settings.getRawDecode(),
  });
  const setRawDecode = useMutation({
    mutationFn: (native: boolean) => api.settings.updateRawDecode(native),
    onSuccess: (result) => {
      queryClient.setQueryData(["raw-decode-settings"], result);
      // On-disk thumbnails/previews were baked under the old mode - rebuild them
      // so the whole library reflects the change (the editor's in-memory base is
      // already dropped server-side).
      rebuildThumbnails.mutate();
    },
  });

  const repairDates = useMutation({
    mutationFn: () => api.maintenance.repairDates(),
    onSuccess: (result) => {
      setRepairDatesResult(
        result.fixed > 0
          ? `Corrected the capture date of ${result.fixed} photo(s) (${result.checked} checked) — the timeline now sorts them onto their real day.`
          : `All ${result.checked} photo(s) already carry their correct capture date.`
      );
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
      : repairDates.isPending
        ? "Repairing capture dates…"
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

      <Section {...sectionProps("Appearance")}>
        <p style={{ color: "var(--text-muted)" }}>
          Pick a colour skin, or follow your system's light/dark setting. The
          preview on each tile shows its own colours.
        </p>
        <ThemePicker />
      </Section>

      {desktop?.changeLibraryRoot && (
        <Section {...sectionProps("Library folder")}>
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
        </Section>
      )}

      {desktop?.getDataRoot && (
        <Section {...sectionProps("Library data")}>
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
        </Section>
      )}

      <Section {...sectionProps("Immich integration")}>
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
        {immich?.api_key_set && (
          <div style={{ marginTop: 18 }}>
            <h4 style={{ margin: "0 0 4px", fontSize: 13 }}>Sync mode</h4>
            <p style={{ color: "var(--text-muted)", margin: "0 0 8px", fontSize: 13 }}>
              How photos reach Immich. Only JPEGs are uploaded — RAW files always stay in this
              library only.
            </p>
            {(
              [
                {
                  value: "manual",
                  title: "Ask on import",
                  desc: "Show the “Also upload to Immich” checkbox on import, plus the manual “Add to Immich” buttons. Nothing is synced automatically.",
                },
                {
                  value: "selective",
                  title: "Selective sync",
                  desc: "Sync only the photos and albums you flag with “Sync to Immich”. Flagged items upload automatically and albums are mirrored.",
                },
                {
                  value: "full",
                  title: "Full sync",
                  desc: "Automatically upload every imported JPEG and mirror every album to Immich.",
                },
              ] as { value: ImmichSyncMode; title: string; desc: string }[]
            ).map((opt) => (
              <label
                key={opt.value}
                className="filter-field"
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-start",
                  padding: "6px 0",
                  cursor: setSyncMode.isPending ? "wait" : "pointer",
                }}
              >
                <input
                  type="radio"
                  name="immich-sync-mode"
                  checked={(immich?.sync_mode ?? "manual") === opt.value}
                  disabled={setSyncMode.isPending}
                  onChange={() => setSyncMode.mutate(opt.value)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <strong>{opt.title}</strong>
                  <span style={{ display: "block", color: "var(--text-muted)", fontSize: 12 }}>
                    {opt.desc}
                  </span>
                </span>
              </label>
            ))}
            {setSyncMode.isError && (
              <p style={{ color: "var(--danger)" }}>{(setSyncMode.error as Error).message}</p>
            )}
            {immichActivity && (
              <div style={{ marginTop: 16 }}>
                <h4 style={{ margin: "0 0 4px", fontSize: 13 }}>Sync status</h4>
                <p style={{ color: "var(--text-muted)", margin: "0 0 6px", fontSize: 13 }}>
                  {immichActivity.synced} of {immichActivity.total} photos on Immich
                  {immichActivity.pending_uploads > 0 &&
                    ` — ${immichActivity.pending_uploads} uploading`}
                  {immichActivity.paused && " — sync paused"}
                </p>
                <div
                  style={{
                    height: 6,
                    maxWidth: 420,
                    borderRadius: 3,
                    background: "var(--border)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${
                        immichActivity.total > 0
                          ? Math.round((immichActivity.synced / immichActivity.total) * 100)
                          : 100
                      }%`,
                      background: immichActivity.paused ? "var(--text-muted)" : "var(--accent)",
                      transition: "width 0.4s ease",
                    }}
                  />
                </div>
                <label
                  className="filter-field"
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "flex-start",
                    marginTop: 12,
                    cursor: setImmichPaused.isPending ? "wait" : "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={immichActivity.paused}
                    disabled={setImmichPaused.isPending}
                    onChange={(e) => setImmichPaused.mutate(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    <strong>Pause automatic sync</strong>
                    <span style={{ display: "block", color: "var(--text-muted)", fontSize: 12 }}>
                      Stops background uploads until you resume — useful on mobile data or another
                      metered connection. Manual “Add to Immich” still works, and resuming catches
                      up automatically.
                    </span>
                  </span>
                </label>
                {setImmichPaused.isError && (
                  <p style={{ color: "var(--danger)" }}>
                    {(setImmichPaused.error as Error).message}
                  </p>
                )}
              </div>
            )}
          </div>
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
      </Section>

      <Section {...sectionProps("RAW files")}>
        <p style={{ color: "var(--text-muted)" }}>
          RAW files come off the sensor looking flat and often too dark, so they normally need a
          starting correction before they look right on screen.
        </p>
        <p style={{ color: "var(--text-muted)" }}>
          <strong>Off (default):</strong> every RAW gets that starting correction automatically —
          dark shots are brightened to a normal level, and bright areas like sky, snow or sunlit skin
          are held back so they don't turn into flat white patches. Photos that are already well
          exposed stay as they are.
          <br />
          <strong>On:</strong> no correction at all. You see the RAW exactly as the camera recorded
          it — usually darker and flatter — and set the look yourself in the editor.
        </p>
        <label
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            cursor: setRawDecode.isPending || rebuildThumbnails.isPending ? "wait" : "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={rawDecode?.native_decode ?? false}
            disabled={rawDecode === undefined || setRawDecode.isPending || rebuildThumbnails.isPending}
            onChange={(e) => setRawDecode.mutate(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>Load RAWs without processing (native exposure)</strong>
            <br />
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
              {rebuildThumbnails.isPending
                ? "Rebuilding thumbnails so the change applies to your library…"
                : "Changing this rebuilds thumbnails/previews so it applies to already-imported photos."}
            </span>
          </span>
        </label>
      </Section>

      <Section {...sectionProps("Auto develop")}>
        <p style={{ color: "var(--text-muted)" }}>
          Adds an <strong>Auto</strong> button to the photo editor that suggests develop settings
          learned from your own editing: it finds the photos most similar to the one you're editing
          among those you've saved (in place or as a copy) and blends the settings you chose for
          them. The more photos you edit, the better the suggestions get. Suggestions only fill the
          sliders — nothing is applied to your photo until you save.
        </p>
        <label
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            cursor: setAutoDevelop.isPending ? "wait" : "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoDevelop?.enabled ?? false}
            disabled={autoDevelop === undefined || setAutoDevelop.isPending}
            onChange={(e) => setAutoDevelop.mutate({ enabled: e.target.checked })}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>Show the Auto button in the editor</strong>
            <span style={{ display: "block", color: "var(--text-muted)", fontSize: 12 }}>
              {autoDevelop === undefined
                ? "…"
                : autoDevelop.example_count === 0
                  ? "No edited photos yet — save an edit (or an edited copy) and Auto can start learning from it."
                  : `Currently learning from ${autoDevelop.example_count} edited photo${autoDevelop.example_count === 1 ? "" : "s"} in your library.`}
            </span>
          </span>
        </label>
        {autoDevelop?.enabled && (
          <div style={{ marginTop: 12, marginLeft: 24 }}>
            <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 8px" }}>
              Which settings Auto is allowed to change — unchecked groups keep their current values:
            </p>
            {AUTO_DEVELOP_GROUPS.map((g) => (
              <label
                key={g.key}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-start",
                  padding: "3px 0",
                  cursor: setAutoDevelop.isPending ? "wait" : "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={autoDevelop.enabled_groups.includes(g.key)}
                  disabled={setAutoDevelop.isPending}
                  onChange={(e) => toggleAutoGroup(g.key, e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  {g.label}
                  <span style={{ display: "block", color: "var(--text-muted)", fontSize: 12 }}>
                    {g.desc}
                  </span>
                </span>
              </label>
            ))}
            {autoDevelop.enabled_groups.length === 0 && (
              <p style={{ color: "var(--danger)", fontSize: 12 }}>
                All groups are unchecked — the Auto button won't change anything.
              </p>
            )}
          </div>
        )}
        {setAutoDevelop.isError && (
          <p style={{ color: "var(--danger)" }}>{(setAutoDevelop.error as Error).message}</p>
        )}
      </Section>

      <Section {...sectionProps("Trash")}>
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
      </Section>

      <Section {...sectionProps("Tags")}>
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
      </Section>

      <Section {...sectionProps("Library maintenance")}>
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

        <p style={{ color: "var(--text-muted)", marginTop: 16 }}>
          Photos imported by older versions could end up sorted by their import moment instead of
          when they were taken (their capture date wasn't read from every EXIF variant yet). This
          re-reads the capture date from every photo's file and fixes the stored one where it
          differs - nothing else about the photos changes.
        </p>
        <button className="btn" onClick={() => repairDates.mutate()} disabled={repairDates.isPending}>
          {repairDates.isPending ? "Repairing dates..." : "Repair capture dates"}
        </button>
        {repairDatesResult && <p style={{ color: "var(--text-muted)" }}>{repairDatesResult}</p>}
      </Section>

      <Section {...sectionProps("Backup & restore")}>
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
      </Section>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bumpThumbnailCacheBust } from "../api/client";
import type { BorgTestResult, ImmichSyncMode, ImmichTestResult } from "../api/types";
import { ThemePicker } from "../components/ThemePicker";
import { IconX } from "../components/Icons";
import { skinInfo, useAppearance, type Appearance } from "../state/theme";
import { useCorners } from "../state/corners";
import { useTasks } from "../state/tasks";
import { useAskDeletePartner, setAskDeletePartner } from "../state/viewPrefs";
import { SettingsTour, SETTINGS_TOUR_KEY } from "../components/SettingsTour";
import { useTransientFlag, useTransientMessage, useTransientValue } from "../utils/transientMessage";
import {
  estimateText,
  estimateSeconds,
  formatDuration,
  progressText,
  recordRate,
  useElapsed,
} from "../utils/rebuildEstimate";

// localStorage key for the self-calibrating rebuild rate. ".v2" = the
// parallelised rebuild; the old sequential key's rate would overestimate ~3x.
const REBUILD_EST_KEY = "pm.est.rebuildThumbs.v2";

// One Settings section. `hidden` is set by the page for every section that
// belongs to a tab other than the open one: not rendered rather than merely
// invisible, so the tab really is the shorter page it looks like.
function Section({
  title,
  hidden,
  children,
}: {
  title: string;
  hidden?: boolean;
  children: ReactNode;
}) {
  if (hidden) return null;
  return (
    // data-settings-section lets the guided tour (SettingsTour) find the
    // rendered sections and scroll/highlight each one.
    <section className="settings-section" data-settings-section={title}>
      <h3 className="settings-section-header">{title}</h3>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

// The tabs across the top of Settings, and which sections live under each.
// Eleven sections in one column was a page you had to scroll and re-scan to
// find anything; five groups of two or three is a page you can look at.
// Section titles are the identity everywhere (the tour, data-settings-section),
// so they are what's listed here.
const SETTINGS_TABS: { id: string; label: string; sections: string[] }[] = [
  { id: "look", label: "Look & feel", sections: ["Appearance"] },
  {
    id: "library",
    label: "Library",
    sections: ["Library folder", "Library data", "Smart albums", "Tags", "Trash"],
  },
  { id: "photos", label: "Photos", sections: ["RAW files", "Auto develop"] },
  { id: "integrations", label: "Integrations", sections: ["Immich integration"] },
  {
    id: "maintenance",
    label: "Maintenance",
    sections: ["Library maintenance", "Backup & restore"],
  },
];

// Which tab a section belongs to. A section missing from the table above would
// otherwise be unreachable, so it falls back to the first tab.
function tabOfSection(title: string): string {
  return SETTINGS_TABS.find((t) => t.sections.includes(title))?.id ?? SETTINGS_TABS[0].id;
}

// ---- Shared building blocks so every section is styled the same way -------

// A muted description paragraph.
function Desc({ children }: { children: ReactNode }) {
  return <p className="settings-desc">{children}</p>;
}

// A status/result line (muted, or red when it's an error).
function Note({ children, error }: { children: ReactNode; error?: boolean }) {
  return <p className={`settings-note${error ? " settings-note--error" : ""}`}>{children}</p>;
}

// A toggle row (checkbox or radio) with a bold title and optional description —
// the single shape used for every option in Settings.
function OptionRow({
  type,
  name,
  checked,
  disabled,
  busy,
  onChange,
  title,
  desc,
}: {
  type: "checkbox" | "radio";
  name?: string;
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  onChange: (checked: boolean) => void;
  title: ReactNode;
  desc?: ReactNode;
}) {
  return (
    <label className={`settings-option${busy ? " busy" : ""}`}>
      <input
        type={type}
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="settings-option-body">
        <strong>{title}</strong>
        {desc != null && <span className="settings-option-desc">{desc}</span>}
      </span>
    </label>
  );
}

// A labelled text/password input filling the reading column.
function Field({
  label,
  type = "text",
  placeholder,
  value,
  autoComplete,
  onChange,
}: {
  label: ReactNode;
  type?: "text" | "password";
  placeholder?: string;
  value: string;
  autoComplete?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="settings-field">
      <span className="settings-field-label">{label}</span>
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

// Appearance: a compact summary of the current setup plus a button that opens
// the full picker in a modal, so the skin grid doesn't flood the Settings page.
// Under Auto the preview is split - the light skin beside the dark one, since
// both are in play - and otherwise shows the single skin that's on screen.
function ThemeSummaryPreview({ appearance }: { appearance: Appearance }) {
  const light = skinInfo(appearance.light);
  const dark = skinInfo(appearance.dark);
  if (appearance.mode === "auto") {
    return (
      <span className="theme-summary-preview tp-split">
        <span className="tp-half" style={{ background: light.bg }}>
          <span className="tp-line" style={{ background: light.text }} />
          <span className="tp-pill" style={{ background: light.accent }} />
        </span>
        <span className="tp-half" style={{ background: dark.bg }}>
          <span className="tp-line" style={{ background: dark.text }} />
          <span className="tp-pill" style={{ background: dark.accent }} />
        </span>
      </span>
    );
  }
  const skin = skinInfo(appearance.resolved);
  return (
    <span className="theme-summary-preview" style={{ background: skin.bg }}>
      <span className="tp-line" style={{ background: skin.text }} />
      <span className="tp-pill" style={{ background: skin.accent }} />
    </span>
  );
}

function AppearanceSetting() {
  const appearance = useAppearance();
  const [corners, setCorners] = useCorners();
  const [open, setOpen] = useState(false);

  const label =
    appearance.mode === "auto"
      ? `${skinInfo(appearance.light).label} · ${skinInfo(appearance.dark).label}`
      : skinInfo(appearance.resolved).label;
  const sub =
    appearance.mode === "auto"
      ? `Follows your system — showing ${skinInfo(appearance.resolved).label}`
      : `Always ${appearance.mode}`;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <Desc>Pick a light skin and a dark one, then choose which is showing.</Desc>
      <div className="theme-summary">
        <ThemeSummaryPreview appearance={appearance} />
        <div className="theme-summary-text">
          <span className="theme-summary-label">{label}</span>
          <span className="theme-summary-sub">{sub}</span>
        </div>
        <button className="btn" onClick={() => setOpen(true)}>
          Change appearance…
        </button>
      </div>

      <div className="settings-corners">
        <span className="settings-option-body">
          <strong>Corners</strong>
          <span className="settings-option-desc">
            Rounded or sharp, angular corners on cards, buttons and thumbnails.
          </span>
        </span>
        <span className="segmented">
          <button
            className={corners === "rounded" ? "active" : ""}
            aria-pressed={corners === "rounded"}
            onClick={() => setCorners("rounded")}
          >
            Rounded
          </button>
          <button
            className={corners === "square" ? "active" : ""}
            aria-pressed={corners === "square"}
            onClick={() => setCorners("square")}
          >
            Square
          </button>
        </span>
      </div>

      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div
            className="modal theme-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Choose appearance"
          >
            <div className="dir-picker-header">
              <h3 className="section-title" style={{ margin: 0, fontSize: 15 }}>
                Appearance
              </h3>
              <button className="modal-close" onClick={() => setOpen(false)} aria-label="Close">
                <IconX size={14} />
              </button>
            </div>
            <div className="theme-modal-body">
              <ThemePicker />
            </div>
            <div className="theme-modal-footer">
              <button className="btn primary" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// The adjustment groups the Auto develop suggestion may touch. Keys mirror the
// backend's AUTO_DEVELOP_GROUP_NAMES (services/settings_store.py); the field
// lists live in services/auto_develop.py (GROUP_FIELDS).
const AUTO_DEVELOP_GROUPS: { key: string; label: string; desc: string }[] = [
  { key: "tone", label: "Tone", desc: "Exposure, contrast, highlights, shadows, whites, blacks" },
  { key: "white_balance", label: "White balance", desc: "Temperature, tint" },
  { key: "color", label: "Color", desc: "Vibrance, saturation, hue, film simulation, HSL mixer, color grading, calibration" },
  { key: "details", label: "Details", desc: "Sharpness, clarity, dehaze, structure, noise reduction" },
  { key: "curves", label: "Curves", desc: "Point and parametric tone curves" },
  { key: "effects", label: "Effects", desc: "Grain, vignette, glow, halation, mist, LUT strength" },
];

// The smart-album sections the Albums page can show. Keys mirror the backend's
// SMART_ALBUM_SECTION_NAMES (services/settings_store.py).
const SMART_ALBUM_SECTIONS: { key: string; label: string; desc: string }[] = [
  { key: "moments", label: "Moments", desc: "Groups of visually similar photos, found and named automatically (beaches, portraits, food, …)." },
  { key: "tags", label: "Tags", desc: "One album per tag you've given your photos — albums by tag." },
  { key: "places", label: "Places", desc: "Photos taken close together, named after the nearest town. Uses the radius below." },
  { key: "countries", label: "Countries", desc: "One album per country, from the photos' GPS position." },
  { key: "country_years", label: "Countries by year", desc: "The country albums split by year — e.g. “Italy 2024”." },
  { key: "days", label: "Big days", desc: "Single days with unusually many photos — a trip, a party, an event." },
  { key: "years", label: "Years", desc: "One album per year." },
  { key: "months", label: "Months", desc: "One album per month." },
  { key: "edits", label: "Edited", desc: "Every photo you edited, plus the saved edit copies." },
];

export function Settings() {
  const queryClient = useQueryClient();
  const { setBusyLabel } = useTasks();
  // Whether deleting a paired photo asks "only this file or the whole pair?".
  // Client-side view preference (see viewPrefs), not a server setting.
  const askDeletePartner = useAskDeletePartner();

  // The open tab. sectionProps stays the single indirection every section call
  // site goes through, so grouping them cost no change at the call sites.
  const [activeTab, setActiveTab] = useState(SETTINGS_TABS[0].id);
  const sectionProps = (title: string) => ({
    title,
    hidden: tabOfSection(title) !== activeTab,
  });

  // Guided section-by-section tour: auto-starts when the onboarding wizard
  // sent the user here (sessionStorage flag), restartable anytime via the
  // "Show me around" button, skippable at every step.
  const [tourOpen, setTourOpen] = useState(() => {
    try {
      return sessionStorage.getItem(SETTINGS_TOUR_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.removeItem(SETTINGS_TOUR_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  // Result summaries auto-dismiss after a moment (a bit longer than the plain
  // "Saved." flags - there is more to read).
  const [syncResult, setSyncResult] = useTransientMessage(8000);
  const [rebuildResult, setRebuildResult] = useTransientMessage(8000);
  const [repairDatesResult, setRepairDatesResult] = useTransientMessage(8000);
  const [restoreConfirmation, setRestoreConfirmation] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreResult, setRestoreResult] = useTransientMessage(8000);
  const restoreFileInputRef = useRef<HTMLInputElement | null>(null);

  // Library folder: only available in the desktop app (Electron bridge).
  const desktop = window.photoManager;
  // The tour's script: every section THIS build renders, in tab order. Two of
  // them exist only in the desktop app, so the web build's tour simply skips
  // them - it used to get that for free by reading the DOM, which the tabs
  // took away (all but one tab's sections are unrendered at any moment).
  const tourSections = useMemo(() => {
    const absent = new Set<string>();
    if (!desktop?.changeLibraryRoot) absent.add("Library folder");
    if (!desktop?.getDataRoot) absent.add("Library data");
    return SETTINGS_TABS.flatMap((tab) => tab.sections.filter((title) => !absent.has(title)));
  }, [desktop]);
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);
  const [dataRoot, setDataRoot] = useState<string | null>(null);
  useEffect(() => {
    desktop?.getLibraryRoot?.().then(setLibraryRoot).catch(() => {});
    desktop?.getDataRoot?.().then(setDataRoot).catch(() => {});
  }, [desktop]);

  const [immichUrl, setImmichUrl] = useState("");
  const [immichKey, setImmichKey] = useState("");
  const [immichSaved, setImmichSaved] = useTransientFlag();
  const [immichTest, setImmichTest] = useTransientValue<ImmichTestResult>(8000);

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

  // Master switch. Server/key/mode stay stored while off, so switching back
  // on restores the integration exactly as it was.
  const setImmichEnabled = useMutation({
    mutationFn: (enabled: boolean) =>
      api.settings.updateImmich({
        base_url: (immich?.base_url ?? immichUrl).trim(),
        enabled,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["immich-settings"] });
      queryClient.invalidateQueries({ queryKey: ["immich-activity"] });
    },
  });

  // Borg backup: an automatic, incremental backup to a repository "address".
  const [borgRepo, setBorgRepo] = useState("");
  const [borgPass, setBorgPass] = useState("");
  const [borgSaved, setBorgSaved] = useTransientFlag();
  const [borgTest, setBorgTest] = useTransientValue<BorgTestResult>(8000);

  // Poll while the page is open so a running backup and its outcome (this same
  // endpoint carries the live status) show up without a manual refresh.
  const { data: borg } = useQuery({
    queryKey: ["borg-settings"],
    queryFn: () => api.settings.getBorg(),
    refetchInterval: 5_000,
  });

  // Seed the repo field once from the server without clobbering an edit in
  // progress; the passphrase is never sent back down, so its field stays blank.
  useEffect(() => {
    if (borg) setBorgRepo(borg.repo ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [borg?.repo]);

  const saveBorg = useMutation({
    mutationFn: (enabled: boolean) =>
      api.settings.updateBorg({
        enabled,
        repo: borgRepo.trim(),
        // Blank = keep the existing passphrase rather than wiping it.
        passphrase: borgPass ? borgPass : undefined,
      }),
    onSuccess: (data) => {
      setBorgSaved(true);
      setBorgPass("");
      setBorgTest(null);
      queryClient.setQueryData(["borg-settings"], data);
    },
  });

  const testBorg = useMutation({
    mutationFn: () => api.settings.testBorg(),
    onSuccess: (result) => {
      setBorgTest(result);
      queryClient.invalidateQueries({ queryKey: ["borg-settings"] });
    },
  });

  const backupBorgNow = useMutation({
    mutationFn: () => api.settings.backupBorgNow(),
    onSuccess: (data) => queryClient.setQueryData(["borg-settings"], data),
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

  // Smart albums: which auto-computed sections the Albums page shows, and the
  // km radius that defines a "place". Checkboxes save immediately; the radius
  // has its own Save (typing shouldn't fire a request per keystroke).
  const [placeRadius, setPlaceRadius] = useState<string>("");
  const [radiusSaved, setRadiusSaved] = useTransientFlag();
  const { data: smartAlbumSettings } = useQuery({
    queryKey: ["smart-album-settings"],
    queryFn: () => api.settings.getSmartAlbums(),
  });
  useEffect(() => {
    if (smartAlbumSettings) setPlaceRadius(String(smartAlbumSettings.place_radius_km));
  }, [smartAlbumSettings]);
  const saveSmartAlbums = useMutation({
    mutationFn: (patch: { sections?: string[]; place_radius_km?: number }) =>
      api.settings.updateSmartAlbums(patch),
    onSuccess: (result) => {
      setPlaceRadius(String(result.place_radius_km));
      queryClient.invalidateQueries({ queryKey: ["smart-album-settings"] });
      // The Albums page's smart sections are built from these settings.
      queryClient.invalidateQueries({ queryKey: ["smart-albums"] });
    },
  });
  function toggleSmartSection(key: string, on: boolean) {
    if (!smartAlbumSettings) return;
    const next = on
      ? [...smartAlbumSettings.sections, key]
      : smartAlbumSettings.sections.filter((s) => s !== key);
    saveSmartAlbums.mutate({ sections: next });
  }

  // Trash auto-cleanup: how many days deleted photos stay restorable before
  // the startup purge removes them for good (0 = keep forever).
  const [trashDays, setTrashDays] = useState<string>("");
  const [trashSaved, setTrashSaved] = useTransientFlag();
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

  // Total library photos, so the maintenance jobs can show a pre-flight time
  // estimate ("≈ N photos · about Xm") before the user commits to a long run.
  const { data: libraryCount } = useQuery({
    queryKey: ["images", "count", "all"],
    queryFn: () => api.images.count(),
  });
  const photoCount = libraryCount?.count;

  const sync = useMutation({
    mutationFn: () => api.maintenance.sync(),
    onMutate: () => ({ startedAt: Date.now() }),
    onSuccess: (result, _vars, ctx) => {
      recordRate("pm.est.sync", (Date.now() - ctx.startedAt) / 1000, photoCount ?? 0);
      const parts = [
        `Removed ${result.removed_missing_files} entr${result.removed_missing_files === 1 ? "y" : "ies"} for files no longer on disk`,
        `cleaned up ${result.orphan_thumbnails_removed} orphaned thumbnail folder(s)`,
      ];
      if (result.renamed_files_followed > 0) {
        // Worth its own sentence: the photos kept their stars, tags and edits
        // instead of being dropped, which is the opposite of what the first
        // number would otherwise suggest happened to them.
        parts.push(
          `followed ${result.renamed_files_followed} file(s) you renamed or moved yourself`
        );
      }
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
    onMutate: () => ({ startedAt: Date.now() }),
    onSuccess: (result, _vars, ctx) => {
      recordRate(REBUILD_EST_KEY, (Date.now() - ctx.startedAt) / 1000, result.rebuilt);
      setRebuildResult(`Rebuilt thumbnails/previews for ${result.rebuilt} photo(s).`);
      // Bump the cache-bust so the freshly rebuilt (e.g. higher-res) images
      // actually reload instead of being served from the browser cache.
      bumpThumbnailCacheBust();
      queryClient.invalidateQueries({ queryKey: ["images"] });
    },
  });

  // Live elapsed timers for the two long jobs, shown next to their buttons.
  const syncElapsed = useElapsed(sync.isPending);
  const rebuildElapsed = useElapsed(rebuildThumbnails.isPending);

  // Real progress of the running rebuild ("N of M photos"), polled from the
  // server while the job runs. The remaining time comes from the measured
  // live rate (elapsed / photos done), which beats the pre-flight estimate.
  const { data: rebuildProg } = useQuery({
    queryKey: ["rebuild-progress"],
    queryFn: () => api.maintenance.rebuildProgress(),
    refetchInterval: 1000,
    enabled: rebuildThumbnails.isPending,
  });
  function rebuildProgressLine(): string {
    const p = rebuildProg;
    if (rebuildThumbnails.isPending && p?.active && p.total > 0 && p.done > 0) {
      const remainSec = ((rebuildElapsed / 1000) * (p.total - p.done)) / p.done;
      return `${p.done.toLocaleString()} of ${p.total.toLocaleString()} photos · ~${formatDuration(remainSec)} left`;
    }
    return progressText(rebuildElapsed, estimateSeconds(photoCount, REBUILD_EST_KEY));
  }

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
      <h2 className="section-title">
        Settings
        <button
          className="btn subtle"
          style={{ marginLeft: 12, fontSize: 13 }}
          onClick={() => setTourOpen(true)}
          title="A quick guided walk through every settings section"
        >
          Show me around
        </button>
      </h2>

      <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`settings-tab${activeTab === tab.id ? " active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <Section {...sectionProps("Appearance")}>
        <AppearanceSetting />
      </Section>

      {desktop?.changeLibraryRoot && (
        <Section {...sectionProps("Library folder")}>
          <Desc>
            Where your photo files are stored (chosen on first start), together with this library's
            database, thumbnails and staging. Changing the folder restarts the app and switches to
            that folder's library; your existing photo files are not moved automatically.
          </Desc>
          <p className="settings-path">{libraryRoot ?? "…"}</p>
          <button className="btn" onClick={() => desktop.changeLibraryRoot()}>
            Change library folder…
          </button>
        </Section>
      )}

      {desktop?.getDataRoot && (
        <Section {...sectionProps("Library data")}>
          <Desc>
            The database, thumbnails and import staging live in a hidden{" "}
            <code>.photomanager</code> subfolder inside the library folder, so the whole library is
            self-contained and moves with the folder — point the app at a different library folder
            to switch to a separate library. If the folder is cloud-synced, exclude{" "}
            <code>.photomanager</code> from syncing. (The model cache and logs stay in the standard
            app-data location.)
          </Desc>
          <p className="settings-path">{dataRoot ?? "…"}</p>
        </Section>
      )}

      <Section {...sectionProps("Immich integration")}>
        <Desc>
          Add your Immich host and an API key here to enable the{" "}
          <em>"Also upload to Immich"</em> option during import. Only JPEGs are uploaded - RAW files
          stay in this library only. Create an API key in Immich under{" "}
          <strong>Account Settings → API Keys</strong>.
        </Desc>
        <OptionRow
          type="checkbox"
          checked={immich?.enabled ?? true}
          disabled={immich === undefined || setImmichEnabled.isPending}
          busy={setImmichEnabled.isPending}
          onChange={(c) => setImmichEnabled.mutate(c)}
          title="Enable Immich integration"
          desc="Off = nothing is uploaded or synced and the Immich options disappear from import and albums. Your server, API key and sync mode stay saved."
        />
        {setImmichEnabled.isError && (
          <Note error>{(setImmichEnabled.error as Error).message}</Note>
        )}
        {(immich?.enabled ?? true) && (
        <>
        <Field
          label="Immich host"
          placeholder="http://your-immich:2283"
          value={immichUrl}
          onChange={(v) => {
            setImmichUrl(v);
            setImmichSaved(false);
          }}
        />
        <Field
          type="password"
          autoComplete="new-password"
          label={
            <>
              API key {immich?.api_key_set && <em>(a key is saved - leave blank to keep it)</em>}
            </>
          }
          placeholder={immich?.api_key_set ? "••••••••  (unchanged)" : "Paste your Immich API key"}
          value={immichKey}
          onChange={(v) => {
            setImmichKey(v);
            setImmichSaved(false);
          }}
        />
        <div className="import-toolbar">
          <button
            className="btn primary"
            onClick={() => saveImmich.mutate()}
            disabled={!immichUrl.trim() || saveImmich.isPending}
          >
            {saveImmich.isPending ? (
              <>
                <span className="btn-spinner" aria-hidden="true" />
                Saving...
              </>
            ) : (
              "Save Immich settings"
            )}
          </button>
          <button
            className="btn"
            onClick={() => testImmich.mutate()}
            disabled={!immich?.api_key_set || testImmich.isPending}
            title={!immich?.api_key_set ? "Save a host and API key first" : undefined}
          >
            {testImmich.isPending ? (
              <>
                <span className="btn-spinner" aria-hidden="true" />
                Testing...
              </>
            ) : (
              "Test connection"
            )}
          </button>
        </div>
        {immichSaved && <Note>Immich settings saved.</Note>}
        {saveImmich.isError && <Note error>{(saveImmich.error as Error).message}</Note>}
        {immichTest && (
          <Note error={!immichTest.ok}>
            {immichTest.ok ? "✓ " : "✗ "}
            {immichTest.message}
          </Note>
        )}
        {immich?.api_key_set && (
          <div className="settings-subgroup">
            <h4 className="settings-subhead">Sync mode</h4>
            <Desc>
              How photos reach Immich. Only JPEGs are uploaded — RAW files always stay in this
              library only.
            </Desc>
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
              <OptionRow
                key={opt.value}
                type="radio"
                name="immich-sync-mode"
                checked={(immich?.sync_mode ?? "manual") === opt.value}
                disabled={setSyncMode.isPending}
                busy={setSyncMode.isPending}
                onChange={() => setSyncMode.mutate(opt.value)}
                title={opt.title}
                desc={opt.desc}
              />
            ))}
            {setSyncMode.isError && <Note error>{(setSyncMode.error as Error).message}</Note>}
            {immichActivity && (
              <div className="settings-subgroup">
                <h4 className="settings-subhead">Sync status</h4>
                <Desc>
                  {immichActivity.synced} of {immichActivity.total} photos on Immich
                  {immichActivity.pending_uploads > 0 &&
                    ` — ${immichActivity.pending_uploads} uploading`}
                  {immichActivity.paused && " — sync paused"}
                </Desc>
                <div className="settings-progress">
                  <div
                    className={`settings-progress-fill${immichActivity.paused ? " paused" : ""}`}
                    style={{
                      width: `${
                        immichActivity.total > 0
                          ? Math.round((immichActivity.synced / immichActivity.total) * 100)
                          : 100
                      }%`,
                    }}
                  />
                </div>
                <div className="settings-subgroup">
                  <OptionRow
                    type="checkbox"
                    checked={immichActivity.paused}
                    disabled={setImmichPaused.isPending}
                    busy={setImmichPaused.isPending}
                    onChange={(c) => setImmichPaused.mutate(c)}
                    title="Pause automatic sync"
                    desc="Stops background uploads until you resume — useful on mobile data or another metered connection. Manual “Add to Immich” still works, and resuming catches up automatically."
                  />
                </div>
                {setImmichPaused.isError && (
                  <Note error>{(setImmichPaused.error as Error).message}</Note>
                )}
              </div>
            )}
          </div>
        )}
        {immichUploads && immichUploads.length > 0 && (
          <div className="settings-subgroup">
            <h4 className="settings-subhead">Recent uploads</h4>
            <ul className="settings-list">
              {immichUploads.slice(0, 8).map((u) => (
                <li key={`${u.filename}-${u.at}`}>
                  <span className={u.ok ? "ok" : "fail"}>{u.ok ? "✓" : "✗"}</span> {u.filename}{" "}
                  <span className={u.ok ? "ok" : "fail"}>
                    — {u.ok ? u.detail : `failed after 3 attempts: ${u.detail}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        </>
        )}
      </Section>

      <Section {...sectionProps("RAW files")}>
        <Desc>
          RAW files come off the sensor looking flat and often too dark, so they normally need a
          starting correction before they look right on screen.
        </Desc>
        <Desc>
          <strong>Off (default):</strong> every RAW gets that starting correction automatically —
          dark shots are brightened to a normal level, and bright areas like sky, snow or sunlit skin
          are held back so they don't turn into flat white patches. Photos that are already well
          exposed stay as they are.
          <br />
          <strong>On:</strong> no correction at all. You see the RAW exactly as the camera recorded
          it — usually darker and flatter — and set the look yourself in the editor.
        </Desc>
        <OptionRow
          type="checkbox"
          checked={rawDecode?.native_decode ?? false}
          disabled={rawDecode === undefined || setRawDecode.isPending || rebuildThumbnails.isPending}
          busy={setRawDecode.isPending || rebuildThumbnails.isPending}
          onChange={(c) => setRawDecode.mutate(c)}
          title="Load RAWs without processing (native exposure)"
          desc={
            rebuildThumbnails.isPending
              ? `Rebuilding thumbnails so the change applies to your library… ${rebuildProgressLine()}`
              : `Changing this rebuilds thumbnails/previews so it applies to already-imported photos.${
                  estimateText(photoCount, REBUILD_EST_KEY)
                    ? ` ${estimateText(photoCount, REBUILD_EST_KEY)}`
                    : ""
                }`
          }
        />
      </Section>

      <Section {...sectionProps("Auto develop")}>
        <Desc>
          Adds an <strong>Auto</strong> button to the photo editor that suggests develop settings
          learned from your own editing: it finds the photos most similar to the one you're editing
          among those you've saved (in place or as a copy) and blends the settings you chose for
          them. The more photos you edit, the better the suggestions get. Suggestions only fill the
          sliders — nothing is applied to your photo until you save.
        </Desc>
        <OptionRow
          type="checkbox"
          checked={autoDevelop?.enabled ?? false}
          disabled={autoDevelop === undefined || setAutoDevelop.isPending}
          busy={setAutoDevelop.isPending}
          onChange={(c) => setAutoDevelop.mutate({ enabled: c })}
          title="Show the Auto button in the editor"
          desc={
            autoDevelop === undefined
              ? "…"
              : autoDevelop.example_count === 0
                ? "No edited photos yet — save an edit (or an edited copy) and Auto can start learning from it."
                : `Currently learning from ${autoDevelop.example_count} edited photo${autoDevelop.example_count === 1 ? "" : "s"} in your library.`
          }
        />
        {autoDevelop?.enabled && (
          <div className="settings-subgroup settings-subgroup--indent">
            <Desc>
              Which settings Auto is allowed to change — unchecked groups keep their current values:
            </Desc>
            {AUTO_DEVELOP_GROUPS.map((g) => (
              <OptionRow
                key={g.key}
                type="checkbox"
                checked={autoDevelop.enabled_groups.includes(g.key)}
                disabled={setAutoDevelop.isPending}
                busy={setAutoDevelop.isPending}
                onChange={(c) => toggleAutoGroup(g.key, c)}
                title={g.label}
                desc={g.desc}
              />
            ))}
            {autoDevelop.enabled_groups.length === 0 && (
              <Note error>All groups are unchecked — the Auto button won't change anything.</Note>
            )}
          </div>
        )}
        {setAutoDevelop.isError && <Note error>{(setAutoDevelop.error as Error).message}</Note>}
      </Section>

      <Section {...sectionProps("Smart albums")}>
        <Desc>
          The Albums page can show automatic collections above your own albums — visually similar
          photos, places, countries and time groups. They're computed from your library and update
          on their own; nothing is stored as a real album. Pick which sections you want:
        </Desc>
        {SMART_ALBUM_SECTIONS.map((s) => (
          <div key={s.key}>
            <OptionRow
              type="checkbox"
              checked={smartAlbumSettings?.sections.includes(s.key) ?? false}
              disabled={smartAlbumSettings === undefined || saveSmartAlbums.isPending}
              busy={saveSmartAlbums.isPending}
              onChange={(c) => toggleSmartSection(s.key, c)}
              title={s.label}
              desc={s.desc}
            />
            {/* The place radius belongs to Places, so it sits right under it
                (and only when Places is on). */}
            {s.key === "places" && smartAlbumSettings?.sections.includes("places") && (
              <div className="settings-subcontrol">
                <div className="import-toolbar" style={{ alignItems: "center" }}>
                  <label className="filter-field">
                    <span style={{ marginRight: 6, color: "var(--text-muted)" }}>Place radius</span>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      step={1}
                      value={placeRadius}
                      onChange={(e) => {
                        setPlaceRadius(e.target.value);
                        setRadiusSaved(false);
                      }}
                      style={{ width: 80 }}
                    />
                    <span style={{ marginLeft: 6, color: "var(--text-muted)" }}>km</span>
                  </label>
                  <button
                    className="btn primary"
                    onClick={() => {
                      saveSmartAlbums.mutate(
                        { place_radius_km: Math.max(1, parseFloat(placeRadius) || 5) },
                        { onSuccess: () => setRadiusSaved(true) }
                      );
                    }}
                    disabled={placeRadius === "" || saveSmartAlbums.isPending}
                  >
                    {saveSmartAlbums.isPending ? "Saving..." : "Save"}
                  </button>
                  {radiusSaved && <span className="status-note">Saved.</span>}
                </div>
                <Note>
                  Photos within this distance of each other form one place — small values separate
                  neighboring towns, large values group whole regions.
                </Note>
              </div>
            )}
          </div>
        ))}
        {smartAlbumSettings?.sections.length === 0 && (
          <Note>All sections are off — the Albums page shows only your own albums.</Note>
        )}
        {saveSmartAlbums.isError && <Note error>{(saveSmartAlbums.error as Error).message}</Note>}
      </Section>

      <Section {...sectionProps("Trash")}>
        <Desc>
          Deleted library photos stay in the Trash and can be restored. On every app start, photos
          that have been in the Trash longer than this are deleted for good, in the background.
          Set 0 to keep them forever. (Photos from external sources never go to the Trash -
          deleting one only removes it from the catalog, the file on the source is untouched.)
        </Desc>
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
            <span className="status-note">
              Saved{parseInt(trashDays, 10) === 0 ? " — photos are kept forever." : "."}
            </span>
          )}
        </div>
        {saveTrash.isError && <Note error>{(saveTrash.error as Error).message}</Note>}
        <OptionRow
          type="checkbox"
          checked={askDeletePartner}
          onChange={setAskDeletePartner}
          title="Ask what to delete for RAW + JPEG pairs"
          desc="A RAW and its matching JPEG are normally deleted together. With this on, deleting one first asks whether to remove only that file or the whole pair."
        />
      </Section>

      <Section {...sectionProps("Tags")}>
        <Desc>
          Unused tags are ones no photo carries anymore (left behind after retagging or deleting
          photos). Remove them to keep the tag filter tidy.
        </Desc>
        {unusedTags.length === 0 ? (
          <Desc>No unused tags — nothing to clean up.</Desc>
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
              {pruneTags.isPending ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Removing…
                </>
              ) : (
                `Remove all ${unusedTags.length} unused tag${unusedTags.length === 1 ? "" : "s"}`
              )}
            </button>
          </>
        )}
        {(removeTag.isError || pruneTags.isError) && (
          <Note error>{((removeTag.error || pruneTags.error) as Error).message}</Note>
        )}
      </Section>

      <Section {...sectionProps("Library maintenance")}>
        <div className="settings-block">
          <Desc>
            The library folder on disk is the source of truth. This removes database entries whose
            files are no longer there (e.g. deleted outside the app), cleans up thumbnails that
            belong to no photo anymore, and regenerates missing thumbnails in the background.
          </Desc>
          <div className="maintenance-run">
            <button className="btn" onClick={() => sync.mutate()} disabled={sync.isPending}>
              {sync.isPending ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Syncing...
                </>
              ) : (
                "Sync database to library"
              )}
            </button>
            {sync.isPending ? (
              <span className="maintenance-eta">
                Syncing… {progressText(syncElapsed, estimateSeconds(photoCount, "pm.est.sync"))}
              </span>
            ) : (
              estimateText(photoCount, "pm.est.sync") && (
                <span className="maintenance-eta">{estimateText(photoCount, "pm.est.sync")}</span>
              )
            )}
          </div>
          {syncResult && <Note>{syncResult}</Note>}
        </div>

        <div className="settings-block">
          <Desc>
            Emergency reset: rebuilds <em>every</em> cached thumbnail/preview from the original
            files, which can take a long time. Normally "Sync database to library" above is all you
            need - use this only if thumbnails still look wrong afterwards (e.g. after an image
            rendering fix).
          </Desc>
          <div className="maintenance-run">
            <button
              className="btn"
              onClick={() => rebuildThumbnails.mutate()}
              disabled={rebuildThumbnails.isPending}
            >
              {rebuildThumbnails.isPending ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Rebuilding...
                </>
              ) : (
                "Rebuild all thumbnails"
              )}
            </button>
            {rebuildThumbnails.isPending ? (
              <span className="maintenance-eta">Rebuilding… {rebuildProgressLine()}</span>
            ) : (
              estimateText(photoCount, REBUILD_EST_KEY) && (
                <span className="maintenance-eta">{estimateText(photoCount, REBUILD_EST_KEY)}</span>
              )
            )}
          </div>
          {rebuildResult && <Note>{rebuildResult}</Note>}
        </div>

        <div className="settings-block">
          <Desc>
            Photos imported by older versions could end up sorted by their import moment instead of
            when they were taken (their capture date wasn't read from every EXIF variant yet). This
            re-reads the capture date from every photo's file and fixes the stored one where it
            differs - nothing else about the photos changes.
          </Desc>
          <button className="btn" onClick={() => repairDates.mutate()} disabled={repairDates.isPending}>
            {repairDates.isPending ? (
              <>
                <span className="btn-spinner" aria-hidden="true" />
                Repairing dates...
              </>
            ) : (
              "Repair capture dates"
            )}
          </button>
          {repairDatesResult && <Note>{repairDatesResult}</Note>}
        </div>
      </Section>

      <Section {...sectionProps("Backup & restore")}>
        <div className="settings-block">
          <Desc>
            Download a backup of your managed library: every imported photo file plus its ratings,
            color labels, albums, and edits. Photos from external sources are not bundled - they stay
            on their own storage and can be re-indexed by re-adding the source. Tags are not included
            in the backup.
          </Desc>
          <a className="btn primary" href={api.maintenance.backupUrl()} style={{ display: "inline-block" }}>
            Download backup
          </a>
        </div>

        <div className="settings-block">
          <div className="settings-subgroup">
            <h4 className="settings-subhead">Automatic backup (Borg)</h4>
            <Desc>
              Keep a continuously updated backup in a{" "}
              <a href="https://www.borgbackup.org" target="_blank" rel="noreferrer">
                Borg
              </a>{" "}
              repository. Borg is deduplicating, so each run stores only what changed since the last
              one, and the backup updates automatically after imports and edits (and at least once a
              day). The <em>repository address</em> can be a local folder, a mounted NAS path, or a
              remote <code>user@host:/path</code> reached over SSH. Only your managed library and its
              database are backed up — photos from external sources stay on their own storage.
            </Desc>

            {borg && !borg.available && (
              <Note error>
                Borg isn't installed on this machine. Install it, then reload — on macOS:{" "}
                <code>brew install borgbackup</code>. Backups stay off until Borg is available.
              </Note>
            )}

            <Field
              label="Repository address"
              placeholder="/Volumes/Backup/rollfilm  or  user@host:/backups/rollfilm"
              value={borgRepo}
              onChange={(v) => {
                setBorgRepo(v);
                setBorgSaved(false);
              }}
            />
            <Field
              type="password"
              autoComplete="new-password"
              label={
                <>
                  Passphrase{" "}
                  {borg?.passphrase_set ? (
                    <em>(a passphrase is saved — leave blank to keep it)</em>
                  ) : (
                    <em>(encrypts the repository; leave blank for an unencrypted repo)</em>
                  )}
                </>
              }
              placeholder={borg?.passphrase_set ? "••••••••  (unchanged)" : "Choose a passphrase"}
              value={borgPass}
              onChange={(v) => {
                setBorgPass(v);
                setBorgSaved(false);
              }}
            />
            <div className="import-toolbar">
              <button
                className="btn primary"
                onClick={() => saveBorg.mutate(borg?.enabled ?? false)}
                disabled={!borgRepo.trim() || saveBorg.isPending}
              >
                {saveBorg.isPending ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Saving...
                  </>
                ) : (
                  "Save backup settings"
                )}
              </button>
              <button
                className="btn"
                onClick={() => testBorg.mutate()}
                disabled={!borg?.available || !borgRepo.trim() || testBorg.isPending}
                title={!borg?.available ? "Install Borg first" : undefined}
              >
                {testBorg.isPending ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Testing...
                  </>
                ) : (
                  "Test repository"
                )}
              </button>
              <button
                className="btn"
                onClick={() => backupBorgNow.mutate()}
                disabled={
                  !borg?.available || !borg?.repo || borg?.running || backupBorgNow.isPending
                }
                title={
                  !borg?.repo ? "Save a repository address first" : undefined
                }
              >
                {borg?.running || backupBorgNow.isPending ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Backing up...
                  </>
                ) : (
                  "Back up now"
                )}
              </button>
            </div>
            {borgSaved && <Note>Backup settings saved.</Note>}
            {saveBorg.isError && <Note error>{(saveBorg.error as Error).message}</Note>}
            {borgTest && (
              <Note error={!borgTest.ok}>
                {borgTest.ok ? "✓ " : "✗ "}
                {borgTest.message}
              </Note>
            )}

            {borg?.repo && (
              <OptionRow
                type="checkbox"
                checked={borg.enabled}
                disabled={!borg.available || saveBorg.isPending}
                busy={saveBorg.isPending}
                onChange={(checked) => saveBorg.mutate(checked)}
                title="Back up automatically"
                desc="Runs after imports and edits (debounced), and at least once a day, while the app is open."
              />
            )}

            {borg && (borg.running || borg.last_ok !== null) && (
              <Note error={borg.last_ok === false && !borg.running}>
                {borg.running
                  ? "Backup in progress…"
                  : borg.last_ok
                    ? `✓ Last backup ${
                        borg.last_finished_at
                          ? new Date(borg.last_finished_at).toLocaleString()
                          : "complete"
                      }`
                    : `✗ ${borg.last_message}`}
              </Note>
            )}
          </div>
        </div>

        <div className="settings-block">
          <Desc>
            Restoring a backup <strong>replaces everything currently in your library</strong> with
            the backup's contents. Files on external sources are not touched; their catalog entries
            are rebuilt on the next scan.
          </Desc>
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
              {restore.isPending ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Restoring...
                </>
              ) : (
                "Restore from backup"
              )}
            </button>
          </div>
          {restoreResult && <Note>{restoreResult}</Note>}
          {restore.isError && <Note error>{(restore.error as Error).message}</Note>}
        </div>
      </Section>

      <SettingsTour
        sections={tourSections}
        open={tourOpen}
        onClose={() => setTourOpen(false)}
        // The tour visits sections across all tabs, so it opens the one a stop
        // needs before looking for its element.
        onShowSection={(title) => setActiveTab(tabOfSection(title))}
      />
    </div>
  );
}

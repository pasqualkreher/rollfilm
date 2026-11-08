import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "../api/client";
import type { MetaField, MetadataSummary, PlaceHit, SuggestedPlace } from "../api/types";
import { useEscapeToClose, useEnterToConfirm } from "../utils/modalKeys";
import { formatShutterSpeed } from "../utils/photoMeta";
import { useAppDialogs } from "./AppDialogs";
import { pinIcon } from "./MiniMap";
import { Spinner } from "./Spinner";

// The metadata of one photo or a whole selection, edited by hand: capture
// time (set, or shifted for a camera clock that was off), place (by name, on
// the map or as coordinates), title, caption, author, copyright and the
// camera data. Only what was changed is sent - a field of a selection whose
// photos disagree shows "Mixed" and stays as each photo has it unless typed
// into. Stored in the library and the sidecar; the original file is never
// rewritten, exports carry the edit (backend services/metadata_edit.py).

type TextField = Exclude<MetaField, "taken_at" | "gps">;
type LatLon = { lat: number; lon: number };

const TEXT_ROWS: { key: TextField; label: string; placeholder?: string; area?: boolean }[] = [
  { key: "title", label: "Title" },
  { key: "description", label: "Caption", area: true },
  { key: "creator", label: "Author" },
  { key: "copyright", label: "Copyright", placeholder: "© 2026 Name" },
];

const CAMERA_ROWS: { key: TextField; label: string; placeholder?: string }[] = [
  { key: "camera_make", label: "Make", placeholder: "Leica" },
  { key: "camera_model", label: "Model", placeholder: "M6" },
  { key: "lens_model", label: "Lens", placeholder: "Summicron 35mm f/2" },
  { key: "iso", label: "ISO", placeholder: "400" },
  { key: "aperture", label: "Aperture", placeholder: "2.8" },
  { key: "shutter_speed", label: "Shutter", placeholder: "1/250" },
  { key: "focal_length", label: "Focal length", placeholder: "35" },
];

// What a stored value looks like in its field.
function shown(key: TextField, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (key === "shutter_speed") {
    const text = formatShutterSpeed(String(value));
    return text === "—" ? "" : text;
  }
  return String(value);
}

function parseCoords(text: string): LatLon | null {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

const fmtCoord = (p: LatLon) => `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;

// An interactive map: a click sets the pin, the pin can be dragged.
function PickMap({ value, onPick }: { value: LatLon | null; onPick: (p: LatLon) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    const el = ref.current;
    if (!el || map.current) return;
    const m = L.map(el, {
      center: value ? [value.lat, value.lon] : [25, 10],
      zoom: value ? 11 : 1,
      attributionControl: false,
      worldCopyJump: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => pick.current({ lat: e.latlng.lat, lon: e.latlng.wrap().lng }));
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      marker.current = null;
    };
    // Created once; the pin follows below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!value) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    if (!marker.current) {
      marker.current = L.marker([value.lat, value.lon], { icon: pinIcon, draggable: true }).addTo(m);
      marker.current.on("dragend", () => {
        const at = marker.current!.getLatLng().wrap();
        pick.current({ lat: at.lat, lon: at.lng });
      });
    } else {
      marker.current.setLatLng([value.lat, value.lon]);
    }
    if (!m.getBounds().contains([value.lat, value.lon])) m.setView([value.lat, value.lon], Math.max(m.getZoom(), 11));
  }, [value]);

  return <div ref={ref} className="meta-map" />;
}

// A row of the place list: a town from the offline list, or a place the
// library already has photos of (with a note saying so).
interface PlaceRow {
  key: string;
  label: string;
  lat: number;
  lon: number;
  note?: string;
}

const photosNote = (n: number) => `${n} photo${n === 1 ? "" : "s"}`;

// The place field: type a town, pick it from the list (arrows + Enter), or
// paste coordinates. Focused and empty, it offers the places of photos taken
// around the same time, then the places photographed most; typing narrows
// those and adds the towns that match.
function PlaceSearch({
  onPick,
  autoFocus,
  near = [],
  places = [],
}: {
  onPick: (p: LatLon, label: string) => void;
  autoFocus?: boolean;
  near?: SuggestedPlace[];
  places?: SuggestedPlace[];
}) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  // An arrow key moved through the list: Enter then takes the lit row even
  // with nothing typed (otherwise Enter saves the dialog).
  const [navigated, setNavigated] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 180);
    return () => window.clearTimeout(t);
  }, [text]);
  const coords = parseCoords(text);
  const { data: hits } = useQuery({
    queryKey: ["places", q],
    queryFn: () => api.images.places(q),
    enabled: q.length >= 2 && !coords,
    staleTime: Infinity,
  });
  const needle = text.trim().toLowerCase();
  const own: PlaceRow[] = [
    ...near.map((p) => ({ key: `near:${p.label}`, label: p.label, lat: p.lat, lon: p.lon, note: `Same time · ${photosNote(p.count)}` })),
    ...places
      .filter((p) => !near.some((n) => n.label === p.label))
      .map((p) => ({ key: `lib:${p.label}`, label: p.label, lat: p.lat, lon: p.lon, note: photosNote(p.count) })),
  ].filter((p) => !needle || p.label.toLowerCase().includes(needle));
  const towns: PlaceRow[] = (needle.length >= 2 ? hits ?? [] : [])
    .filter((h: PlaceHit) => !own.some((p) => p.label === h.label))
    .map((h: PlaceHit) => ({ key: `town:${h.label}:${h.lat}:${h.lon}`, label: h.label, lat: h.lat, lon: h.lon }));
  const list: PlaceRow[] = coords ? [] : [...own, ...towns].slice(0, 14);
  const showList = open && list.length > 0;

  function choose(row: PlaceRow) {
    onPick({ lat: row.lat, lon: row.lon }, row.label);
    setText("");
    setOpen(false);
    setNavigated(false);
  }

  return (
    <div className="meta-place-search">
      <input
        type="search"
        value={text}
        autoFocus={autoFocus}
        placeholder="Search a town, or paste coordinates"
        aria-label="Search a place"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setCursor(0);
          setNavigated(false);
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && showList) {
            e.preventDefault();
            setCursor((c) => (navigated ? Math.min(list.length - 1, c + 1) : 0));
            setNavigated(true);
          } else if (e.key === "ArrowUp" && showList) {
            e.preventDefault();
            setCursor((c) => Math.max(0, c - 1));
            setNavigated(true);
          } else if (e.key === "Enter") {
            if (coords) {
              e.preventDefault();
              onPick(coords, "");
              setText("");
            } else if (showList && (text.trim() || navigated)) {
              e.preventDefault();
              choose(list[Math.min(cursor, list.length - 1)]);
            } else if (text.trim()) {
              // Enter on a name with no match yet saves nothing by accident.
              e.preventDefault();
            }
          } else if (e.key === "Escape" && showList) {
            setOpen(false);
          }
        }}
      />
      {coords && <span className="meta-hint">Enter sets {fmtCoord(coords)}</span>}
      {showList && (
        // "dropdown-menu": Escape closes this list, not the dialog (modalKeys).
        <div className="meta-place-list dropdown-menu" role="listbox">
          {list.map((row, i) => (
            <button
              key={row.key}
              type="button"
              role="option"
              aria-selected={i === cursor}
              className={`meta-place-row${i === cursor ? " cursor" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(row)}
            >
              <span className="meta-place-label">{row.label}</span>
              {row.note && <span className="meta-place-note">{row.note}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type DateMode = "keep" | "set" | "shift";

// Where the photos' metadata is read and written: the library (the
// default), or the files of an import review (useMetadataDialog's caller
// passes importMetadataSource).
export interface MetadataSource {
  key: string;
  summary: (ids: string[]) => Promise<MetadataSummary>;
  edit: (ids: string[], fields: Partial<Record<MetaField, unknown>>, shiftSeconds?: number) => Promise<unknown>;
  // How many files could not be read (and kept their edit).
  revert: (ids: string[]) => Promise<number>;
  refresh: (queryClient: QueryClient) => void;
  // The line at the foot of the dialog.
  note: string;
}

const LIBRARY_SOURCE: MetadataSource = {
  key: "library",
  summary: (ids) => api.images.metadataSummary(ids),
  edit: (ids, fields, shift) => api.images.editMetadata(ids, fields, shift),
  revert: (ids) => api.images.revertMetadata(ids).then((r) => r.unreadable),
  refresh: (queryClient) => {
    for (const key of ["images", "image", "facets", "album", "smart-album-images", "library-stats", "metadata-summary"]) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  },
  note: "Kept in the library and the sidecar; exports carry it. The original file stays unchanged.",
};

export function MetadataDialog({
  ids,
  onClose,
  focus,
  source = LIBRARY_SOURCE,
  closing = false,
}: {
  ids: string[];
  onClose: () => void;
  // Open with the place search focused ("Add location…").
  focus?: "location";
  source?: MetadataSource;
  closing?: boolean;
}) {
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const many = ids.length > 1;
  const { data: summary, isLoading, error: loadError } = useQuery({
    queryKey: ["metadata-summary", source.key, ids.join(",")],
    queryFn: () => source.summary(ids),
    staleTime: 0,
    gcTime: 0,
  });

  // Earlier values and places from the library - for the import review too.
  // Asked once the photos' time range is known.
  const range = summary?.taken_range ?? null;
  const { data: suggest } = useQuery({
    queryKey: ["metadata-suggestions", range?.[0] ?? "", range?.[1] ?? "", source.key === "library" ? ids.join(",") : ""],
    queryFn: () =>
      api.images.metadataSuggestions(range?.[0], range?.[1], source.key === "library" ? ids : undefined),
    enabled: Boolean(summary),
    staleTime: 60_000,
  });

  // The typed values of the fields changed so far; a field not in here is
  // left as each photo has it.
  const [draft, setDraft] = useState<Partial<Record<TextField, string>>>({});
  const [dateMode, setDateMode] = useState<DateMode>(many ? "keep" : "set");
  const [dateText, setDateText] = useState<string | null>(null);
  const [shift, setShift] = useState({ sign: 1, days: "", hours: "", minutes: "" });
  // undefined = the place stays; null = taken off; a point = set there.
  const [gps, setGps] = useState<LatLon | null | undefined>(undefined);
  const [gpsLabel, setGpsLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const values = summary?.values ?? {};
  const mixed = useMemo(() => new Set(summary?.mixed ?? []), [summary]);
  const storedGps = (values.gps as LatLon | null | undefined) ?? null;
  const storedDate = (values.taken_at as string | null | undefined) ?? null;
  const shownGps = gps === undefined ? storedGps : gps;
  const placeText =
    gps === undefined
      ? mixed.has("gps")
        ? "Mixed"
        : storedGps
          ? summary?.place ?? fmtCoord(storedGps)
          : "No place"
      : gps === null
        ? "Will be removed"
        : gpsLabel || fmtCoord(gps);

  const shiftSeconds =
    shift.sign *
    ((Number(shift.days) || 0) * 86400 + (Number(shift.hours) || 0) * 3600 + (Number(shift.minutes) || 0) * 60);
  // The date field as typed, or the stored one (seconds kept).
  const dateValue = dateText ?? (storedDate ? storedDate.slice(0, 19) : "");
  const dateChanged = dateMode === "set" && dateText !== null && dateText !== "" && dateText !== storedDate?.slice(0, 19);
  // The typed fields that really differ from what the photos have (typed
  // back to the old value = not an edit).
  const typed = (Object.entries(draft) as [TextField, string][]).filter(
    ([key, text]) => mixed.has(key) || text.trim() !== shown(key, values[key]).trim()
  );
  const changed =
    typed.length > 0 || gps !== undefined || dateChanged || (dateMode === "shift" && shiftSeconds !== 0);

  useEscapeToClose(!closing, () => {
    if (!busy) onClose();
  });
  useEnterToConfirm(!closing, () => void save());

  function setField(key: TextField, text: string) {
    setDraft((d) => ({ ...d, [key]: text }));
  }

  function refresh() {
    source.refresh(queryClient);
  }

  async function save() {
    if (busy || !changed) return;
    const fields: Partial<Record<MetaField, unknown>> = Object.fromEntries(typed);
    if (gps !== undefined) fields.gps = gps;
    if (dateChanged) fields.taken_at = dateText;
    setBusy(true);
    setError(null);
    try {
      await source.edit(ids, fields, dateMode === "shift" ? shiftSeconds : undefined);
      refresh();
      onClose();
    } catch (e) {
      setError((e as Error).message || "Could not save the metadata.");
      setBusy(false);
    }
  }

  async function restore() {
    const ok = await dialogs.confirm({
      title: many ? `Restore ${ids.length} photos from their files?` : "Restore from file?",
      message: "Date, place, title, author, copyright and camera data go back to what the file says. The caption stays.",
      confirmLabel: "Restore",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const unreadable = await source.revert(ids);
      refresh();
      if (unreadable > 0) {
        setError(`${unreadable} file${unreadable === 1 ? "" : "s"} could not be read and kept the edit.`);
        setBusy(false);
      } else {
        onClose();
      }
    } catch (e) {
      setError((e as Error).message || "Could not restore from the file.");
      setBusy(false);
    }
  }

  function textInput(row: { key: TextField; label: string; placeholder?: string; area?: boolean }): ReactNode {
    const typed = draft[row.key];
    const stored = shown(row.key, values[row.key]);
    const isMixed = mixed.has(row.key);
    const value = typed ?? (isMixed ? "" : stored);
    // An emptied field clears the value on save - say so where it was.
    const placeholder =
      typed === "" && (isMixed || stored) ? "Will be cleared" : isMixed ? "Mixed" : row.placeholder ?? "";
    // Earlier values from the library, offered while typing (not the one
    // already in the field).
    const offered = (suggest?.values[row.key] ?? []).filter((v) => v !== value);
    const common = {
      id: `meta-${row.key}`,
      value,
      placeholder,
      disabled: !summary,
      className: isMixed && typed === undefined ? "is-mixed" : undefined,
      onChange: (e: { target: { value: string } }) => setField(row.key, e.target.value),
    };
    return (
      <div key={row.key} className="meta-row">
        <label htmlFor={`meta-${row.key}`}>{row.label}</label>
        {row.area ? (
          <textarea rows={2} {...common} />
        ) : (
          <input type="text" {...common} list={offered.length ? `meta-list-${row.key}` : undefined} />
        )}
        {offered.length > 0 && (
          <datalist id={`meta-list-${row.key}`}>
            {offered.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        )}
      </div>
    );
  }

  return (
    <div className={`modal-overlay${closing ? " pm-closing" : ""}`}>
      <form
        className="modal meta-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit metadata"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="meta-head">
          <h3>{many ? `Metadata of ${ids.length} photos` : "Metadata"}</h3>
        </div>
        <div className="meta-body">
          {isLoading && (
            <div className="meta-loading">
              <Spinner />
            </div>
          )}
          {loadError && <p className="status-note status-note--error">{(loadError as Error).message}</p>}

          <section className="meta-section">
            <div className="meta-section-label">Date and time</div>
            {many && (
              <span className="segmented meta-seg" role="group" aria-label="Date">
                {(["keep", "set", "shift"] as DateMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={dateMode === m}
                    className={dateMode === m ? "active" : ""}
                    onClick={() => setDateMode(m)}
                  >
                    {m === "keep" ? "Keep" : m === "set" ? "Set all to" : "Shift by"}
                  </button>
                ))}
              </span>
            )}
            {/* Both rows always there for a selection, the one not chosen
                greyed out: switching moves nothing. */}
            <div className="meta-row" style={dateMode === "set" ? undefined : { opacity: 0.45 }}>
              <label htmlFor="meta-taken">{many ? "Set to" : "Taken"}</label>
              <input
                id="meta-taken"
                type="datetime-local"
                step={1}
                value={dateValue}
                disabled={!summary || dateMode !== "set"}
                placeholder={mixed.has("taken_at") ? "Mixed" : ""}
                onChange={(e) => setDateText(e.target.value)}
              />
            </div>
            {many && (
              <div className="meta-row" style={dateMode === "shift" ? undefined : { opacity: 0.45 }}>
                <label>Shift by</label>
                <span className="meta-shift">
                  <select
                    aria-label="Earlier or later"
                    value={shift.sign}
                    disabled={dateMode !== "shift"}
                    onChange={(e) => setShift((s) => ({ ...s, sign: Number(e.target.value) }))}
                  >
                    <option value={1}>Later</option>
                    <option value={-1}>Earlier</option>
                  </select>
                  {(["days", "hours", "minutes"] as const).map((unit) => (
                    <label key={unit} className="meta-shift-unit">
                      <input
                        type="number"
                        min={0}
                        inputMode="numeric"
                        aria-label={unit}
                        value={shift[unit]}
                        disabled={dateMode !== "shift"}
                        placeholder="0"
                        onChange={(e) => setShift((s) => ({ ...s, [unit]: e.target.value }))}
                      />
                      {unit === "days" ? "d" : unit === "hours" ? "h" : "min"}
                    </label>
                  ))}
                </span>
              </div>
            )}
          </section>

          <section className="meta-section">
            <div className="meta-section-label meta-section-label--row">
              <span>Place</span>
              <span className="meta-place-now" title={shownGps ? fmtCoord(shownGps) : undefined}>
                {placeText}
              </span>
            </div>
            <PlaceSearch
              autoFocus={focus === "location"}
              near={suggest?.near}
              places={suggest?.places}
              onPick={(p, label) => {
                setGps(p);
                setGpsLabel(label || null);
                if (!label) void api.images.placeLabel(p.lat, p.lon).then((r) => setGpsLabel(r.label)).catch(() => {});
              }}
            />
            <PickMap
              value={shownGps}
              onPick={(p) => {
                setGps(p);
                setGpsLabel(null);
                void api.images
                  .placeLabel(p.lat, p.lon)
                  .then((r) => setGpsLabel(r.label))
                  .catch(() => {});
              }}
            />
            <div className="meta-place-actions">
              <span className="meta-hint">Click the map to set the place, drag the pin to move it.</span>
              <button
                type="button"
                className="btn btn-sm ghost"
                disabled={!summary || (gps === undefined ? !storedGps && !mixed.has("gps") : gps === null)}
                onClick={() => {
                  setGps(null);
                  setGpsLabel(null);
                }}
              >
                Remove place
              </button>
            </div>
          </section>

          <section className="meta-section">
            <div className="meta-section-label">Description</div>
            {TEXT_ROWS.map(textInput)}
          </section>

          <section className="meta-section">
            <div className="meta-section-label">Camera</div>
            {CAMERA_ROWS.map(textInput)}
          </section>
        </div>
        <div className="meta-foot">
          <p className="meta-hint meta-foot-note">
            {source.note}
          </p>
          {error && <p className="status-note status-note--error meta-error">{error}</p>}
          <div className="meta-actions">
            <button
              type="button"
              className="btn ghost"
              disabled={busy || !summary?.edited}
              onClick={() => void restore()}
              title="Undo the hand edits: back to what the file says"
            >
              Restore from file
            </button>
            <span className="meta-actions-gap" />
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={busy || !changed}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

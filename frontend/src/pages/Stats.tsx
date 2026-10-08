import { useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { LibraryStats, StatCount, StatsFilters } from "../api/types";
import {
  IconAperture,
  IconCamera,
  IconDisk,
  IconImage,
  IconPencil,
  IconPin,
  IconStar,
  IconX,
} from "../components/Icons";
import { LoadingState } from "../components/Spinner";
import { useScrollMemory } from "../utils/scrollMemory";

// Statistics dashboard (top-bar chart icon): what's in the library and what
// it was shot with. Every chart is a single accent-colored series with its
// values written out, so it reads correctly in every skin and never relies on
// color alone; exact numbers repeat in each row/column tooltip.
//
// Cross-filtered: every bar and column is a button that pins its value. The
// pinned set lives in the URL (?camera=X-T5&year=2024), the tiles honour all
// of it, and each chart is computed with its own dimension lifted, so the
// chart you clicked keeps offering its alternatives while every other chart
// narrows to the selection. The server owns the bucket definitions; this page
// only knows each row's `key`.

type Dim = keyof StatsFilters;

const DIMS: Dim[] = [
  "camera",
  "lens",
  "focal",
  "year",
  "month",
  "rating",
  "file_type",
  "iso",
  "aperture",
  "shutter",
  "country",
];

const DIM_LABEL: Record<Dim, string> = {
  camera: "Camera",
  lens: "Lens",
  focal: "Focal length",
  year: "Year",
  month: "Month",
  rating: "Rating",
  file_type: "File type",
  iso: "ISO",
  aperture: "Aperture",
  shutter: "Shutter",
  country: "Country",
};

// The grid's filter bar knows these; the rest (ISO, aperture, shutter, month)
// are statistics-only and are left out of "Show in library".
const LIBRARY_DIMS: Dim[] = ["camera", "lens", "focal", "year", "rating", "file_type", "country"];

const LIST_OF: Record<Dim, (s: LibraryStats) => StatCount[]> = {
  camera: (s) => s.cameras,
  lens: (s) => s.lenses,
  focal: (s) => s.focal_buckets,
  year: (s) => s.years,
  month: (s) => s.months,
  rating: (s) => s.ratings,
  file_type: (s) => s.file_types,
  iso: (s) => s.isos,
  aperture: (s) => s.apertures,
  shutter: (s) => s.shutters,
  country: (s) => s.countries,
};

// Fixed axis for the month chart: every month has its column, zero or not,
// so the shape of a year is always the same shape.
const MONTH_AXIS: StatCount[] = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
].map((name, i) => ({ key: String(i + 1).padStart(2, "0"), name, count: 0 }));

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function pct(part: number, total: number, of: string): string {
  if (total <= 0) return "";
  return `${Math.round((part / total) * 100)}% of ${of}`;
}

// Short number for the chart's axis ticks: 12.4k rather than 12,400, so the
// scale stays a thin column beside the columns.
function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function stars(key: string): string {
  return "★".repeat(Number(key) || 0) || key;
}

// What a pinned value is called in its chip: the row's own label where the
// chart has one, stars for ratings.
function nameFor(s: LibraryStats, dim: Dim, key: string): string {
  if (dim === "rating") return stars(key);
  if (dim === "month") return MONTH_AXIS.find((m) => m.key === key)?.name ?? key;
  return LIST_OF[dim](s).find((r) => r.key === key)?.name ?? key;
}

// Lay the chart's rows over a fixed axis, so missing months show as 0.
function onAxis(axis: StatCount[], rows: StatCount[]): StatCount[] {
  const byKey = new Map(rows.map((r) => [r.key, r.count]));
  return axis.map((a) => ({ ...a, count: byKey.get(a.key) ?? 0 }));
}

// The grid's URL for the pinned set (see pages/Library.tsx for the names), or
// null when nothing pinned is a library filter.
function libraryParams(s: LibraryStats, filters: StatsFilters): URLSearchParams | null {
  const p = new URLSearchParams();
  if (filters.camera) p.set("camera", filters.camera);
  if (filters.lens) p.set("lens", filters.lens);
  if (filters.country) p.set("country", filters.country);
  if (filters.rating) p.set("rating", filters.rating);
  if (filters.file_type === "jpeg") p.set("view", "jpeg_only");
  if (filters.file_type === "raw") p.set("view", "raw_only");
  if (filters.year && /^\d{4}$/.test(filters.year)) {
    p.set("from", `${filters.year}-01-01`);
    p.set("to", `${filters.year}-12-31`);
  }
  if (filters.focal) {
    const b = s.focal_buckets.find((r) => r.key === filters.focal);
    // The grid widens its bounds by 0.05mm, so a half-open bucket [16, 24)
    // becomes 16 .. 23.9.
    if (b?.lo != null && b.lo > 0) p.set("focal_min", String(Math.round(b.lo * 10) / 10));
    if (b?.hi != null) p.set("focal_max", String(Math.round((b.hi - 0.1) * 10) / 10));
  }
  return [...p.keys()].length ? p : null;
}

// A headline number. The icon names the tile at a glance; `ratio` turns the
// "% of ..." line into a meter you can compare across tiles without reading
// the numbers.
function Tile({
  icon,
  value,
  label,
  sub,
  ratio,
}: {
  icon: ReactNode;
  value: string;
  label: string;
  sub?: string;
  ratio?: number;
}) {
  return (
    <div className="stat-tile">
      <span className="stat-tile-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="stat-tile-value">{value}</span>
      <span className="stat-tile-label">{label}</span>
      {ratio != null && (
        <span className="stat-tile-meter" aria-hidden="true">
          <span
            className="stat-tile-meter-fill"
            style={{ width: `${Math.min(100, Math.max(2, Math.round(ratio * 100)))}%` }}
          />
        </span>
      )}
      {sub && <span className="stat-tile-sub">{sub}</span>}
    </div>
  );
}

// A card emptied by the current filters keeps its place (and roughly its
// size) instead of vanishing, so pinning a value never reshuffles the page.
function EmptyCard({ title, desc, wide }: { title: string; desc?: string; wide?: boolean }) {
  return (
    <section className={`stats-card${wide ? " stats-card--wide" : ""}`}>
      <h3 className="stats-card-title">{title}</h3>
      {desc && <p className="stats-card-desc">{desc}</p>}
      <div className="stats-card-empty">No photos match the current filters.</div>
    </section>
  );
}

type BarRow = StatCount & { fixed?: boolean };

// Horizontal bar list: label | bar | count. Bars scale to the list's own
// maximum (relative magnitude within the card); `ranked` lists (most-used
// first) also fade down the ranking so the leaders read first. With a value
// pinned, that row holds full strength and the rest step back.
function BarCard({
  title,
  rows,
  desc,
  ranked,
  selected,
  onSelect,
}: {
  title: string;
  rows: BarRow[];
  desc?: string;
  ranked?: boolean;
  selected?: string;
  onSelect?: (key: string) => void;
}) {
  const max = Math.max(0, ...rows.map((r) => r.count));
  const sum = rows.reduce((a, r) => a + r.count, 0);
  if (rows.length === 0 || max === 0) return <EmptyCard title={title} desc={desc} />;
  const hasSelection = selected != null && rows.some((r) => r.key === selected);
  return (
    <section className="stats-card">
      <h3 className="stats-card-title">{title}</h3>
      {desc && <p className="stats-card-desc">{desc}</p>}
      <div className={`stats-bars${hasSelection ? " has-selection" : ""}`}>
        {rows.map((r, i) => {
          const share = sum > 0 ? Math.round((r.count / sum) * 100) : 0;
          const isSelected = hasSelection && r.key === selected;
          const clickable = !!onSelect && !r.fixed;
          const opacity = hasSelection
            ? isSelected
              ? 1
              : 0.35
            : ranked
              ? Math.max(0.5, 1 - i * 0.11)
              : 0.9;
          const tip =
            `${r.name}: ${r.count.toLocaleString()} photo(s) · ${share}% of this list` +
            (clickable ? (isSelected ? " · click to clear" : " · click to filter") : "");
          const inner = (
            <>
              <span className="stats-bar-label">{r.name}</span>
              <span className="stats-bar-track">
                <span
                  className="stats-bar-fill"
                  style={{ width: `${(r.count / max) * 100}%`, opacity }}
                />
              </span>
              <span className="stats-bar-count">
                {r.count.toLocaleString()}
                <span className="stats-bar-share">{share}%</span>
              </span>
            </>
          );
          const cls = `stats-bar-row${isSelected ? " is-selected" : ""}`;
          return clickable ? (
            <button
              key={r.key}
              type="button"
              className={`${cls} is-clickable`}
              aria-pressed={isSelected}
              title={tip}
              onClick={() => onSelect!(r.key)}
            >
              {inner}
            </button>
          ) : (
            <div key={r.key} className={cls} title={tip}>
              {inner}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Column chart over an ordered axis (years, months), on a scale with
// gridlines so the column heights can be read off and not just compared.
// Counts are written above each column while they fit; tooltips always carry
// the exact number.
function ColumnCard({
  title,
  noun,
  rows,
  selected,
  onSelect,
}: {
  title: string;
  noun: string;
  rows: StatCount[];
  selected?: string;
  onSelect: (key: string) => void;
}) {
  const max = Math.max(0, ...rows.map((r) => r.count));
  if (rows.length === 0 || max === 0) return <EmptyCard title={title} wide />;
  const showCounts = rows.length <= 12;
  const total = rows.reduce((a, r) => a + r.count, 0);
  const peak = rows.reduce((a, r) => (r.count > a.count ? r : a), rows[0]);
  const hasSelection = selected != null && rows.some((r) => r.key === selected);
  return (
    <section className="stats-card stats-card--wide">
      <div className="stats-card-head">
        <h3 className="stats-card-title">{title}</h3>
        <p className="stats-card-note">
          Busiest {noun} <strong>{peak.name}</strong> with {peak.count.toLocaleString()} photos
        </p>
      </div>
      <div className="stats-chart">
        {/* The scale: three ticks (max, half, zero) against the plot's own
            height. Its bottom margin matches the label row so the ticks line
            up with the gridlines beside them. */}
        <div className="stats-chart-scale" aria-hidden="true">
          <span>{compact(max)}</span>
          <span>{compact(Math.round(max / 2))}</span>
          <span>0</span>
        </div>
        <div className="stats-chart-body">
          <div className="stats-chart-lines" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div
            className={`stats-cols${hasSelection ? " has-selection" : ""}`}
            role="group"
            aria-label={`${title}, ${total.toLocaleString()} in total`}
          >
            {rows.map((r) => {
              const isSelected = hasSelection && r.key === selected;
              const empty = r.count === 0;
              return (
                <button
                  key={r.key}
                  type="button"
                  className={`stats-col${r.key === peak.key ? " is-peak" : ""}${isSelected ? " is-selected" : ""}`}
                  aria-pressed={isSelected}
                  disabled={empty && !isSelected}
                  title={
                    `${r.name}: ${r.count.toLocaleString()} photo(s)` +
                    (empty && !isSelected ? "" : isSelected ? " · click to clear" : " · click to filter")
                  }
                  onClick={() => onSelect(r.key)}
                >
                  <span className="stats-col-bararea">
                    {showCounts && !empty && (
                      <span className="stats-col-count">{r.count.toLocaleString()}</span>
                    )}
                    <span
                      className="stats-col-bar"
                      style={{ height: empty ? "0%" : `${Math.max(2, (r.count / max) * 100)}%` }}
                    />
                  </span>
                  <span className="stats-col-label">{r.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

export function Stats() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const filters: StatsFilters = {};
  for (const dim of DIMS) {
    const v = searchParams.get(dim);
    if (v) filters[dim] = v;
  }
  const active = DIMS.filter((d) => filters[d]);

  // The previous snapshot stays on screen while the pinned set is refetched:
  // bars slide to their new lengths instead of the page blinking to a spinner.
  // The bars grow in once, when their numbers first arrive. On a revisit the
  // numbers are already in the cache and the bars stand where they were -
  // replaying the growth on every visit made the page feel like it was
  // reloading. Decided once at mount (state, not a flag read on each render):
  // the on-mount refetch resolves within the animation's length, and dropping
  // the class then would cut the growth short.
  const queryClient = useQueryClient();
  const [grow] = useState(
    () => queryClient.getQueryData(["library-stats", filters]) === undefined
  );
  const { data: s, isLoading, error, isFetching } = useQuery({
    queryKey: ["library-stats", filters],
    queryFn: () => api.stats.library(filters),
    placeholderData: (prev) => prev,
  });
  // Same place in the cards as when the user left - once there are cards.
  const pageRef = useRef<HTMLDivElement>(null);
  useScrollMemory(pageRef, "stats", { ready: !!s });

  // Replace, not push: refining the pinned set is not a new place to go back
  // to (same convention as the library's filters).
  function toggle(dim: Dim, key: string) {
    const next = new URLSearchParams(searchParams);
    if (next.get(dim) === key) next.delete(dim);
    else next.set(dim, key);
    setSearchParams(next, { replace: true });
  }
  function clearAll() {
    const next = new URLSearchParams(searchParams);
    DIMS.forEach((d) => next.delete(d));
    setSearchParams(next, { replace: true });
  }
  const pick = (dim: Dim) => (key: string) => toggle(dim, key);

  if (isLoading || (!s && !error)) {
    return (
      <div className="page stats-page">
        <h2 className="section-title">Statistics</h2>
        <LoadingState label="Crunching your library…" />
      </div>
    );
  }
  if (error || !s) {
    return (
      <div className="page stats-page">
        <h2 className="section-title">Statistics</h2>
        <div className="empty-state">The statistics could not be loaded. Try again in a moment.</div>
      </div>
    );
  }
  if (s.library_total_photos === 0) {
    return (
      <div className="page stats-page">
        <h2 className="section-title">Statistics</h2>
        <div className="empty-state">
          Nothing to count yet — import some photos and this page fills up with your cameras,
          lenses and favorite focal lengths.
        </div>
      </div>
    );
  }

  const has = (dim: Dim) => s.available.includes(dim);
  const total = s.total_photos;
  const filtered = active.length > 0;

  const firstYear = s.first_taken_at ? new Date(s.first_taken_at).getFullYear() : null;
  const lastYear = s.last_taken_at ? new Date(s.last_taken_at).getFullYear() : null;
  const span =
    firstYear != null && lastYear != null
      ? firstYear === lastYear
        ? `all from ${firstYear}`
        : `${firstYear} – ${lastYear}`
      : undefined;
  const cameras = `${s.camera_count.toLocaleString()} ${s.camera_count === 1 ? "camera" : "cameras"}`;
  const subtitle =
    total === 0
      ? `No photos match these filters (${s.library_total_photos.toLocaleString()} in the library).`
      : filtered
        ? `${total.toLocaleString()} of ${s.library_total_photos.toLocaleString()} photos match${span ? `, ${span}` : ""}, taken with ${cameras}.`
        : `${total.toLocaleString()} photos${span ? `, ${span}` : ""}, taken with ${cameras}.`;
  const of = filtered ? "the selection" : "the library";

  const makeup: BarRow[] = [
    ...s.file_types,
    // Pairs are a property of the selection, not a type to pin.
    { key: "pairs", name: "RAW+JPG pairs", count: s.pair_count, fixed: true },
  ].filter((r) => r.count > 0);
  const ratings = s.ratings.map((r) => ({ ...r, name: stars(r.key) }));

  const libraryLink = libraryParams(s, filters);
  const leftOut = active.filter((d) => !LIBRARY_DIMS.includes(d)).map((d) => DIM_LABEL[d]);
  const libraryTip = libraryLink
    ? "Open the library with these filters" +
      (filters.rating ? ` (rating opens as ${filters.rating} stars and up)` : "") +
      (leftOut.length ? `. ${leftOut.join(", ")} ${leftOut.length === 1 ? "is" : "are"} not a library filter and stays here.` : ".")
    : filtered
      ? `${leftOut.join(", ")} ${leftOut.length === 1 ? "is" : "are"} not a library filter.`
      : "Pin a value first";

  return (
    <div className={`page stats-page${grow ? " stats-grow" : ""}`} ref={pageRef}>
      {/* Title, summary and the filter chips stay in view while the cards
          scroll under them: what the page is filtered by is always visible. */}
      <div className="stats-head">
      <h2 className="section-title">Statistics</h2>
      <p className="stats-page-sub">{subtitle}</p>

      <div className={`stats-filterbar${filtered ? "" : " is-idle"}`}>
        {filtered ? (
          <div className="stats-filterbar-chips">
            {active.map((dim) => (
              <span key={dim} className="tag-chip stats-chip">
                <span className="stats-chip-dim">{DIM_LABEL[dim]} ·</span> {nameFor(s, dim, filters[dim]!)}
                <button
                  type="button"
                  aria-label={`Remove ${DIM_LABEL[dim]} filter`}
                  title={`Remove ${DIM_LABEL[dim]} filter`}
                  onClick={() => toggle(dim, filters[dim]!)}
                >
                  <IconX size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <span className="stats-filterbar-hint">
            Click any bar or column to filter the whole page by it; combine as many as you like.
          </span>
        )}
        <div className="stats-filterbar-actions" aria-hidden={!filtered}>
          <button type="button" className="btn btn-sm ghost" onClick={clearAll} disabled={!filtered}>
            Clear
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!libraryLink}
            title={libraryTip}
            onClick={() => libraryLink && navigate(`/?${libraryLink}`)}
          >
            Show in library
          </button>
        </div>
      </div>
      </div>

      <div className={`stats-content${isFetching ? " is-refetching" : ""}`}>
        <div className="stats-tiles">
          <Tile
            icon={<IconImage size={15} />}
            value={total.toLocaleString()}
            label="Photos"
            sub={filtered ? pct(total, s.library_total_photos, "the library") : span}
            ratio={filtered ? total / Math.max(1, s.library_total_photos) : undefined}
          />
          <Tile icon={<IconDisk size={15} />} value={formatBytes(s.total_bytes)} label="Library size" />
          <Tile
            icon={<IconCamera size={15} />}
            value={s.camera_count.toLocaleString()}
            label={s.camera_count === 1 ? "Camera" : "Cameras"}
          />
          <Tile
            icon={<IconAperture size={15} />}
            value={s.lens_count.toLocaleString()}
            label={s.lens_count === 1 ? "Lens" : "Lenses"}
          />
          <Tile
            icon={<IconPencil size={15} />}
            value={s.edited_count.toLocaleString()}
            label="Edited"
            sub={pct(s.edited_count, total, of)}
            ratio={total ? s.edited_count / total : 0}
          />
          <Tile
            icon={<IconStar size={15} />}
            value={s.rated_count.toLocaleString()}
            label="Rated"
            sub={pct(s.rated_count, total, of)}
            ratio={total ? s.rated_count / total : 0}
          />
          <Tile
            icon={<IconPin size={15} />}
            value={s.with_gps_count.toLocaleString()}
            label="With location"
            sub={pct(s.with_gps_count, total, of)}
            ratio={total ? s.with_gps_count / total : 0}
          />
        </div>

        {(has("year") || has("month")) && (
          <>
            <h3 className="stats-section-label">Timeline</h3>
            {has("year") && (
              <ColumnCard
                title="Photos per year"
                noun="year"
                rows={s.years}
                selected={filters.year}
                onSelect={pick("year")}
              />
            )}
            {has("month") && (
              <ColumnCard
                title="Photos per month"
                noun="month"
                rows={onAxis(MONTH_AXIS, s.months)}
                selected={filters.month}
                onSelect={pick("month")}
              />
            )}
          </>
        )}

        {(has("camera") || has("lens") || has("focal")) && (
          <>
            <h3 className="stats-section-label">Gear</h3>
            <div className="stats-cards">
              {has("camera") && (
                <BarCard
                  title="Cameras"
                  rows={s.cameras}
                  desc="Your most used camera bodies."
                  ranked
                  selected={filters.camera}
                  onSelect={pick("camera")}
                />
              )}
              {has("lens") && (
                <BarCard
                  title="Lenses"
                  rows={s.lenses}
                  desc="Your most used lenses."
                  ranked
                  selected={filters.lens}
                  onSelect={pick("lens")}
                />
              )}
              {has("focal") && (
                <BarCard
                  title="Focal lengths"
                  rows={s.focal_buckets}
                  desc="Which focal length ranges you use most, as recorded by the camera."
                  selected={filters.focal}
                  onSelect={pick("focal")}
                />
              )}
            </div>
          </>
        )}

        {(has("iso") || has("aperture") || has("shutter")) && (
          <>
            <h3 className="stats-section-label">Exposure</h3>
            <div className="stats-cards">
              {has("iso") && (
                <BarCard
                  title="ISO"
                  rows={s.isos}
                  desc="Sensitivity, rounded to full stops."
                  selected={filters.iso}
                  onSelect={pick("iso")}
                />
              )}
              {has("aperture") && (
                <BarCard
                  title="Aperture"
                  rows={s.apertures}
                  desc="F-numbers, rounded to full stops."
                  selected={filters.aperture}
                  onSelect={pick("aperture")}
                />
              )}
              {has("shutter") && (
                <BarCard
                  title="Shutter speed"
                  rows={s.shutters}
                  desc="Exposure times, from frozen motion to long exposures."
                  selected={filters.shutter}
                  onSelect={pick("shutter")}
                />
              )}
            </div>
          </>
        )}

        <h3 className="stats-section-label">Library</h3>
        <div className="stats-cards">
          {has("rating") && (
            <BarCard
              title="Ratings"
              rows={ratings}
              desc="How your rated photos are distributed."
              selected={filters.rating}
              onSelect={pick("rating")}
            />
          )}
          <BarCard
            title="Library makeup"
            rows={makeup}
            desc="The file types in your library."
            selected={filters.file_type}
            onSelect={pick("file_type")}
          />
          {has("country") && (
            <BarCard
              title="Countries"
              rows={s.countries}
              desc="Where your geotagged photos were taken."
              ranked
              selected={filters.country}
              onSelect={pick("country")}
            />
          )}
        </div>
      </div>
    </div>
  );
}

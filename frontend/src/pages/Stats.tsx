import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { StatCount } from "../api/types";
import {
  IconAperture,
  IconCamera,
  IconDisk,
  IconImage,
  IconPencil,
  IconPin,
  IconStar,
} from "../components/Icons";

// Statistics dashboard (top-bar chart icon): what's in the library and what
// it was shot with. Every chart is a single accent-colored series with its
// values written out, so it reads correctly in every skin and never relies on
// color alone; exact numbers repeat in each row/column tooltip.

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function pct(part: number, total: number): string {
  if (total <= 0) return "";
  return `${Math.round((part / total) * 100)}% of the library`;
}

// Short number for the chart's axis ticks: 12.4k rather than 12,400, so the
// scale stays a thin column beside the columns.
function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

// A headline number. The icon names the tile at a glance; `ratio` turns the
// "% of the library" line into a meter you can compare across tiles without
// reading the numbers.
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

// Horizontal bar list: label | bar | count. Bars scale to the list's own
// maximum (relative magnitude within the card) and fade down the ranking, so
// the leaders read first; the share of the list is written next to each count.
function BarCard({ title, rows, desc }: { title: string; rows: StatCount[]; desc?: string }) {
  const max = Math.max(0, ...rows.map((r) => r.count));
  const sum = rows.reduce((a, r) => a + r.count, 0);
  if (rows.length === 0 || max === 0) return null;
  return (
    <section className="stats-card">
      <h3 className="stats-card-title">{title}</h3>
      {desc && <p className="stats-card-desc">{desc}</p>}
      <div className="stats-bars">
        {rows.map((r, i) => {
          const share = sum > 0 ? Math.round((r.count / sum) * 100) : 0;
          return (
            <div
              key={r.name}
              className="stats-bar-row"
              title={`${r.name}: ${r.count.toLocaleString()} photo(s) · ${share}% of this list`}
            >
              <span className="stats-bar-label">{r.name}</span>
              <span className="stats-bar-track">
                <span
                  className="stats-bar-fill"
                  /* The ranking's own fade: full accent at the top, a step
                     quieter per place, floored so the tail stays legible. */
                  style={{
                    width: `${(r.count / max) * 100}%`,
                    opacity: Math.max(0.5, 1 - i * 0.11),
                  }}
                />
              </span>
              <span className="stats-bar-count">
                {r.count.toLocaleString()}
                <span className="stats-bar-share">{share}%</span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Column chart for photos per capture year, on a scale with gridlines so the
// column heights can be read off and not just compared. Counts are written
// above each column while they fit; tooltips always carry the exact number.
function YearCard({ rows }: { rows: StatCount[] }) {
  const max = Math.max(0, ...rows.map((r) => r.count));
  if (rows.length === 0 || max === 0) return null;
  const showCounts = rows.length <= 12;
  const total = rows.reduce((a, r) => a + r.count, 0);
  const peak = rows.reduce((a, r) => (r.count > a.count ? r : a), rows[0]);
  return (
    <section className="stats-card stats-card--wide">
      <div className="stats-card-head">
        <h3 className="stats-card-title">Photos per year</h3>
        <p className="stats-card-note">
          Busiest year <strong>{peak.name}</strong> with {peak.count.toLocaleString()} photos
        </p>
      </div>
      <div className="stats-chart">
        {/* The scale: three ticks (max, half, zero) against the plot's own
            height. Its bottom margin matches the year-label row so the ticks
            line up with the gridlines beside them. */}
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
            className="stats-cols"
            role="img"
            aria-label={`Photos per capture year, ${total.toLocaleString()} in total`}
          >
            {rows.map((r) => (
              <div
                key={r.name}
                className={`stats-col${r.name === peak.name ? " is-peak" : ""}`}
                title={`${r.name}: ${r.count.toLocaleString()} photo(s)`}
              >
                <span className="stats-col-bararea">
                  {showCounts && <span className="stats-col-count">{r.count.toLocaleString()}</span>}
                  <span
                    className="stats-col-bar"
                    style={{ height: `${Math.max(2, (r.count / max) * 100)}%` }}
                  />
                </span>
                <span className="stats-col-label">{r.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function Stats() {
  const { data: s, isLoading, error } = useQuery({
    queryKey: ["library-stats"],
    queryFn: () => api.stats.library(),
  });

  if (isLoading) {
    return (
      <div className="page stats-page">
        <h2 className="section-title">Statistics</h2>
        <div className="empty-state">
          <span className="spinner" aria-hidden="true" /> Crunching your library…
        </div>
      </div>
    );
  }
  if (error || !s) {
    return (
      <div className="page stats-page">
        <h2 className="section-title">Statistics</h2>
        <div className="empty-state">Couldn't load the statistics. Try again in a moment.</div>
      </div>
    );
  }
  if (s.total_photos === 0) {
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

  const firstYear = s.first_taken_at ? new Date(s.first_taken_at).getFullYear() : null;
  const lastYear = s.last_taken_at ? new Date(s.last_taken_at).getFullYear() : null;
  const span =
    firstYear != null && lastYear != null
      ? firstYear === lastYear
        ? `all from ${firstYear}`
        : `${firstYear} – ${lastYear}`
      : undefined;

  const makeup: StatCount[] = [
    { name: "JPEG files", count: s.jpeg_count },
    { name: "RAW files", count: s.raw_count },
    { name: "RAW+JPG pairs", count: s.pair_count },
  ].filter((r) => r.count > 0);

  const ratings = s.ratings.map((r) => ({
    name: "★".repeat(Number(r.name) || 0) || r.name,
    count: r.count,
  }));

  return (
    <div className="page stats-page">
      <h2 className="section-title">Statistics</h2>
      <p className="stats-page-sub">
        {s.total_photos.toLocaleString()} photos{span ? `, ${span}` : ""} — shot on{" "}
        {s.camera_count.toLocaleString()} {s.camera_count === 1 ? "camera" : "cameras"}.
      </p>

      <div className="stats-tiles">
        <Tile icon={<IconImage size={15} />} value={s.total_photos.toLocaleString()} label="Photos" sub={span} />
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
          sub={pct(s.edited_count, s.total_photos)}
          ratio={s.edited_count / s.total_photos}
        />
        <Tile
          icon={<IconStar size={15} />}
          value={s.rated_count.toLocaleString()}
          label="Rated"
          sub={pct(s.rated_count, s.total_photos)}
          ratio={s.rated_count / s.total_photos}
        />
        <Tile
          icon={<IconPin size={15} />}
          value={s.with_gps_count.toLocaleString()}
          label="With location"
          sub={pct(s.with_gps_count, s.total_photos)}
          ratio={s.with_gps_count / s.total_photos}
        />
      </div>

      <h3 className="stats-section-label">Timeline</h3>
      <YearCard rows={s.years} />

      <h3 className="stats-section-label">Gear &amp; library</h3>
      <div className="stats-cards">
        <BarCard title="Cameras" rows={s.cameras} desc="Your most used camera bodies." />
        <BarCard title="Lenses" rows={s.lenses} desc="Your most used lenses." />
        <BarCard
          title="Focal lengths"
          rows={s.focal_buckets}
          desc="Which ranges you actually shoot (real focal length, as written by the camera)."
        />
        <BarCard title="Ratings" rows={ratings} desc="How your rated photos are distributed." />
        <BarCard title="Library makeup" rows={makeup} desc="What kind of files your photos are." />
      </div>
    </div>
  );
}

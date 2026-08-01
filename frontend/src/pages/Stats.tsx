import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { StatCount } from "../api/types";

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

function Tile({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="stat-tile">
      <span className="stat-tile-value">{value}</span>
      <span className="stat-tile-label">{label}</span>
      {sub && <span className="stat-tile-sub">{sub}</span>}
    </div>
  );
}

// Horizontal bar list: label | bar | count. Bars scale to the list's own
// maximum (relative magnitude within the card).
function BarCard({ title, rows, desc }: { title: string; rows: StatCount[]; desc?: string }) {
  const max = Math.max(0, ...rows.map((r) => r.count));
  if (rows.length === 0 || max === 0) return null;
  return (
    <section className="stats-card">
      <h3 className="stats-card-title">{title}</h3>
      {desc && <p className="stats-card-desc">{desc}</p>}
      <div className="stats-bars">
        {rows.map((r) => (
          <div
            key={r.name}
            className="stats-bar-row"
            title={`${r.name}: ${r.count.toLocaleString()} photo(s)`}
          >
            <span className="stats-bar-label">{r.name}</span>
            <span className="stats-bar-track">
              <span className="stats-bar-fill" style={{ width: `${(r.count / max) * 100}%` }} />
            </span>
            <span className="stats-bar-count">{r.count.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// Column chart for photos per capture year. Counts are written above each
// column while they fit; tooltips always carry the exact number.
function YearCard({ rows }: { rows: StatCount[] }) {
  const max = Math.max(0, ...rows.map((r) => r.count));
  if (rows.length === 0 || max === 0) return null;
  const showCounts = rows.length <= 12;
  return (
    <section className="stats-card stats-card--wide">
      <h3 className="stats-card-title">Photos per year</h3>
      <div className="stats-cols" role="img" aria-label="Photos per capture year">
        {rows.map((r) => (
          <div
            key={r.name}
            className="stats-col"
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

      <div className="stats-tiles">
        <Tile value={s.total_photos.toLocaleString()} label="Photos" sub={span} />
        <Tile value={formatBytes(s.total_bytes)} label="Library size" />
        <Tile value={s.camera_count.toLocaleString()} label={s.camera_count === 1 ? "Camera" : "Cameras"} />
        <Tile value={s.lens_count.toLocaleString()} label={s.lens_count === 1 ? "Lens" : "Lenses"} />
        <Tile
          value={s.edited_count.toLocaleString()}
          label="Edited"
          sub={pct(s.edited_count, s.total_photos)}
        />
        <Tile
          value={s.rated_count.toLocaleString()}
          label="Rated"
          sub={pct(s.rated_count, s.total_photos)}
        />
        <Tile
          value={s.with_gps_count.toLocaleString()}
          label="With location"
          sub={pct(s.with_gps_count, s.total_photos)}
        />
      </div>

      <YearCard rows={s.years} />

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

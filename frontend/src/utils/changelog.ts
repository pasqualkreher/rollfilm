// CHANGELOG.md, read at build time and taken apart for the "What's new"
// sheet (components/WhatsNew.tsx). The same file makes the GitHub release
// pages (scripts/release-notes.js), so the app and the page say the same.
import raw from "../../../CHANGELOG.md?raw";

export interface ChangelogGroup {
  title: string;
  points: string[];
}

export interface ChangelogEntry {
  version: string;
  date: string | null;
  groups: ChangelogGroup[];
}

// "## 0.1.96 — 2026-10-14", then "### New" and "- point" lines. Anything else
// (the intro, comments) is left out.
function parse(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let group: ChangelogGroup | null = null;
  for (const line of text.split("\n")) {
    const version = /^##\s+(\d+\.\d+\.\d+)\s*(?:[—–-]\s*(.+))?$/.exec(line.trim());
    if (version) {
      entries.push({ version: version[1], date: version[2]?.trim() || null, groups: [] });
      group = null;
      continue;
    }
    const entry = entries[entries.length - 1];
    if (!entry) continue;
    const heading = /^###\s+(.+)$/.exec(line.trim());
    if (heading) {
      group = { title: heading[1], points: [] };
      entry.groups.push(group);
      continue;
    }
    const point = /^[-*]\s+(.+)$/.exec(line.trim());
    if (point) {
      if (!group) {
        group = { title: "", points: [] };
        entry.groups.push(group);
      }
      group.points.push(point[1]);
    }
  }
  return entries.filter((e) => e.groups.some((g) => g.points.length > 0));
}

export const CHANGELOG: ChangelogEntry[] = parse(raw);

// "0.1.13" vs "0.1.12", numeric per part; > 0 when a is newer.
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map((n) => parseInt(n, 10) || 0);
  const y = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// The versions after `seen` up to and including `current`, newest first.
export function changesSince(seen: string, current: string): ChangelogEntry[] {
  return CHANGELOG.filter((e) => compareVersions(e.version, seen) > 0 && compareVersions(e.version, current) <= 0);
}

// Everything up to the running version: what the About window's link shows.
export function changesUpTo(current: string): ChangelogEntry[] {
  return CHANGELOG.filter((e) => compareVersions(e.version, current) <= 0);
}

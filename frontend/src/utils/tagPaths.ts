// A tag is its full path: "Rome" is a tag, "Travel/Italy/Rome" is the same
// word filed under Italy under Travel. The backend keeps nothing but the
// path (see backend/app/services/tags.py), so the tree the UI shows is
// derived here from the names - a parent that no photo carries as a tag of
// its own still appears as a row, implied by its children.

export const TAG_SEPARATOR = "/";

export function tagLeaf(path: string): string {
  const i = path.lastIndexOf(TAG_SEPARATOR);
  return i < 0 ? path : path.slice(i + 1);
}

export function tagParent(path: string): string | null {
  const i = path.lastIndexOf(TAG_SEPARATOR);
  return i < 0 ? null : path.slice(0, i);
}

export function tagDepth(path: string): number {
  return path.split(TAG_SEPARATOR).length - 1;
}

export interface TagTreeRow {
  // The full path - what is sent to the backend.
  path: string;
  leaf: string;
  depth: number;
  // False for a parent no photo carries as a tag of its own: it is only
  // here because something is filed under it.
  own: boolean;
}

// Flatten a list of paths into rows in tree order: each parent before its
// children, siblings sorted case-insensitively, missing parents filled in.
export function tagTreeRows(paths: string[]): TagTreeRow[] {
  const own = new Set(paths);
  const all = new Set<string>();
  for (const path of paths) {
    const parts = path.split(TAG_SEPARATOR);
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join(TAG_SEPARATOR));
  }
  const sorted = [...all].sort((a, b) => {
    const pa = a.split(TAG_SEPARATOR);
    const pb = b.split(TAG_SEPARATOR);
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      const c = pa[i].localeCompare(pb[i], undefined, { sensitivity: "base" });
      if (c !== 0) return c;
    }
    return pa.length - pb.length;
  });
  return sorted.map((path) => ({ path, leaf: tagLeaf(path), depth: tagDepth(path), own: own.has(path) }));
}

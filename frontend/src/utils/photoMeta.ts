// Small formatting helpers shared by every view that shows a photo's metadata
// (the lightbox's info table and the grid's hover card), so the two can never
// disagree about how a shutter speed or a filename reads.

// exiftool delivers the exposure time as a plain decimal ("0.003571428571");
// photographers read shutter speeds as fractions ("1/280") or whole seconds.
export function formatShutterSpeed(value: string | null): string {
  if (!value) return "—";
  const secs = Number(value);
  if (!isFinite(secs) || secs <= 0) return value; // already "1/280"-style or unparseable
  if (secs >= 1) return `${Number(secs.toFixed(1))}s`;
  return `1/${Math.round(1 / secs)}`;
}

// Split a filename into the part the user may edit and the extension, which
// they may not: the extension is what makes a RAF a RAF, so the rename field
// shows it beside the input rather than inside it. A name with no dot (or a
// leading one, like ".hidden") is all stem.
export function splitFilename(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: "" };
}

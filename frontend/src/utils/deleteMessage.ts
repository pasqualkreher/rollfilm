// Deleting means two different things (mirroring the backend's bulk-delete):
// managed photos move to the in-app Trash and can be restored; photos indexed
// in place from an external folder are removed from the library only - their
// files on disk are never touched. Build one confirm message that says exactly
// what will happen to the current selection. Typed structurally (not ImageOut)
// so the library's slim index entries qualify too.
export function deleteConfirmMessage(
  images: { source_root_id: string | null }[],
  hiddenPaired = 0
): string {
  const managed = images.filter((im) => im.source_root_id === null).length;
  const referenced = images.length - managed;
  const pairSuffix =
    hiddenPaired > 0
      ? ` (plus ${hiddenPaired} paired RAW/JPEG file${hiddenPaired === 1 ? "" : "s"})`
      : "";

  const parts: string[] = [];
  if (managed > 0) {
    parts.push(
      `${managed} photo(s) will move to the Trash - you can restore them from there later.`
    );
  }
  if (referenced > 0) {
    parts.push(
      `${referenced} photo(s) from external folders will be removed from the library only - the original files stay untouched on disk.`
    );
  }
  return `Delete ${images.length - hiddenPaired} photo(s)${pairSuffix}?\n\n${parts.join("\n")}`;
}

// The line the delete confirmations add when some of the photos sit in an
// album or a canvas. Moving to the Trash keeps the memberships (a restore puts
// the photos back), so it only says they disappear from there for now; a
// permanent delete really does take them out of the album and leaves an empty
// frame on the canvas.
export function membershipWarning(
  usage: { in_album: number; in_canvas: number; in_any: number },
  permanent: boolean
): string | null {
  if (usage.in_any === 0) return null;
  const where =
    usage.in_album > 0 && usage.in_canvas > 0
      ? "an album or a canvas"
      : usage.in_album > 0
        ? "an album"
        : "a canvas";
  const count = `${usage.in_any} of them ${usage.in_any === 1 ? "is" : "are"} in ${where}`;
  return permanent
    ? `${count} - deleting for good removes ${usage.in_any === 1 ? "it" : "them"} from there too (a canvas keeps an empty frame).`
    : `${count} - ${usage.in_any === 1 ? "it disappears" : "they disappear"} from there until restored from the Trash.`;
}

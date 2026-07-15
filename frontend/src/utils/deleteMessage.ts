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

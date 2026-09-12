// Tags Rollfilm assigns on its own: "edit" follows a photo's develop state,
// "edit copy" marks a baked copy saved from the editor, "virtual copy" a
// second library entry sharing another photo's file, "canvas artifact" a
// virtual copy no canvas holds any more (canvases mint copies to edit a placed
// photo; the tag says where a stranded one came from). The membership tags say
// where a photo is used: "album" plus one "album: <name>" per album it
// is in, "canvas" plus one "canvas: <name>" per canvas that holds it. They
// all say what a photo *is*, so the tag inputs refuse them and their chips
// carry no remove button. The backend enforces the same rule (see
// app/services/auto_tags.py) and keeps the membership tags in step with the
// albums and canvases themselves.
export const AUTO_TAGS = [
  "edit",
  "edit copy",
  "virtual copy",
  "canvas artifact",
  "album",
  "canvas",
] as const;
export const ALBUM_TAG_PREFIX = "album: ";
export const CANVAS_TAG_PREFIX = "canvas: ";

export function isAutoTag(name: string): boolean {
  const folded = name.trim().toLowerCase();
  return (
    (AUTO_TAGS as readonly string[]).includes(folded) ||
    folded.startsWith(ALBUM_TAG_PREFIX) ||
    folded.startsWith(CANVAS_TAG_PREFIX)
  );
}

// The membership NAME tags ("album: Holiday", "canvas: Poster"). They exist
// for filtering and for the server's own bookkeeping; the UI shows where a
// photo is used as album / canvas chips instead (see MembershipChips), so
// these never appear as tags anywhere - not on the photo, not in the tag
// lists and pickers.
export function isMembershipNameTag(name: string): boolean {
  const folded = name.trim().toLowerCase();
  return folded.startsWith(ALBUM_TAG_PREFIX) || folded.startsWith(CANVAS_TAG_PREFIX);
}

export function withoutMembershipNames(tags: string[]): string[] {
  return tags.filter((tag) => !isMembershipNameTag(tag));
}

export function autoTagMessage(name: string): string {
  return `“${name.trim()}” is assigned automatically and cannot be added manually.`;
}

export const AUTO_TAG_CHIP_TITLE = "Assigned automatically. Cannot be removed.";

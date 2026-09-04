// Tags Rollfilm assigns on its own: "edit" follows a photo's develop state,
// "edit copy" marks a baked copy saved from the editor, "virtual copy" a
// second library entry sharing another photo's file. They say what a photo *is*, so the tag
// inputs refuse them and their chips carry no remove button. The backend
// enforces the same rule (see app/services/auto_tags.py).
export const AUTO_TAGS = ["edit", "edit copy", "virtual copy"] as const;

export function isAutoTag(name: string): boolean {
  return (AUTO_TAGS as readonly string[]).includes(name.trim().toLowerCase());
}

export function autoTagMessage(name: string): string {
  return `“${name.trim()}” is assigned automatically and can't be added by hand.`;
}

export const AUTO_TAG_CHIP_TITLE = "Assigned automatically — can't be removed";

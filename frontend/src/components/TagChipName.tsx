import { tagLeaf, tagParent } from "../utils/tagPaths";

// A tag's name inside a chip: the leaf in full, its parents in front in a
// quieter colour - "Travel/Italy/" + "Rome" - so a long path still reads at
// a glance as the word it is, and where it is filed is there for the eye
// that wants it.
export function TagChipName({ path }: { path: string }) {
  const parent = tagParent(path);
  return (
    <>
      {parent !== null && <span className="tag-chip-path">{parent}/</span>}
      {tagLeaf(path)}
    </>
  );
}

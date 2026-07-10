// Reorders a list so that a paired item (RAW+JPEG shot together) always sits
// immediately next to its partner, while keeping the overall order otherwise
// unchanged (the pair is placed at the position of whichever half appears
// first). Without this, two files sharing near-identical EXIF timestamps
// can still end up separated by ties in the sort or by other photos.
export function groupPairsAdjacent<T extends { id: string }>(
  items: T[],
  pairedId: (item: T) => string | null | undefined
): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const emitted = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    if (emitted.has(item.id)) continue;
    result.push(item);
    emitted.add(item.id);

    const partnerId = pairedId(item);
    if (partnerId && !emitted.has(partnerId)) {
      const partner = byId.get(partnerId);
      if (partner) {
        result.push(partner);
        emitted.add(partner.id);
      }
    }
  }

  return result;
}

// Collapse each RAW+JPEG pair down to a single representative (the JPEG - what
// people actually look at), dropping the RAW partner from the list. Items
// without a partner pass through unchanged. Used to show a pair as one picture
// so the user only rates/selects one half. `fileType`/`partnerId` are read via
// accessors so this works for both library images and staged import files.
export function collapsePairsBy<T extends { id: string }>(
  items: T[],
  fileType: (item: T) => string,
  partnerId: (item: T) => string | null | undefined
): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const done = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    if (done.has(item.id)) continue;
    const pid = partnerId(item);
    const partner = pid ? byId.get(pid) : undefined;
    if (partner) {
      const rep = fileType(item) === "raw" ? partner : item;
      result.push(rep);
      done.add(item.id);
      done.add(partner.id);
    } else {
      result.push(item);
      done.add(item.id);
    }
  }

  return result;
}

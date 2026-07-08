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

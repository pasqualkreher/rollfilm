// Where a photo is used: one chip per album and per canvas that holds it,
// each a link INTO that album or canvas (a canvas opens in its view, as it
// will print). Albums and canvases are told apart by their icon and colour -
// an album is a collection, a canvas a page the photo lies on - and the
// same chips serve the photo view's "Add to" section and the tag list, so
// the marks read the same wherever they appear.
//
// Album membership comes from the photo's album_ids. Canvas membership rides
// on the derived "canvas: <name>" tags the server keeps in step with the
// canvases (see utils/autoTags.ts), resolved to a canvas by name - names are
// unique, and a rename re-tags the photos.
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { ALBUM_TAG_PREFIX, CANVAS_TAG_PREFIX } from "../utils/autoTags";
import { IconAlbum, IconCanvas, IconX } from "./Icons";

export type MembershipKind = "album" | "canvas";

export interface Membership {
  kind: MembershipKind;
  id: string;
  name: string;
}

export function membershipPath(m: Membership): string {
  return m.kind === "album" ? `/albums/${m.id}` : `/canvas/${m.id}/view`;
}

// The albums and canvases a chip can point at. Both lists are cached
// app-wide, so this costs nothing where they are already on screen.
export function useMembershipTargets() {
  const { data: albums } = useQuery({
    queryKey: ["albums"],
    queryFn: () => api.albums.list(),
    staleTime: 5 * 60_000,
  });
  const { data: canvases } = useQuery({
    queryKey: ["canvas-list"],
    queryFn: () => api.canvases.list(),
    staleTime: 5 * 60_000,
  });

  // The album or canvas a membership tag names, if it (still) exists.
  function resolveTag(tag: string): Membership | null {
    const folded = tag.trim();
    if (folded.toLowerCase().startsWith(ALBUM_TAG_PREFIX)) {
      const name = folded.slice(ALBUM_TAG_PREFIX.length).trim();
      const album = (albums ?? []).find((a) => a.name.trim() === name);
      return album ? { kind: "album", id: album.id, name: album.name } : null;
    }
    if (folded.toLowerCase().startsWith(CANVAS_TAG_PREFIX)) {
      const name = folded.slice(CANVAS_TAG_PREFIX.length).trim();
      const canvas = (canvases ?? []).find((c) => c.name.trim() === name);
      return canvas ? { kind: "canvas", id: canvas.id, name: canvas.name } : null;
    }
    return null;
  }

  // Every canvas a photo with these tags lies on.
  function canvasesOf(tags: string[]): Membership[] {
    const out: Membership[] = [];
    for (const tag of tags) {
      const m = resolveTag(tag);
      if (m && m.kind === "canvas" && !out.some((x) => x.id === m.id)) out.push(m);
    }
    return out;
  }

  function albumsOf(albumIds: string[]): Membership[] {
    return (albums ?? [])
      .filter((a) => albumIds.includes(a.id))
      .map((a) => ({ kind: "album" as const, id: a.id, name: a.name }));
  }

  return { albums, canvases, resolveTag, canvasesOf, albumsOf };
}

export function MembershipIcon({ kind, size = 11 }: { kind: MembershipKind; size?: number }) {
  return kind === "album" ? <IconAlbum size={size} /> : <IconCanvas size={size} />;
}

// One chip: the kind's icon, the name, and the × that takes the photo out
// again. The whole chip is the link; the × stays a button inside
// it and swallows its click so it never follows the link.
export function MembershipChip({
  membership,
  onRemove,
}: {
  membership: Membership;
  onRemove?: () => void;
}) {
  const { kind, name } = membership;
  const what = kind === "album" ? "album" : "canvas";
  return (
    <Link
      to={membershipPath(membership)}
      className={`tag-chip membership-chip membership-chip--${kind}`}
      title={kind === "album" ? `Open the album “${name}”` : `Show the canvas “${name}”`}
    >
      <MembershipIcon kind={kind} />
      <span className="membership-chip-name">{name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove from ${what} ${name}`}
          title={`Remove from ${what} “${name}”`}
        >
          <IconX size={11} />
        </button>
      )}
    </Link>
  );
}

// The photo view's row of memberships: its albums and the canvases it lies
// on, each with its × when the caller can take the photo out of it.
export function MembershipChips({
  albumIds,
  tags,
  onRemoveAlbum,
  onRemoveCanvas,
}: {
  albumIds: string[];
  tags: string[];
  onRemoveAlbum?: (albumId: string) => void;
  onRemoveCanvas?: (canvasId: string, name: string) => void;
}) {
  const { albumsOf, canvasesOf } = useMembershipTargets();
  const items = [...albumsOf(albumIds), ...canvasesOf(tags)];
  if (items.length === 0) return null;
  return (
    <div className="membership-chips">
      {items.map((m) => (
        <MembershipChip
          key={`${m.kind}:${m.id}`}
          membership={m}
          onRemove={
            m.kind === "album"
              ? onRemoveAlbum && (() => onRemoveAlbum(m.id))
              : onRemoveCanvas && (() => onRemoveCanvas(m.id, m.name))
          }
        />
      ))}
    </div>
  );
}

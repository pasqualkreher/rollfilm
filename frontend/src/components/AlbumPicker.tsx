import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useTransientValue } from "../utils/transientMessage";
import { Dropdown } from "./Dropdown";
import { IconX } from "./Icons";

interface Props {
  onAdd: (albumId: string) => void | Promise<unknown>;
  currentAlbumIds?: string[];
  onRemove?: (albumId: string) => void;
  // Chips-only mode: show the memberships (with their remove x), no dropdown -
  // for places where the combined AddToPicker handles the adding.
  chipsOnly?: boolean;
  // Where the caller has a better place for the outcome than under this
  // dropdown, it takes it over: the bulk action bars pass this so "added to
  // album" lands in their shared message row next to the tag and Immich notes,
  // instead of a second note stacking inside the bar. The album name comes
  // along because only the picker knows which option was chosen; the caller
  // adds the context it owns (how many photos were selected).
  onResult?: (result: { albumId: string; name: string; ok: boolean }) => void;
}

// Pure "add to an existing album" picker. Creating albums deliberately lives
// only on the Albums page, so this stays a compact dropdown that fits in the
// detail sidebar and the bulk action bar.
export function AlbumPicker({ onAdd, currentAlbumIds, onRemove, onResult, chipsOnly = false }: Props) {
  const { data: albums, isPending } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });
  const noAlbums = !isPending && (albums ?? []).length === 0;

  // Adding is otherwise invisible (the dropdown just snaps back to its
  // placeholder), so confirm briefly that it actually happened.
  const [flash, setFlash] = useTransientValue<{ text: string; error: boolean }>();
  const [busy, setBusy] = useState(false);

  function showFlash(text: string, error = false) {
    setFlash({ text, error });
  }

  async function handleAdd(albumId: string) {
    const name = (albums ?? []).find((a) => a.id === albumId)?.name ?? "album";
    setBusy(true);
    try {
      await onAdd(albumId);
      if (onResult) onResult({ albumId, name, ok: true });
      // Where the picker shows the membership chips (photo view sidebar), the
      // new chip is confirmation enough - only the chip-less bulk bar needs
      // the flash text.
      else if (!currentAlbumIds) showFlash(`Added to “${name}” ✓`);
    } catch {
      if (onResult) onResult({ albumId, name, ok: false });
      else showFlash(`Could not add to “${name}”`, true);
    } finally {
      setBusy(false);
    }
  }

  const currentAlbums = currentAlbumIds
    ? (albums ?? []).filter((a) => currentAlbumIds.includes(a.id))
    : [];

  return (
    <div className="album-picker">
      {currentAlbumIds && currentAlbums.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {currentAlbums.map((a) => (
            <span key={a.id} className="tag-chip">
              {a.name}
              {onRemove && (
                <button type="button" onClick={() => onRemove(a.id)} aria-label={`Remove from ${a.name}`} title={`Remove from ${a.name}`}>
                  <IconX size={11} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {!chipsOnly && (
      <Dropdown
        value=""
        placeholder="Add to album..."
        // Until the list arrives there is nothing to pick either, but "No
        // albums yet" would be a lie - the placeholder holds until we know.
        emptyLabel={noAlbums ? "No albums yet" : undefined}
        // The bulk action bar hides the hint below (no room for a second
        // line), so the reason has to be reachable from the button itself.
        title={noAlbums ? "Create an album on the Albums page first" : undefined}
        disabled={busy}
        ariaLabel="Add to album"
        onChange={(v) => {
          if (v) handleAdd(v);
        }}
        options={(albums ?? []).map((a) => ({ value: a.id, label: a.name }))}
      />
      )}
      {flash && (
        // Own line below the dropdown - inline it would wrap awkwardly next
        // to the select in the narrow sidebar.
        <p
          className={`status-note${flash.error ? " status-note--error" : ""}`}
          style={{ margin: "6px 0 0" }}
        >
          {flash.text}
        </p>
      )}
      {noAlbums && (
        // The button already says "No albums yet"; this only adds the where.
        <p className="album-picker-hint" style={{ color: "var(--text-muted)", fontSize: 12, margin: "6px 0 0" }}>
          Create one on the Albums page.
        </p>
      )}
    </div>
  );
}

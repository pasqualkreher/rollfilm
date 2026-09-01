import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAppDialogs } from "./AppDialogs";

// Inline rename for one of the user's own albums: the name reads as plain text
// until the parent switches `editing` on - always from a rename control, never
// from a click on the name itself - then it becomes an input. Enter or blur
// saves, Escape reverts. Smart albums are computed from the photos themselves,
// so only these hand-made albums get a name to edit.
export function AlbumNameField({
  albumId,
  name,
  editing,
  onEditingChange,
  className,
  inputClassName,
}: {
  albumId: string;
  name: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  className?: string;
  inputClassName?: string;
}) {
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter fires a save and then blurs, which would otherwise save a second
  // time - and a rejected name keeps focus, so blur must not retry either.
  const saving = useRef(false);

  useEffect(() => {
    if (!editing) return;
    setDraft(name);
    // Preselect the whole name so typing replaces it, like renaming a file.
    const frame = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [editing, name]);

  async function save() {
    if (saving.current) return;
    const next = draft.trim();
    // An empty box or an unchanged name is a cancel, not a rename.
    if (!next || next === name) {
      onEditingChange(false);
      return;
    }
    saving.current = true;
    try {
      await api.albums.update(albumId, { name: next });
      queryClient.invalidateQueries({ queryKey: ["albums"] });
      queryClient.invalidateQueries({ queryKey: ["album", albumId] });
      // The Canvas Shelf card carries the album's name too.
      queryClient.invalidateQueries({ queryKey: ["canvases"] });
      onEditingChange(false);
    } catch (e) {
      // Keep the box open with what was typed, so the name isn't lost.
      await dialogs.alert({ title: "Rename failed", message: (e as Error).message });
      inputRef.current?.focus();
    } finally {
      saving.current = false;
    }
  }

  if (!editing) return <span className={className}>{name}</span>;

  return (
    <input
      ref={inputRef}
      className={inputClassName}
      type="text"
      value={draft}
      autoFocus
      aria-label="Album name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        // The grids and the album page bind plain keys (arrows, letters) to
        // photo actions - typing a name must not trigger them.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          save();
        } else if (e.key === "Escape") {
          e.preventDefault();
          // Put the old name back before closing, so the blur that may follow
          // sees an unchanged name and saves nothing.
          setDraft(name);
          onEditingChange(false);
        }
      }}
      // Inside an album card the whole tile is a link; a click in the box
      // would follow it.
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    />
  );
}

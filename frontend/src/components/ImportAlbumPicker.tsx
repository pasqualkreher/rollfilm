import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAppDialogs } from "./AppDialogs";
import { Dropdown } from "./Dropdown";
import { IconAlbum, IconPlus } from "./Icons";

// The import review's album target: picking one only remembers it - the
// photos go into it when "Add to library" has put them in the library (the
// review does that right after the commit). Unlike AddToPicker, which acts
// the moment an entry is picked, and without its Canvas group.
// "+ New album…" creates the album right here (name asked via the app's
// prompt) and makes it the target.
export function ImportAlbumPicker({
  albumId,
  onChange,
  disabled = false,
}: {
  albumId: string | null;
  onChange: (albumId: string | null) => void;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });

  async function handle(value: string) {
    if (value === "none") onChange(null);
    else if (value.startsWith("album:")) onChange(value.slice("album:".length));
    else if (value === "new-album") {
      const name = await dialogs.prompt({
        title: "New album",
        placeholder: "Album name",
        confirmLabel: "Create",
      });
      if (!name) return;
      try {
        const created = await api.albums.create(name);
        queryClient.invalidateQueries({ queryKey: ["albums"] });
        onChange(created.id);
      } catch (err) {
        void dialogs.alert({
          title: "Could not create the album",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const options = [
    { value: "none", label: "No album" },
    ...(albums ?? []).map((a) => ({
      value: `album:${a.id}`,
      label: (
        <>
          <IconAlbum size={13} /> {a.name}
        </>
      ),
      search: a.name,
    })),
    {
      value: "new-album",
      label: (
        <>
          <IconPlus size={12} /> New album…
        </>
      ),
    },
  ];

  return (
    <span className="filter-field filter-field-inline" title="Also add the imported photos to this album">
      Album
      <Dropdown
        // An album deleted meanwhile no longer matches an option: the button
        // then reads "No album", and so does the commit (see ImportWizard).
        value={albumId ? `album:${albumId}` : "none"}
        placeholder="No album"
        disabled={disabled}
        ariaLabel="Also add the imported photos to an album"
        searchable={(albums?.length ?? 0) > 8}
        onChange={(v) => {
          if (v) void handle(v);
        }}
        options={options}
      />
    </span>
  );
}

import { useCallback, useState } from "react";
import { Presence } from "./Presence";
import { MOTION } from "../utils/usePresence";
import { PickerDialog, type PickerGroup } from "./PickerDialog";
import { noteRecent, shortList } from "../utils/recents";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useTasks } from "../state/tasks";
import { plural } from "../utils/plural";
import { useAppDialogs } from "./AppDialogs";
import { Dropdown } from "./Dropdown";
import { IconAlbum, IconCanvas } from "./Icons";
import { menuRowsToOptions, type MenuRow } from "./EditPicker";

type AlbumLike = { id: string; name: string; created_at: string; image_count?: number };
type CanvasLike = { id: string; name: string; created_at: string; updated_at?: string | null; image_count?: number };

// The lists newest-first, so a library without any recents yet still shows
// what was made last; the few used all the time come first once they have
// been (utils/recents).
function newestAlbums<T extends AlbumLike>(albums: T[]): T[] {
  return [...albums].sort((a, b) => b.created_at.localeCompare(a.created_at));
}
function newestCanvases<T extends CanvasLike>(canvases: T[]): T[] {
  return [...canvases].sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at));
}

// The bar's Add to… menu as rows (the right-click menu's "Add to" submenu
// uses the same): "Albums", the albums used last, "New album…", "Canvas", the
// canvases used last, "New canvas…", and one "More… (n)" for the rest of
// both. A null list leaves its group out. Ids: "album:<id>", "canvas:<id>",
// "new-album", "new-canvas", "more".
export function addToRows(albums: AlbumLike[] | null, canvases: CanvasLike[] | null): MenuRow[] {
  const rows: MenuRow[] = [];
  let hidden = 0;
  if (albums) {
    const short = shortList("album", newestAlbums(albums), (a) => a.id);
    hidden += short.hidden.length;
    rows.push({ kind: "head", id: "h-albums", label: "Albums" });
    for (const a of short.shown) rows.push({ kind: "item", id: `album:${a.id}`, label: a.name, icon: "album", search: a.name });
    rows.push({ kind: "item", id: "new-album", label: "New album…", icon: "plus" });
  }
  if (canvases) {
    const short = shortList("canvas", newestCanvases(canvases), (c) => c.id);
    hidden += short.hidden.length;
    rows.push({ kind: "head", id: "h-canvas", label: "Canvas" });
    for (const c of short.shown) rows.push({ kind: "item", id: `canvas:${c.id}`, label: c.name, icon: "canvas", search: c.name });
    rows.push({ kind: "item", id: "new-canvas", label: "New canvas…", icon: "plus" });
  }
  if (hidden > 0) {
    rows.push({ kind: "sep", id: "sep-more", label: "" });
    rows.push({ kind: "item", id: "more", label: `More… (${hidden})`, search: "more" });
  }
  return rows;
}

// The dialog behind "More…": every album and canvas with a search box. Ids as
// in addToRows.
export function addToPickerGroups(
  albums: AlbumLike[] | null,
  canvases: CanvasLike[] | null,
  onNewAlbum: () => void,
  onNewCanvas: () => void
): PickerGroup[] {
  const groups: PickerGroup[] = [];
  if (albums) {
    groups.push({
      heading: "Albums",
      items: newestAlbums(albums).map((a) => ({
        id: `album:${a.id}`,
        label: (
          <>
            <IconAlbum size={13} /> {a.name}
          </>
        ),
        search: a.name,
        count: a.image_count,
      })),
      newLabel: "New album…",
      onNew: onNewAlbum,
    });
  }
  if (canvases) {
    groups.push({
      heading: "Canvas",
      items: newestCanvases(canvases).map((c) => ({
        id: `canvas:${c.id}`,
        label: (
          <>
            <IconCanvas size={13} /> {c.name}
          </>
        ),
        search: c.name,
        count: c.image_count,
      })),
      newLabel: "New canvas…",
      onNew: onNewCanvas,
    });
  }
  return groups;
}

export interface AddToResult {
  kind: "album" | "canvas";
  id: string;
  name: string;
  ok: boolean;
}

// The one place an add reports: a line in the title bar's task dock - "Added
// 12 photos to canvas “Wall”" - with an Open link that lands in the album, or
// in the canvas's editor, since the photos sit in its filmstrip unplaced.
// `extra` is a trailing note ("Stopped after 4."). A failure stays until
// dismissed and has no link.
export function useAddToNotice(): (result: AddToResult, count: number, extra?: string) => void {
  const { notify } = useTasks();
  const navigate = useNavigate();
  return useCallback(
    ({ kind, id, name, ok }, count, extra = "") => {
      const what = kind === "canvas" ? `canvas “${name}”` : `“${name}”`;
      if (!ok) {
        notify({ label: `Could not add to ${what}.`, error: true });
        return;
      }
      notify({
        label: `Added ${plural(count, "photo")} to ${what}.${extra}`,
        action: {
          label: kind === "canvas" ? "Open canvas" : "Open album",
          run: () => navigate(kind === "canvas" ? `/canvas/${id}` : `/albums/${id}`),
        },
      });
    },
    [navigate, notify]
  );
}

interface Props {
  onAddToAlbum: (albumId: string) => void | Promise<unknown>;
  onAddToCanvas: (canvasId: string) => void | Promise<unknown>;
  // Where this is passed the caller reports the outcome itself (it knows
  // how many photos really went in); otherwise the picker reports `count`
  // photos (one when left out) through useAddToNotice.
  onResult?: (result: AddToResult) => void;
  count?: number;
  // Greys the picker out when there is nothing to add, so the control keeps
  // its place in the bar instead of coming and going.
  disabled?: boolean;
}

// ONE "Add to..." for every destination: albums and canvases in a single
// dropdown, each group with a "+ New ..." entry that creates the target right
// here (name asked via the app's prompt dialog) and adds the photos to it in
// the same breath - no detour over the Albums or Canvas page.
export function AddToPicker({
  onAddToAlbum,
  onAddToCanvas,
  onResult,
  count = 1,
  disabled = false,
}: Props) {
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });
  const { data: canvases } = useQuery({
    queryKey: ["canvas-list"],
    queryFn: () => api.canvases.list(),
  });

  const [busy, setBusy] = useState(false);
  // "More…": every album and canvas with a search box (PickerDialog).
  const [moreOpen, setMoreOpen] = useState(false);
  const notice = useAddToNotice();

  function report(kind: AddToResult["kind"], id: string, name: string, ok: boolean) {
    const result = { kind, id, name, ok };
    if (onResult) onResult(result);
    else notice(result, count);
  }

  // `id` may only be known once the action made the target ("New album…").
  async function run(kind: AddToResult["kind"], name: string, action: () => Promise<string>) {
    setBusy(true);
    let id = "";
    try {
      id = await action();
      // Where a photo is used shows as marks on the photo itself (the album /
      // canvas chips, the info card's icons) - they read the photo's
      // album_ids and its derived "canvas: …" tags, which the server has just
      // rewritten. Every caller used to refresh only the album/canvas lists,
      // so the new mark turned up whenever something else happened to refetch.
      queryClient.invalidateQueries({ queryKey: ["image"] });
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      noteRecent(kind, id);
      report(kind, id, name, true);
    } catch {
      report(kind, "", name, false);
    } finally {
      setBusy(false);
    }
  }

  async function handle(value: string) {
    if (value.startsWith("album:")) {
      const id = value.slice("album:".length);
      const name = (albums ?? []).find((a) => a.id === id)?.name ?? "album";
      await run("album", name, async () => {
        await onAddToAlbum(id);
        return id;
      });
    } else if (value.startsWith("canvas:")) {
      const id = value.slice("canvas:".length);
      const name = (canvases ?? []).find((c) => c.id === id)?.name ?? "canvas";
      await run("canvas", name, async () => {
        await onAddToCanvas(id);
        return id;
      });
    } else if (value === "new-album") {
      const name = await dialogs.prompt({
        title: "New album",
        placeholder: "Album name",
        confirmLabel: "Create & add",
      });
      if (!name) return;
      await run("album", name, async () => {
        const created = await api.albums.create(name);
        queryClient.invalidateQueries({ queryKey: ["albums"] });
        await onAddToAlbum(created.id);
        return created.id;
      });
    } else if (value === "new-canvas") {
      const name = await dialogs.prompt({
        title: "New canvas",
        placeholder: "Canvas name",
        confirmLabel: "Create & add",
      });
      if (!name) return;
      await run("canvas", name, async () => {
        const created = await api.canvases.create(name);
        queryClient.invalidateQueries({ queryKey: ["canvas-list"] });
        await onAddToCanvas(created.id);
        return created.id;
      });
    }
  }

  const options = menuRowsToOptions(addToRows(albums ?? [], canvases ?? []));

  return (
    <div className="album-picker">
      <Dropdown
        value=""
        placeholder={<span className="btn-label"><IconAlbum size={13} /> Add to…</span>}
        disabled={busy || disabled}
        ariaLabel="Add to album or canvas"
        onChange={(v) => {
          if (v === "more") setMoreOpen(true);
          else if (v) void handle(v);
        }}
        options={options}
      />
      <Presence open={moreOpen} ms={MOTION.modal}>
        {moreOpen && (
          <PickerDialog
            title="Add to album or canvas"
            groups={addToPickerGroups(
              albums ?? [],
              canvases ?? [],
              () => {
                setMoreOpen(false);
                void handle("new-album");
              },
              () => {
                setMoreOpen(false);
                void handle("new-canvas");
              }
            )}
            onPick={(v) => {
              setMoreOpen(false);
              void handle(v);
            }}
            onClose={() => setMoreOpen(false)}
          />
        )}
      </Presence>
    </div>
  );
}

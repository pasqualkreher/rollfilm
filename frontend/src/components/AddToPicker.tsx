import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useTasks } from "../state/tasks";
import { plural } from "../utils/plural";
import { useAppDialogs } from "./AppDialogs";
import { Dropdown } from "./Dropdown";
import { IconAlbum, IconCanvas, IconPlus } from "./Icons";

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

  const options = [
    { value: "h-albums", label: <span className="dropdown-group-label">Albums</span>, disabled: true },
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
    { value: "h-canvas", label: <span className="dropdown-group-label">Canvas</span>, disabled: true },
    ...(canvases ?? []).map((c) => ({
      value: `canvas:${c.id}`,
      label: (
        <>
          <IconCanvas size={13} /> {c.name}
        </>
      ),
      search: c.name,
    })),
    {
      value: "new-canvas",
      label: (
        <>
          <IconPlus size={12} /> New canvas…
        </>
      ),
    },
  ];

  return (
    <div className="album-picker">
      <Dropdown
        value=""
        placeholder={<span className="btn-label"><IconAlbum size={13} /> Add to…</span>}
        disabled={busy || disabled}
        ariaLabel="Add to album or canvas"
        onChange={(v) => {
          if (v) void handle(v);
        }}
        options={options}
      />
    </div>
  );
}

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useTransientValue } from "../utils/transientMessage";
import { useAppDialogs } from "./AppDialogs";
import { Dropdown } from "./Dropdown";
import { IconPlus } from "./Icons";

export interface AddToResult {
  kind: "album" | "canvas";
  name: string;
  ok: boolean;
}

interface Props {
  onAddToAlbum: (albumId: string) => void | Promise<unknown>;
  onAddToCanvas: (canvasId: string) => void | Promise<unknown>;
  // The bulk action bars own the shared message row; where this is passed the
  // outcome lands there instead of stacking under the dropdown.
  onResult?: (result: AddToResult) => void;
}

// ONE "Add to..." for both destinations: albums and canvases in a single
// dropdown, each group with a "+ New ..." entry that creates the target right
// here (name asked via the app's prompt dialog) and adds the photos to it in
// the same breath - no detour over the Albums or Canvas page.
export function AddToPicker({ onAddToAlbum, onAddToCanvas, onResult }: Props) {
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });
  const { data: canvases } = useQuery({
    queryKey: ["canvas-list"],
    queryFn: () => api.canvases.list(),
  });

  const [flash, setFlash] = useTransientValue<{ text: string; error: boolean }>();
  const [busy, setBusy] = useState(false);

  function report(kind: "album" | "canvas", name: string, ok: boolean) {
    if (onResult) onResult({ kind, name, ok });
    else
      setFlash(
        ok
          ? { text: `Added to “${name}” ✓`, error: false }
          : { text: `Could not add to “${name}”`, error: true }
      );
  }

  async function run(kind: "album" | "canvas", name: string, action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      report(kind, name, true);
    } catch {
      report(kind, name, false);
    } finally {
      setBusy(false);
    }
  }

  async function handle(value: string) {
    if (value.startsWith("album:")) {
      const id = value.slice("album:".length);
      const name = (albums ?? []).find((a) => a.id === id)?.name ?? "album";
      await run("album", name, () => Promise.resolve(onAddToAlbum(id)));
    } else if (value.startsWith("canvas:")) {
      const id = value.slice("canvas:".length);
      const name = (canvases ?? []).find((c) => c.id === id)?.name ?? "canvas";
      await run("canvas", name, () => Promise.resolve(onAddToCanvas(id)));
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
      });
    }
  }

  const options = [
    { value: "h-albums", label: <span className="dropdown-group-label">Albums</span>, disabled: true },
    ...(albums ?? []).map((a) => ({ value: `album:${a.id}`, label: a.name })),
    {
      value: "new-album",
      label: (
        <>
          <IconPlus size={12} /> New album…
        </>
      ),
    },
    { value: "h-canvas", label: <span className="dropdown-group-label">Canvas</span>, disabled: true },
    ...(canvases ?? []).map((c) => ({ value: `canvas:${c.id}`, label: c.name })),
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
        placeholder="Add to..."
        disabled={busy}
        ariaLabel="Add to album or canvas"
        onChange={(v) => {
          if (v) void handle(v);
        }}
        options={options}
      />
      {flash && (
        <p
          className={`status-note${flash.error ? " status-note--error" : ""}`}
          style={{ margin: "6px 0 0" }}
        >
          {flash.text}
        </p>
      )}
    </div>
  );
}

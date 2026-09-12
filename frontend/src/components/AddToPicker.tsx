import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useTransientValue } from "../utils/transientMessage";
import { useAppDialogs } from "./AppDialogs";
import { Dropdown } from "./Dropdown";
import { IconCheck, IconPlus } from "./Icons";

export interface AddToResult {
  kind: "album" | "canvas" | "selects";
  name: string;
  ok: boolean;
}

interface Props {
  onAddToAlbum: (albumId: string) => void | Promise<unknown>;
  onAddToCanvas: (canvasId: string) => void | Promise<unknown>;
  // Optional third destination: Selects, the shortlist. Folded in here so the
  // toolbars carry one "Add to..." instead of a separate button that got
  // squeezed to "+ Add to ..." in the narrow sidebar. When `inSelects` is
  // true (single-photo view) the entry flips to "Remove from selects".
  onAddToSelects?: () => void | Promise<unknown>;
  onRemoveFromSelects?: () => void | Promise<unknown>;
  inSelects?: boolean;
  // The bulk action bars own the shared message row; where this is passed the
  // outcome lands there instead of stacking under the dropdown.
  onResult?: (result: AddToResult) => void;
}

// ONE "Add to..." for every destination: albums and canvases in a single
// dropdown, each group with a "+ New ..." entry that creates the target right
// here (name asked via the app's prompt dialog) and adds the photos to it in
// the same breath - no detour over the Albums or Canvas page - plus Selects
// where the caller wires it up.
export function AddToPicker({
  onAddToAlbum,
  onAddToCanvas,
  onAddToSelects,
  onRemoveFromSelects,
  inSelects = false,
  onResult,
}: Props) {
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list() });
  const { data: canvases } = useQuery({
    queryKey: ["canvas-list"],
    queryFn: () => api.canvases.list(),
  });

  const [flash, setFlash] = useTransientValue<{ text: string; error: boolean }>();
  const [busy, setBusy] = useState(false);

  function report(kind: AddToResult["kind"], name: string, ok: boolean) {
    if (onResult) onResult({ kind, name, ok });
    else
      setFlash(
        ok
          ? { text: `Added to “${name}” ✓`, error: false }
          : { text: `Could not add to “${name}”`, error: true }
      );
  }

  async function run(kind: AddToResult["kind"], name: string, action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      // Where a photo is used shows as marks on the photo itself (the album /
      // canvas chips, the info card's icons) - they read the photo's
      // album_ids and its derived "canvas: …" tags, which the server has just
      // rewritten. Every caller used to refresh only the album/canvas lists,
      // so the new mark turned up whenever something else happened to refetch.
      if (kind !== "selects") {
        queryClient.invalidateQueries({ queryKey: ["image"] });
        queryClient.invalidateQueries({ queryKey: ["images"] });
        queryClient.invalidateQueries({ queryKey: ["tags"] });
      }
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
    } else if (value === "selects-add" && onAddToSelects) {
      await run("selects", "Selects", () => Promise.resolve(onAddToSelects()));
    } else if (value === "selects-remove" && onRemoveFromSelects) {
      // Removal reports through the same channel; the caller's message row
      // (or the flash below) words it from `kind` and the name.
      setBusy(true);
      try {
        await onRemoveFromSelects();
        if (onResult) onResult({ kind: "selects", name: "Selects", ok: true });
        else setFlash({ text: "Removed from Selects", error: false });
      } catch {
        if (onResult) onResult({ kind: "selects", name: "Selects", ok: false });
        else setFlash({ text: "Could not remove from Selects", error: true });
      } finally {
        setBusy(false);
      }
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
    // Selects first: it is the one-click destination, the lists below can be
    // long.
    ...(onAddToSelects
      ? [
          {
            value: "h-selects",
            label: <span className="dropdown-group-label">Selects</span>,
            disabled: true,
          },
          inSelects && onRemoveFromSelects
            ? {
                value: "selects-remove",
                label: (
                  <>
                    <IconCheck size={12} /> In selects — remove
                  </>
                ),
              }
            : { value: "selects-add", label: "Add to selects" },
        ]
      : []),
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
        ariaLabel={onAddToSelects ? "Add to selects, album or canvas" : "Add to album or canvas"}
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

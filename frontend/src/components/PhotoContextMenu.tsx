import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { editsFromImage } from "../utils/adjustments";
import { useTransientMessage } from "../utils/transientMessage";
import { useAskSaveCopyOptions } from "../state/viewPrefs";
import { ExportDialog } from "./ExportDialog";
import { SaveCopyDialog, type SaveCopyRequest } from "./SaveCopyDialog";
import { IconExport, IconReveal, IconSaveCopy } from "./Icons";
import { Presence } from "./Presence";
import { MOTION } from "../utils/usePresence";

// The grid's right-click menu: Export and Save copy for the photo under the
// pointer - or for the whole selection when that photo is part of it, so a
// multi-select right-click acts on everything ticked. Both entries open the
// same dialogs the lightbox and the editor use, so the options, the progress
// popup and the error notes are exactly the ones known from there.

// Room the menu keeps from the window edges when it is nudged back inside.
const VIEWPORT_MARGIN = 8;

// "Show in Finder" is the desktop app's: the web build has no file manager
// to hand a path to. Named after the OS's own, like every app's menu does.
const revealFile = window.photoManager?.revealFile;
const REVEAL_LABEL =
  window.photoManager?.platform === "darwin"
    ? "Show in Finder"
    : window.photoManager?.platform === "win32"
      ? "Show in Explorer"
      : "Show in file manager";

type Action = "export" | "copy" | "reveal";

// What a tile has to offer: enough for the export dialog's suggested filename.
// Both the full ImageOut (ThumbnailGrid) and the slim index entry
// (VirtualTimeline) satisfy this.
export interface ContextMenuPhoto {
  id: string;
  original_filename: string;
}

interface Target {
  ids: string[];
  // The photo that was right-clicked - names a single-photo export, and is
  // the one "Show in Finder" reveals (one file per file-manager window).
  clickedId: string;
  filename: string;
}

interface OpenMenu extends Target {
  x: number;
  y: number;
}

function Menu({
  menu,
  onPick,
  closing = false,
}: {
  menu: OpenMenu;
  onPick: (action: Action) => void;
  // Set by <Presence> while the menu animates out.
  closing?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);

  // Opens at the pointer, nudged back inside the window near the right or the
  // bottom edge - measured after the first render since the height depends on
  // the labels.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(menu.x, window.innerWidth - width - VIEWPORT_MARGIN)
    );
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(menu.y, window.innerHeight - height - VIEWPORT_MARGIN)
    );
    setPlaced({ left, top });
  }, [menu]);

  const n = menu.ids.length;
  const many = n > 1;

  return createPortal(
    <div
      ref={ref}
      className={`ctx-menu${placed ? " is-placed" : ""}${closing ? " pm-closing" : ""}`}
      role="menu"
      style={{
        left: placed?.left ?? 0,
        top: placed?.top ?? 0,
        visibility: placed ? "visible" : "hidden",
      }}
      // A press inside the menu must not count as the outside click that
      // closes it, and must not start a selection on the grid underneath.
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {many && <div className="ctx-menu-head">{n} photos selected</div>}
      <button
        type="button"
        role="menuitem"
        className="ctx-menu-item"
        onClick={() => onPick("export")}
        title={
          many
            ? "Export as JPEGs with edits applied, or download the original files unchanged"
            : "Export a JPEG with your edits applied, or download the original file unchanged"
        }
      >
        <IconExport size={14} />
        {many ? `Export ${n} photos…` : "Export…"}
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-menu-item"
        onClick={() => onPick("copy")}
        title="Create a new photo from the saved edits: a new JPEG file or a virtual copy that shares the original file"
      >
        <IconSaveCopy size={14} />
        {many ? `Save copy of ${n} photos…` : "Save copy…"}
      </button>
      {revealFile && (
        <button
          type="button"
          role="menuitem"
          className="ctx-menu-item"
          onClick={() => onPick("reveal")}
          title={
            many
              ? `Selects the right-clicked photo's file in ${REVEAL_LABEL.replace("Show in ", "")}`
              : `Selects the photo's file in ${REVEAL_LABEL.replace("Show in ", "")}`
          }
        >
          <IconReveal size={14} />
          {REVEAL_LABEL}
        </button>
      )}
    </div>,
    document.body
  );
}

/**
 * Right-click menu for a photo grid. Returns the handler to put on every tile
 * and the overlay (menu + dialogs) to render once per grid; both portal onto
 * <body>, since the grids clip their own overflow.
 *
 * `selectedIds` decides the scope: a right-click on a selected photo targets
 * the whole selection, on any other photo just that one - the selection is
 * left alone either way.
 */
export function usePhotoContextMenu(selectedIds: Set<string> | undefined, enabled = true) {
  const queryClient = useQueryClient();
  const askSaveCopyOptions = useAskSaveCopyOptions();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  // The dialog opened from the menu keeps its target after the menu closed.
  const [dialog, setDialog] = useState<{ kind: "export" | "copy"; target: Target } | null>(null);
  // "Show in Finder" has no dialog; what it has to say (a missing file) flashes
  // as a note at the bottom of the window.
  const [note, setNote] = useTransientMessage(6000);

  const closeMenu = useCallback(() => setMenu(null), []);

  // Anything that moves the grid under the menu, or takes the user elsewhere,
  // dismisses it - it is placed against coordinates measured when it opened.
  // Scroll is captured, since it happens on an inner scroller, not the window.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("mousedown", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, closeMenu]);

  useEffect(() => {
    if (!enabled) closeMenu();
  }, [enabled, closeMenu]);

  const onContextMenu = useCallback(
    (e: MouseEvent, photo: ContextMenuPhoto) => {
      if (!enabled) return;
      e.preventDefault();
      e.stopPropagation();
      const ids =
        selectedIds && selectedIds.has(photo.id) ? Array.from(selectedIds) : [photo.id];
      setMenu({
        ids,
        clickedId: photo.id,
        filename: photo.original_filename,
        x: e.clientX,
        y: e.clientY,
      });
    },
    [enabled, selectedIds]
  );

  function pick(action: Action) {
    if (!menu) return;
    const target: Target = { ids: menu.ids, clickedId: menu.clickedId, filename: menu.filename };
    setMenu(null);
    if (action === "reveal") void reveal(target);
    else setDialog({ kind: action, target });
  }

  // Ask the backend where the file lives (a virtual copy answers with its
  // source's file), then let the desktop shell select it.
  async function reveal(target: Target) {
    if (!revealFile) return;
    try {
      const { path, exists } = await api.images.filePath(target.clickedId);
      const result = await revealFile(path);
      if (!result.ok) throw new Error(result.error || "Could not open the folder.");
      if (!exists || result.missing) {
        setNote(`${target.filename} is not on disk any more - its folder was opened instead.`);
      }
    } catch (e) {
      setNote((e as Error).message || "Could not show the file.");
    }
  }

  // Bake (or virtually copy) every targeted photo in turn, from its SAVED edits
  // - the grid has no editor state to take instead. Mirrors the lightbox's
  // Save copy, minus the jump to the new photo: with several copies there is
  // no single one to land on, so they simply appear in the grid next to their
  // originals once the queries refresh.
  async function saveCopies(req: SaveCopyRequest, report: (done: number) => void) {
    const ids = dialog?.target.ids ?? [];
    let done = 0;
    try {
      for (const id of ids) {
        if (req.kind === "virtual") {
          await api.images.virtualCopy(id);
        } else {
          const image = await api.images.get(id);
          await api.images.saveCopy(id, editsFromImage(image), {
            quality: req.quality,
            maxSize: req.maxSize,
          });
        }
        done += 1;
        report(done);
      }
    } finally {
      // Whatever was made before an error shows up too.
      if (done > 0) {
        queryClient.invalidateQueries({ queryKey: ["images"] });
        queryClient.invalidateQueries({ queryKey: ["tags"] });
      }
    }
    setDialog(null);
  }

  const overlay = (
    <>
      <Presence open={menu !== null} ms={MOTION.pop}>
        {menu && <Menu menu={menu} onPick={pick} />}
      </Presence>
      {note &&
        createPortal(
          <div className="ctx-menu-note status-note status-note--error" role="status">
            {note}
          </div>,
          document.body
        )}
      <Presence open={dialog?.kind === "export"} ms={MOTION.modal}>
        {dialog?.kind === "export" && (
          <ExportDialog
            imageIds={dialog.target.ids}
            singleFilename={dialog.target.ids.length === 1 ? dialog.target.filename : undefined}
            onClose={() => setDialog(null)}
          />
        )}
      </Presence>
      <Presence open={dialog?.kind === "copy"} ms={MOTION.modal}>
        {dialog?.kind === "copy" && (
          <SaveCopyDialog
            count={dialog.target.ids.length}
            onClose={() => setDialog(null)}
            onSave={saveCopies}
            askOptions={askSaveCopyOptions}
          />
        )}
      </Presence>
    </>
  );

  return { onContextMenu, overlay };
}

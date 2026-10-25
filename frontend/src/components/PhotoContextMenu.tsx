import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BulkResetOptions, ColorLabel, Flag } from "../api/types";
import { useTransientMessage } from "../utils/transientMessage";
import { useAskSaveCopyOptions } from "../state/viewPrefs";
import { useSaveCopies } from "../utils/useSaveCopies";
import { useMenuKeys } from "../utils/useMenuKeys";
import { autoTagMessage, isAutoTag } from "../utils/autoTags";
import { ExportDialog } from "./ExportDialog";
import { PickerDialog, type PickerGroup } from "./PickerDialog";
import { noteRecent, shortList } from "../utils/recents";
import { SaveCopyDialog, type SaveCopyRequest } from "./SaveCopyDialog";
import { useAppDialogs } from "./AppDialogs";
import { RatingStars } from "./RatingStars";
import { ColorLabelPicker } from "./ColorLabelPicker";
import { FlagPicker } from "./FlagPicker";
import { RESET_ASPECTS } from "./ResetMenu";
import { IconChevronRight } from "./Icons";
import { Presence } from "./Presence";
import { MOTION } from "../utils/usePresence";

// The grid's right-click menu, built like the system's: it appears at the
// pointer without a flourish, the arrow keys and typed letters walk it, and
// it offers everything the selection's bar at the foot of the window offers -
// open it, edit it, rate and label it, put it in an album or on a canvas, tag
// it, apply an edit or a preset (with or without a copy), reset it, sync it
// to Immich, export it or save a copy, show its file, take it out of the
// album, move it to the Trash. Everything acts on the photo under the
// pointer, or on the whole selection when that photo is part of it, so a
// right-click on one of several ticked photos means all of them.
//
// The grid supplies how a photo is opened (it knows the route and the order
// to page through); the page supplies the actions that change photos (it owns
// the selection, the batches and the messages). What neither supplies is left
// out of the menu, so a grid without a selection model still has Open, Export
// and Show in Finder, and the Trash has only Restore and Delete permanently.

// Room the menu keeps from the window edges when it is nudged back inside.
const VIEWPORT_MARGIN = 8;
// How long the pointer rests on an item with a submenu before it opens.
const SUBMENU_HOVER_MS = 150;

// "Show in Finder" is the desktop app's: the web build has no file manager
// to hand a path to. Named after the OS's own, like every app's menu does.
const revealFile = window.photoManager?.revealFile;
const REVEAL_LABEL =
  window.photoManager?.platform === "darwin"
    ? "Show in Finder"
    : window.photoManager?.platform === "win32"
      ? "Show in Explorer"
      : "Show in file manager";

// What a tile has to offer: enough for the export dialog's suggested filename.
// Both the full ImageOut (ThumbnailGrid) and the slim index entry
// (VirtualTimeline) satisfy this.
export interface ContextMenuPhoto {
  id: string;
  original_filename: string;
}

// The page's hands on its photos, each taking the ids the menu acts on. The
// same functions the bulk bar calls, by id instead of "the selection".
export interface ContextActions {
  onRate?: (ids: string[], rating: number) => void | Promise<unknown>;
  onColor?: (ids: string[], label: ColorLabel) => void | Promise<unknown>;
  // The culling flag; "" takes it off.
  onFlag?: (ids: string[], flag: Flag | "") => void | Promise<unknown>;
  // What the stars, swatches and flag show for these photos: their shared
  // values, or nothing where they differ.
  meta?: (ids: string[]) => { rating: number; colorLabel: ColorLabel; flag?: Flag | null };
  // With the target's name, for the line that reports the add.
  onAddToAlbum?: (ids: string[], albumId: string, name: string) => void | Promise<unknown>;
  onAddToCanvas?: (ids: string[], canvasId: string, name: string) => void | Promise<unknown>;
  onAddTag?: (ids: string[], name: string) => void | Promise<unknown>;
  // Develop: the automatic edit, a saved preset. "apply" = on the photos;
  // "copy" = on the photos and a copy of each saved afterwards; "on-copy" =
  // on a copy of each only, the photos untouched. The presets are read when
  // the menu opens.
  onAutoEdit?: (ids: string[], mode: EditMode) => void | Promise<unknown>;
  onApplyPreset?: (ids: string[], name: string, mode: EditMode) => void | Promise<unknown>;
  presets?: () => string[];
  // Back to the just-imported state, for the ticked aspects (explicit false
  // for the rest, as the bar's Reset menu sends it).
  onReset?: (ids: string[], opts: BulkResetOptions) => void | Promise<unknown>;
  // The one Immich row the page offers for these photos ("Add to Immich", or
  // "Sync to Immich" with a tick), or null when there is none.
  immich?: (ids: string[]) => { label: string; checked?: boolean; run: () => void | Promise<unknown> } | null;
  onRemoveFromAlbum?: (ids: string[]) => void | Promise<unknown>;
  onDelete?: (ids: string[]) => void | Promise<unknown>;
  // The Trash's own two.
  onRestore?: (ids: string[]) => void | Promise<unknown>;
  onDeleteForever?: (ids: string[]) => void | Promise<unknown>;
  // Auto pick: photos of the library that go with these (a dialog the page
  // owns).
  onAutoPick?: (ids: string[]) => void;
  // Export, Save copy and Show in Finder; on unless the page says otherwise
  // (the Trash: its photos are on their way out).
  files?: boolean;
}

export interface ContextMenuOptions {
  enabled?: boolean;
  // How the grid opens a photo, and opens it in the editor.
  open?: (id: string) => void;
  edit?: (id: string) => void;
  actions?: ContextActions;
}

interface Target {
  ids: string[];
  // The photo that was right-clicked - names a single-photo export, is the
  // one Open and Edit take, and the one "Show in Finder" reveals.
  clickedId: string;
  filename: string;
}

interface OpenMenu extends Target {
  x: number;
  y: number;
}

export type EditMode = "apply" | "copy" | "on-copy";

// The lists that hang off an item.
type SubKind = "album" | "canvas" | "tag" | "edit" | "reset";

interface SubItem {
  id: string;
  name: string;
  // A rule above this row, with a small heading where the group has a name
  // (the presets under the automatic edit).
  sepBefore?: boolean;
  headBefore?: string;
}

type Entry =
  | {
      kind: "item";
      id: string;
      label: string;
      shortcut?: string;
      checked?: boolean;
      submenu?: SubKind;
      // The rows of a submenu whose list is not loaded (edit, reset).
      items?: SubItem[];
      run: () => void;
    }
  | { kind: "sep" }
  | { kind: "row"; id: string; node: ReactNode };

type Item = Extract<Entry, { kind: "item" }>;

// A click that lands outside the menu closes it - and does nothing else: the
// tile under the pointer must not open, the ground must not clear the
// selection. The press (mousedown) closed the menu; the click that follows
// its release is eaten once.
function swallowNextClick() {
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  document.addEventListener("click", swallow, true);
  const release = () => window.setTimeout(() => document.removeEventListener("click", swallow, true), 0);
  window.addEventListener("mouseup", release, { once: true });
}

// Keeps a fixed-position box inside the window near the right or the bottom
// edge; measured after the first render since the height depends on the rows.
function usePlaced(ref: React.RefObject<HTMLElement | null>, wish: { x: number; y: number }, deps: unknown[]) {
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPlaced({
      left: Math.max(VIEWPORT_MARGIN, Math.min(wish.x, window.innerWidth - width - VIEWPORT_MARGIN)),
      top: Math.max(VIEWPORT_MARGIN, Math.min(wish.y, window.innerHeight - height - VIEWPORT_MARGIN)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return placed;
}

const NEW = "__new__";
// The row behind which the rest of a long list waits (PickerDialog).
const MORE = "__more__";

// What a list submenu says at its foot and when it is empty.
const SUB_TEXT: Record<SubKind, { newLabel?: string; empty: string }> = {
  album: { newLabel: "New album…", empty: "No albums yet" },
  canvas: { newLabel: "New canvas…", empty: "No canvases yet" },
  tag: { newLabel: "New tag…", empty: "No tags yet" },
  edit: { empty: "No presets yet" },
  reset: { empty: "" },
};

// A list hanging off an item - the albums, the canvases, the tags (loaded
// here), or rows the menu hands in (the edits, the reset aspects) - with
// "New …" at its foot where the list can grow. Opens at the item's right
// edge, or at its left where there is no room.
function ListSubmenu({
  kind,
  anchor,
  items,
  onPick,
  onNew,
  onClose,
}: {
  kind: SubKind;
  anchor: DOMRect;
  items?: SubItem[];
  onPick: (id: string, name: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list(), enabled: kind === "album" });
  const { data: canvases } = useQuery({
    queryKey: ["canvas-list"],
    queryFn: () => api.canvases.list(),
    enabled: kind === "canvas",
  });
  const { data: tags } = useQuery({ queryKey: ["tags"], queryFn: () => api.tags.list(), enabled: kind === "tag" });
  // The loaded lists newest-first, then the few used last in front and the
  // rest behind "More…" (utils/recents); the rows the menu hands in (the
  // edits, the reset aspects) come shortened already.
  const full: SubItem[] =
    kind === "album"
      ? [...(albums ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))
      : kind === "canvas"
        ? [...(canvases ?? [])].sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at))
        : kind === "tag"
          ? (tags ?? []).filter((t) => !isAutoTag(t)).map((t) => ({ id: t, name: t }))
          : items ?? [];
  const short = kind === "album" || kind === "canvas" || kind === "tag" ? shortList(kind, full, (a) => a.id) : { shown: full, hidden: [] };
  const list = short.shown;
  const moreLabel = short.hidden.length > 0 ? `More… (${short.hidden.length})` : null;
  const { newLabel, empty } = SUB_TEXT[kind];
  const ids = [...list.map((a) => a.id), ...(moreLabel ? [MORE] : []), ...(newLabel ? [NEW] : [])];
  const labelOf = (id: string) =>
    id === NEW ? newLabel ?? "" : id === MORE ? moreLabel ?? "" : list.find((a) => a.id === id)?.name ?? "";
  const { lit, setCursor } = useMenuKeys({
    open: true,
    ids,
    initial: ids[0] ?? null,
    labelOf,
    onPick: (id) => (id === NEW ? onNew() : onPick(id, labelOf(id))),
    onClose,
    onLeft: onClose,
  });
  // Beside the parent item, overlapping its edge by the menus' inset so the
  // pointer crosses over without a gap; flipped to the left near the edge.
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const rightOf = anchor.right - 4;
    const left =
      rightOf + width > window.innerWidth - VIEWPORT_MARGIN
        ? Math.max(VIEWPORT_MARGIN, anchor.left - width + 4)
        : rightOf;
    const top = Math.max(VIEWPORT_MARGIN, Math.min(anchor.top - 5, window.innerHeight - height - VIEWPORT_MARGIN));
    setPlaced({ left, top });
  }, [anchor, list.length]);

  return (
    <div
      ref={ref}
      className={`ctx-menu ctx-menu--sub${placed ? " is-placed" : ""}`}
      role="menu"
      style={{ left: placed?.left ?? 0, top: placed?.top ?? 0, visibility: placed ? "visible" : "hidden" }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {list.length === 0 && empty && <div className="ctx-menu-head">{empty}</div>}
      {list.map((a) => (
        <span key={a.id}>
          {a.sepBefore && <div className="ctx-menu-sep" role="separator" />}
          {a.headBefore && <div className="ctx-menu-head">{a.headBefore}</div>}
          <button
            type="button"
            role="menuitem"
            data-menu-id={a.id}
            className={`ctx-menu-item${lit === a.id ? " cursor" : ""}`}
            onMouseEnter={() => setCursor(a.id, true)}
            onClick={() => onPick(a.id, a.name)}
          >
            {a.name}
          </button>
        </span>
      ))}
      {moreLabel && (
        <button
          type="button"
          role="menuitem"
          data-menu-id={MORE}
          className={`ctx-menu-item${lit === MORE ? " cursor" : ""}`}
          onMouseEnter={() => setCursor(MORE, true)}
          onClick={() => onPick(MORE, "")}
        >
          {moreLabel}
        </button>
      )}
      {newLabel && (
        <>
          {list.length > 0 && <div className="ctx-menu-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            data-menu-id={NEW}
            className={`ctx-menu-item${lit === NEW ? " cursor" : ""}`}
            onMouseEnter={() => setCursor(NEW, true)}
            onClick={onNew}
          >
            {newLabel}
          </button>
        </>
      )}
    </div>
  );
}

function Menu({
  menu,
  entries,
  onClose,
  onSubPick,
  onSubNew,
  closing = false,
}: {
  menu: OpenMenu;
  entries: Entry[];
  onClose: () => void;
  onSubPick: (kind: SubKind, id: string, name: string) => void;
  onSubNew: (kind: SubKind) => void;
  // Set by <Presence> while the menu animates out.
  closing?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const placed = usePlaced(ref, menu, [menu]);
  const [sub, setSub] = useState<{ item: Item; anchor: DOMRect } | null>(null);
  const hoverTimer = useRef(0);
  const itemEls = useRef<Map<string, HTMLElement>>(new Map());

  const items = entries.filter((e): e is Item => e.kind === "item");
  const openSub = (id: string) => {
    const el = itemEls.current.get(id);
    const item = items.find((i) => i.id === id);
    if (el && item?.submenu) setSub({ item, anchor: el.getBoundingClientRect() });
  };
  const { lit: keyCursor, setCursor } = useMenuKeys({
    open: !closing,
    paused: sub !== null,
    ids: items.map((i) => i.id),
    labelOf: (id) => items.find((i) => i.id === id)?.label ?? "",
    onPick: (id) => {
      const item = items.find((i) => i.id === id);
      if (!item) return;
      if (item.submenu) openSub(id);
      else item.run();
    },
    onClose,
    onRight: (id) => {
      if (items.find((i) => i.id === id)?.submenu) openSub(id);
    },
  });

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  // The pointer resting on an item with a submenu opens it; moving onto
  // another row closes it.
  const hover = (item: Item) => {
    setCursor(item.id, true);
    window.clearTimeout(hoverTimer.current);
    if (item.submenu) hoverTimer.current = window.setTimeout(() => openSub(item.id), SUBMENU_HOVER_MS);
    else setSub(null);
  };
  // The stars and swatches are their own controls: while the pointer is on
  // them no row is lit.
  const hoverRow = () => {
    window.clearTimeout(hoverTimer.current);
    setCursor(null);
    setSub(null);
  };

  const n = menu.ids.length;

  return createPortal(
    <>
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
        {n > 1 && <div className="ctx-menu-head">{n} photos selected</div>}
        {entries.map((entry, i) => {
          if (entry.kind === "sep") return <div key={`sep-${i}`} className="ctx-menu-sep" role="separator" />;
          if (entry.kind === "row")
            return (
              <div key={entry.id} className="ctx-menu-row" onMouseEnter={hoverRow}>
                {entry.node}
              </div>
            );
          const lit = keyCursor === entry.id || sub?.item.id === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={entry.checked}
              data-menu-id={entry.id}
              aria-haspopup={entry.submenu ? "menu" : undefined}
              ref={(el) => {
                if (el) itemEls.current.set(entry.id, el);
                else itemEls.current.delete(entry.id);
              }}
              className={`ctx-menu-item${lit ? " cursor" : ""}${entry.checked === undefined ? "" : " ctx-menu-item--check"}${entry.checked ? " checked" : ""}`}
              onMouseEnter={() => hover(entry)}
              onClick={() => (entry.submenu ? openSub(entry.id) : entry.run())}
            >
              {entry.label}
              {entry.submenu ? (
                <span className="ctx-menu-arrow">
                  <IconChevronRight size={11} />
                </span>
              ) : entry.shortcut ? (
                <span className="ctx-menu-key">{entry.shortcut}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {sub && sub.item.submenu && !closing && (
        <ListSubmenu
          kind={sub.item.submenu}
          anchor={sub.anchor}
          items={sub.item.items}
          onPick={(id, name) => onSubPick(sub.item.submenu!, id, name)}
          onNew={() => onSubNew(sub.item.submenu!)}
          onClose={() => setSub(null)}
        />
      )}
    </>,
    document.body
  );
}

// The rows of "Apply edit": the automatic edit, then the saved presets.
const AUTO = "__auto__";
const EVERYTHING = "__everything__";

/**
 * Right-click menu for a photo grid. Returns the handler to put on every tile
 * and the overlay (menu + dialogs) to render once per grid; both portal onto
 * <body>, since the grids clip their own overflow.
 *
 * `selectedIds` decides the scope: a right-click on a selected photo targets
 * the whole selection, on any other photo just that one - the selection is
 * left alone either way.
 */
export function usePhotoContextMenu(selectedIds: Set<string> | undefined, options: ContextMenuOptions | boolean = {}) {
  const opts: ContextMenuOptions = typeof options === "boolean" ? { enabled: options } : options;
  const enabled = opts.enabled ?? true;
  const { open, edit, actions } = opts;
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const askSaveCopyOptions = useAskSaveCopyOptions();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  // The dialog opened from the menu keeps its target after the menu closed.
  const [dialog, setDialog] = useState<
    | { kind: "export" | "copy"; target: Target }
    // The long list behind a submenu's "More…": a loaded list, or the
    // presets of one edit mode.
    | { kind: "pick"; target: Target; what: "album" | "canvas" | "tag" | EditMode }
    | null
  >(null);
  const { data: pickAlbums } = useQuery({ queryKey: ["albums"], queryFn: () => api.albums.list(), enabled: dialog?.kind === "pick" && dialog.what === "album" });
  const { data: pickCanvases } = useQuery({ queryKey: ["canvas-list"], queryFn: () => api.canvases.list(), enabled: dialog?.kind === "pick" && dialog.what === "canvas" });
  const { data: pickTags } = useQuery({ queryKey: ["tags"], queryFn: () => api.tags.list(), enabled: dialog?.kind === "pick" && dialog.what === "tag" });
  // "Show in Finder" has no dialog; what it has to say (a missing file) flashes
  // as a note at the bottom of the window.
  const [note, setNote] = useTransientMessage(6000);
  const saveCopiesOf = useSaveCopies(setNote);

  const closeMenu = useCallback(() => setMenu(null), []);

  // Anything that moves the grid under the menu, or takes the user elsewhere,
  // dismisses it - it is placed against coordinates measured when it opened.
  // Scroll is captured, since it happens on an inner scroller, not the window.
  // Escape is the menu's own (useMenuKeys).
  useEffect(() => {
    if (!menu) return;
    const onDown = () => {
      closeMenu();
      swallowNextClick();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("blur", closeMenu);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("blur", closeMenu);
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

  const target = (): Target | null =>
    menu ? { ids: menu.ids, clickedId: menu.clickedId, filename: menu.filename } : null;

  // Ask the backend where the file lives (a virtual copy answers with its
  // source's file), then let the desktop shell select it.
  async function reveal(t: Target) {
    if (!revealFile) return;
    try {
      const { path, exists } = await api.images.filePath(t.clickedId);
      const result = await revealFile(path);
      if (!result.ok) throw new Error(result.error || "Could not open the folder.");
      if (!exists || result.missing) {
        setNote(`${t.filename} is not on disk any more - its folder was opened instead.`);
      }
    } catch (e) {
      setNote((e as Error).message || "Could not show the file.");
    }
  }

  async function newTag(t: Target) {
    const name = await dialogs.prompt({
      title: t.ids.length === 1 ? "New tag" : `New tag for ${t.ids.length} photos`,
      placeholder: "Tag name",
      confirmLabel: "Add",
    });
    if (!name) return;
    if (isAutoTag(name)) {
      await dialogs.alert({ message: autoTagMessage(name) });
      return;
    }
    await actions?.onAddTag?.(t.ids, name);
  }

  async function newAlbum(t: Target) {
    const name = await dialogs.prompt({ title: "New album", placeholder: "Album name", confirmLabel: "Create & add" });
    if (!name) return;
    const created = await api.albums.create(name);
    queryClient.invalidateQueries({ queryKey: ["albums"] });
    await actions?.onAddToAlbum?.(t.ids, created.id, name);
  }

  async function newCanvas(t: Target) {
    const name = await dialogs.prompt({ title: "New canvas", placeholder: "Canvas name", confirmLabel: "Create & add" });
    if (!name) return;
    const created = await api.canvases.create(name);
    queryClient.invalidateQueries({ queryKey: ["canvas-list"] });
    await actions?.onAddToCanvas?.(t.ids, created.id, name);
  }

  // One aspect (or all of them) back to the imported state, after a word of
  // warning - the bar's Reset menu has its ticks to make the choice explicit,
  // a single row here needs the question instead. The rest is sent as false
  // so the server's default-on metadata flags leave everything else alone.
  async function reset(t: Target, aspect: string) {
    if (!actions?.onReset) return;
    const all = aspect === EVERYTHING;
    const label = all ? "everything" : RESET_ASPECTS.find((a) => a.key === aspect)?.label.toLowerCase() ?? aspect;
    const n = t.ids.length;
    const ok = await dialogs.confirm({
      title: `Reset ${label} of ${n} photo${n === 1 ? "" : "s"}?`,
      message: all
        ? "Stars, colors, flags, tags, albums, edits and geometry go back to how they were right after import."
        : `The ${label} go back to how they were right after import.`,
      confirmLabel: "Reset",
      danger: true,
    });
    if (!ok) return;
    const opts: BulkResetOptions = {};
    for (const a of RESET_ASPECTS) opts[a.key] = all || a.key === aspect;
    // The page runs the reset as a task in the title bar.
    await actions.onReset?.(t.ids, opts);
  }

  // The rows, from what the grid and the page offer. Groups are separated
  // like the system's menus: open · change · develop · sync · file · remove.
  function build(m: OpenMenu): Entry[] {
    const t: Target = { ids: m.ids, clickedId: m.clickedId, filename: m.filename };
    const n = m.ids.length;
    const many = n > 1;
    const groups: Entry[][] = [];
    const run = (fn: () => unknown) => () => {
      setMenu(null);
      void fn();
    };

    const openGroup: Entry[] = [];
    if (open) openGroup.push({ kind: "item", id: "open", label: "Open", shortcut: "↩", run: run(() => open(m.clickedId)) });
    if (edit) openGroup.push({ kind: "item", id: "edit", label: "Edit", shortcut: "E", run: run(() => edit(m.clickedId)) });
    groups.push(openGroup);

    const change: Entry[] = [];
    const meta = actions?.meta?.(m.ids) ?? { rating: 0, colorLabel: "none" as ColorLabel, flag: null };
    if (actions?.onFlag) {
      const onFlag = actions.onFlag;
      change.push({
        kind: "row",
        id: "flag",
        node: (
          <>
            <span>Flag</span>
            <FlagPicker value={meta.flag ?? null} onChange={(f) => run(() => onFlag(m.ids, f))()} />
          </>
        ),
      });
    }
    if (actions?.onRate) {
      const onRate = actions.onRate;
      change.push({
        kind: "row",
        id: "rating",
        node: (
          <>
            <span>Rating</span>
            <RatingStars rating={meta.rating} onChange={(r) => run(() => onRate(m.ids, r))()} />
          </>
        ),
      });
    }
    if (actions?.onColor) {
      const onColor = actions.onColor;
      change.push({
        kind: "row",
        id: "color",
        node: (
          <>
            <span>Label</span>
            <ColorLabelPicker value={meta.colorLabel} onChange={(c) => run(() => onColor(m.ids, c))()} />
          </>
        ),
      });
    }
    if (actions?.onAddToAlbum) change.push({ kind: "item", id: "album", label: "Add to album", submenu: "album", run: () => {} });
    if (actions?.onAddToCanvas) change.push({ kind: "item", id: "canvas", label: "Add to canvas", submenu: "canvas", run: () => {} });
    if (actions?.onAddTag) change.push({ kind: "item", id: "tag", label: "Add tag", submenu: "tag", run: () => {} });
    groups.push(change);

    const develop: Entry[] = [];
    if (actions?.onAutoEdit || actions?.onApplyPreset) {
      // ONE "Edit" list, the bar's Edit… menu in rows: the edits as they
      // are, with a copy saved afterwards, and on a copy only. Each group
      // has the automatic edit first, then the presets.
      // Newest preset first; the ones used last in front, the rest behind
      // "More presets…" per group (utils/recents).
      const allPresets = actions.onApplyPreset ? [...(actions.presets?.() ?? [])].reverse() : [];
      const auto = Boolean(actions.onAutoEdit);
      const group = (mode: EditMode, head: string, autoName: string, suffix: string, first: boolean): SubItem[] => {
        const { shown, hidden } = shortList("preset", allPresets, (n) => n);
        return [
          ...(auto ? [{ id: `${mode}:${AUTO}`, name: autoName, sepBefore: !first, headBefore: head }] : []),
          ...shown.map((name, i) => ({
            id: `${mode}:${name}`,
            name: `${name}${suffix}`,
            sepBefore: i === 0 && !auto && !first,
            headBefore: i === 0 && !auto ? head : undefined,
          })),
          ...(hidden.length > 0 ? [{ id: `${mode}:${MORE}`, name: `More presets… (${hidden.length})` }] : []),
        ];
      };
      const editRows: SubItem[] = [
        ...group("apply", "Apply", "Auto edit", "", true),
        ...group("copy", "Apply and save copy", "Auto edit and save copy", " and save copy", false),
        ...group("on-copy", "Edit a copy", "Auto edit a copy", " on a copy", false),
      ];
      develop.push({ kind: "item", id: "develop", label: "Edit", submenu: "edit", items: editRows, run: () => {} });
    }
    if (actions?.onReset) {
      const resetRows: SubItem[] = [
        ...RESET_ASPECTS.map((a) => ({ id: a.key as string, name: a.label })),
        { id: EVERYTHING, name: "Everything", sepBefore: true },
      ];
      develop.push({ kind: "item", id: "reset", label: "Reset", submenu: "reset", items: resetRows, run: () => {} });
    }
    groups.push(develop);

    const immich = actions?.immich?.(m.ids);
    if (immich) groups.push([{ kind: "item", id: "immich", label: immich.label, checked: immich.checked, run: run(immich.run) }]);

    if (actions?.onAutoPick) {
      const pick = actions.onAutoPick;
      groups.push([{ kind: "item", id: "pick", label: "Find similar…", run: run(() => pick(t.ids)) }]);
    }
    if (actions?.files !== false) {
      groups.push([
        { kind: "item", id: "export", label: many ? `Export ${n} photos…` : "Export…", run: run(() => setDialog({ kind: "export", target: t })) },
        { kind: "item", id: "copy", label: many ? `Save copy of ${n} photos…` : "Save copy…", run: run(() => setDialog({ kind: "copy", target: t })) },
      ]);
      if (revealFile) groups.push([{ kind: "item", id: "reveal", label: REVEAL_LABEL, run: run(() => reveal(t)) }]);
    }

    const remove: Entry[] = [];
    if (actions?.onRemoveFromAlbum) {
      const onRemove = actions.onRemoveFromAlbum;
      remove.push({ kind: "item", id: "remove-album", label: "Remove from album", run: run(() => onRemove(m.ids)) });
    }
    if (actions?.onDelete) {
      const onDelete = actions.onDelete;
      remove.push({ kind: "item", id: "trash", label: "Move to Trash", shortcut: "⌫", run: run(() => onDelete(m.ids)) });
    }
    if (actions?.onRestore) {
      const onRestore = actions.onRestore;
      remove.push({ kind: "item", id: "restore", label: "Restore", run: run(() => onRestore(m.ids)) });
    }
    if (actions?.onDeleteForever) {
      const onDeleteForever = actions.onDeleteForever;
      remove.push({ kind: "item", id: "delete-forever", label: "Delete permanently", shortcut: "⌫", run: run(() => onDeleteForever(m.ids)) });
    }
    groups.push(remove);

    const entries: Entry[] = [];
    for (const g of groups) {
      if (g.length === 0) continue;
      if (entries.length > 0) entries.push({ kind: "sep" });
      entries.push(...g);
    }
    return entries;
  }

  // What a row of a submenu does.
  function subPick(kind: SubKind, id: string, name: string) {
    const t = target();
    setMenu(null);
    if (!t) return;
    switch (kind) {
      case "album":
        if (id === MORE) return setDialog({ kind: "pick", target: t, what: "album" });
        noteRecent("album", id);
        void actions?.onAddToAlbum?.(t.ids, id, name);
        break;
      case "canvas":
        if (id === MORE) return setDialog({ kind: "pick", target: t, what: "canvas" });
        noteRecent("canvas", id);
        void actions?.onAddToCanvas?.(t.ids, id, name);
        break;
      case "tag":
        if (id === MORE) return setDialog({ kind: "pick", target: t, what: "tag" });
        noteRecent("tag", id);
        void actions?.onAddTag?.(t.ids, id);
        break;
      case "edit": {
        // "<mode>:<AUTO | MORE | preset name>" (see build).
        const colon = id.indexOf(":");
        const mode = id.slice(0, colon) as EditMode;
        const what = id.slice(colon + 1);
        if (what === MORE) return setDialog({ kind: "pick", target: t, what: mode });
        if (what === AUTO) void actions?.onAutoEdit?.(t.ids, mode);
        else {
          noteRecent("preset", what);
          void actions?.onApplyPreset?.(t.ids, what, mode);
        }
        break;
      }
      case "reset":
        void reset(t, id);
        break;
    }
  }

  function subNew(kind: SubKind) {
    const t = target();
    setMenu(null);
    if (!t) return;
    if (kind === "album") void newAlbum(t);
    else if (kind === "canvas") void newCanvas(t);
    else if (kind === "tag") void newTag(t);
  }

  // Copy every targeted photo from its SAVED edits - the grid has no editor
  // state to take instead. The dialog closes at once either way and the title
  // bar counts the copies down (utils/useSaveCopies, shared with the
  // selection bar's "Save copy…").
  async function saveCopies(req: SaveCopyRequest) {
    const ids = dialog?.target.ids ?? [];
    setDialog(null);
    await saveCopiesOf(ids, req);
  }

  // The dialog behind a submenu's "More…": the whole list with a search box.
  function pickTitle(what: "album" | "canvas" | "tag" | EditMode): string {
    switch (what) {
      case "album":
        return "Add to album";
      case "canvas":
        return "Add to canvas";
      case "tag":
        return "Add tag";
      case "apply":
        return "Apply preset";
      case "copy":
        return "Apply preset and save copy";
      case "on-copy":
        return "Preset on a copy";
    }
  }
  function pickGroups(d: { target: Target; what: "album" | "canvas" | "tag" | EditMode }): PickerGroup[] {
    const t = d.target;
    switch (d.what) {
      case "album":
        return [{
          items: [...(pickAlbums ?? [])]
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .map((a) => ({ id: a.id, label: a.name, search: a.name, count: a.image_count })),
          newLabel: "New album…",
          onNew: () => {
            setDialog(null);
            void newAlbum(t);
          },
        }];
      case "canvas":
        return [{
          items: [...(pickCanvases ?? [])]
            .sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at))
            .map((c) => ({ id: c.id, label: c.name, search: c.name, count: c.image_count })),
          newLabel: "New canvas…",
          onNew: () => {
            setDialog(null);
            void newCanvas(t);
          },
        }];
      case "tag":
        return [{
          items: (pickTags ?? []).filter((x) => !isAutoTag(x)).map((x) => ({ id: x, label: x, search: x })),
          newLabel: "New tag…",
          onNew: () => {
            setDialog(null);
            void newTag(t);
          },
        }];
      default:
        return [{ items: [...(actions?.presets?.() ?? [])].reverse().map((n) => ({ id: n, label: n, search: n })) }];
    }
  }
  async function pickFromDialog(d: { target: Target; what: "album" | "canvas" | "tag" | EditMode }, id: string) {
    const t = d.target;
    switch (d.what) {
      case "album": {
        const name = (pickAlbums ?? []).find((a) => a.id === id)?.name ?? "album";
        noteRecent("album", id);
        await actions?.onAddToAlbum?.(t.ids, id, name);
        break;
      }
      case "canvas": {
        const name = (pickCanvases ?? []).find((c) => c.id === id)?.name ?? "canvas";
        noteRecent("canvas", id);
        await actions?.onAddToCanvas?.(t.ids, id, name);
        break;
      }
      case "tag":
        noteRecent("tag", id);
        await actions?.onAddTag?.(t.ids, id);
        break;
      default:
        noteRecent("preset", id);
        await actions?.onApplyPreset?.(t.ids, id, d.what);
    }
  }

  const overlay = (
    <>
      <Presence open={menu !== null} ms={MOTION.pop}>
        {menu && <Menu menu={menu} entries={build(menu)} onClose={closeMenu} onSubPick={subPick} onSubNew={subNew} />}
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
      <Presence open={dialog?.kind === "pick"} ms={MOTION.modal}>
        {dialog?.kind === "pick" && (
          <PickerDialog
            title={pickTitle(dialog.what)}
            groups={pickGroups(dialog)}
            onPick={(id) => {
              const d = dialog;
              setDialog(null);
              void pickFromDialog(d, id);
            }}
            onClose={() => setDialog(null)}
          />
        )}
      </Presence>
      <Presence open={dialog?.kind === "copy"} ms={MOTION.modal}>
        {dialog?.kind === "copy" && (
          <SaveCopyDialog
            count={dialog.target.ids.length}
            onClose={() => setDialog(null)}
            onSave={(req) => void saveCopies(req)}
            askOptions={askSaveCopyOptions}
          />
        )}
      </Presence>
    </>
  );

  return { onContextMenu, overlay };
}

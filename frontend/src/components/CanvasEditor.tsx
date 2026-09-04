import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, editVersion } from "../api/client";
import type { CanvasLayout, ImageOut, LayoutItem, LayoutTextStyle, LayoutVersion } from "../api/types";
import { collapsePairs, thumbPx, useThumbSize } from "../state/viewPrefs";
import { useAppDialogs } from "./AppDialogs";
import { PhotoEditor } from "./PhotoEditor";
import { FilterChip } from "./FilterChip";
import {
  IconAlignBottom,
  IconAlignCenter,
  IconAlignJustify,
  IconAlignLeft,
  IconAlignMiddle,
  IconAlignRight,
  IconAlignTop,
  IconArrowLeft,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCrop,
  IconDuplicate,
  IconFitAll,
  IconFitPage,
  IconGrid,
  IconGuide,
  IconHelp,
  IconImage,
  IconInfinity,
  IconLock,
  IconLockOpen,
  IconMagnet,
  IconMinus,
  IconPencil,
  IconPlus,
  IconPrinter,
  IconRedo,
  IconRotate,
  IconSheets,
  IconTextT,
  IconTrash,
  IconUndo,
  IconX,
} from "./Icons";
import {
  autoFlow,
  boundsOf,
  clampContent,
  contentTravel,
  nextFreeSpot,
  pageAtMm,
  pageOffsetMm,
  PAGE_GAP_MM,
  PAGE_PRESETS,
  snapMove,
  snapResize,
  worldRect,
  type Guide,
  type Rect,
} from "../utils/canvasLayout";
import { ExportChip } from "./CanvasExportChip";

// The creative layout of a canvas: its photos placed by hand on pages (or on
// one unbounded canvas) instead of flowed into the grid.
//
// The whole editor works in millimetres and hands the browser a single scaled
// container, so every number on screen - a frame, a type size, a guide - is the
// number that would be printed. `zoom` is px per mm and lives only in this
// component; it never reaches the document.

// A layout as this component edits it: the server's own fields minus the ones
// it owns (identity, timestamp, and the kept-version bookkeeping - versions
// are managed through their own endpoints, never written by a save).
type Doc = Omit<CanvasLayout, "canvas_id" | "updated_at" | "active_version_id" | "versions">;

// How much of a nudge counts as "meant to line up", in screen pixels. Converted
// to mm against the current zoom, so snapping feels the same zoomed in or out.
// Kept tight on purpose: every item on the page offers three lines per axis, so
// a generous threshold means a drag is forever being caught by something, which
// reads as the canvas fighting back rather than helping.
const SNAP_PX = 5;
// The margin a document without one falls back to (docs saved before the
// per-canvas margin existed).
const MARGIN_MM = 12;

// The document's page margin, guarded: never negative, never past the middle
// of the sheet (the two sides would cross and every inset flips sign).
function marginOf(doc: { margin_mm?: number; page_width_mm: number; page_height_mm: number }): number {
  const margin = doc.margin_mm ?? MARGIN_MM;
  return Math.max(0, Math.min(margin, doc.page_width_mm / 2, doc.page_height_mm / 2));
}
// Frames are drawn with handles this big on screen, whatever the zoom.
const HANDLE_PX = 9;
const MIN_SIZE_MM = 5;
// Zoom is px per mm, so 3.78 is life size on a 96dpi screen (see the readout).
// The floor is far below "the page fits": on a free canvas, or a book of thirty
// sheets, getting the WHOLE thing on screen at once is the most useful view
// there is, and the old floor of 0.2 stopped well before that on a big layout.
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 16;
// Slack around the world, in screen pixels: room to breathe around the paper,
// and room to scroll to anything dragged off its left or top edge.
const PAD = 160;
const MAX_HISTORY = 60;

const DEFAULT_TEXT_STYLE: LayoutTextStyle = {
  size_mm: 8,
  color: "#111111",
  weight: 600,
  italic: false,
  align: "left",
};

// The faces a caption can be set in. Nothing here is downloaded: the app is a
// desktop program that must work without a network, so every entry is a stack
// of fonts that ship with macOS or Windows, ending in a generic family so a
// machine that has none of them still shows something in the right spirit.
// Anything installed can still be named by hand in the editor; this list is
// the good defaults, not the limit.
const FONT_CHOICES: { label: string; stack: string }[] = [
  { label: "Helvetica Neue", stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { label: "Avenir", stack: 'Avenir, "Avenir Next", "Segoe UI", Roboto, sans-serif' },
  { label: "Futura", stack: 'Futura, "Century Gothic", "Trebuchet MS", sans-serif' },
  { label: "Gill Sans", stack: '"Gill Sans", "Gill Sans MT", Calibri, sans-serif' },
  { label: "Optima", stack: 'Optima, Candara, "Segoe UI", sans-serif' },
  { label: "Georgia", stack: 'Georgia, "Times New Roman", serif' },
  { label: "Times", stack: '"Times New Roman", Times, serif' },
  { label: "Palatino", stack: 'Palatino, "Palatino Linotype", "Book Antiqua", serif' },
  { label: "Baskerville", stack: 'Baskerville, "Libre Baskerville", Georgia, serif' },
  { label: "Garamond", stack: 'Garamond, "EB Garamond", "Cormorant Garamond", Georgia, serif' },
  { label: "Didot", stack: 'Didot, "Bodoni MT", "Bodoni 72", Georgia, serif' },
  { label: "American Typewriter", stack: '"American Typewriter", "Courier New", serif' },
  { label: "Courier", stack: '"Courier New", Courier, monospace' },
  { label: "Menlo", stack: 'Menlo, Monaco, Consolas, "Lucida Console", monospace' },
  { label: "Snell Roundhand", stack: '"Snell Roundhand", "Brush Script MT", "Segoe Script", cursive' },
];

const WEIGHT_NAMES: Record<number, string> = {
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Black",
};

// What a stack should be called on the chip: its entry's name, or - for a
// face the user typed in - the first family in it, unquoted.
function fontLabel(stack: string | undefined): string {
  if (!stack) return "App font";
  const known = FONT_CHOICES.find((choice) => choice.stack === stack);
  if (known) return known.label;
  return stack.split(",")[0].trim().replace(/^["']|["']$/g, "") || "Custom";
}

// The vertical placement is the FRAME's business, not the text's: the box is a
// flex container and the caption sits at one end of it or in the middle.
const VALIGN_CSS: Record<NonNullable<LayoutTextStyle["valign"]>, React.CSSProperties["alignItems"]> = {
  top: "flex-start",
  middle: "center",
  bottom: "flex-end",
};

// Sizes are shown to a tenth of a millimetre: enough to be exact on paper,
// short enough to fit the box.
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// The border around a photo frame, in millimetres: a share of the shorter
// edge, exactly as the editor's white frame is measured, so the same number
// gives the same look on a small print and a full-page one.
function frameMm(item: LayoutItem): number {
  const pct = item.style?.frame_pct ?? 0;
  return pct > 0 ? (Math.min(item.width_mm, item.height_mm) * pct) / 100 : 0;
}

// What "copy settings" carries from one item to the next: the frame's shape
// and turn plus its style, never its place on the page or the photo in it.
interface ItemSettings {
  kind: LayoutItem["kind"];
  width_mm: number;
  height_mm: number;
  rotation: number;
  style: LayoutTextStyle | null;
}

// The colours paper and borders usually are. Swatches, because a colour
// wheel is the wrong tool for "make it look like old paper": these are named
// so they can be recognised and matched across a canvas, and anything else is
// one click away on the wheel at the end of the row.
//
// Two runs: the warm papers from pure white down to kraft, then the cool tones
// from linen through the greys into slate, ink and black. Each is a colour a
// real printed page or a mat board comes in - nothing here is a swatch of
// "grey" picked off a slider, which is what made the first set look cheap.
const COLOR_SWATCHES: { name: string; hex: string }[] = [
  { name: "White", hex: "#ffffff" },
  { name: "Gallery white", hex: "#faf8f3" },
  { name: "Bleached paper", hex: "#f3eee2" },
  { name: "Cream", hex: "#efe6d0" },
  { name: "Parchment", hex: "#e7d9b8" },
  { name: "Kraft", hex: "#c4a27a" },
  { name: "Linen", hex: "#e9e7e2" },
  { name: "Fog", hex: "#d3d3d0" },
  { name: "Stone", hex: "#9b9b97" },
  { name: "Slate", hex: "#4e535b" },
  { name: "Charcoal", hex: "#2e2f31" },
  { name: "Ink", hex: "#14181f" },
  { name: "Black", hex: "#000000" },
];

function swatchName(hex: string | undefined): string {
  if (!hex) return "None";
  const lower = hex.toLowerCase();
  return COLOR_SWATCHES.find((swatch) => swatch.hex === lower)?.name ?? lower.toUpperCase();
}

function SwatchPicker({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange: (hex: string) => void;
}) {
  const current = value.toLowerCase();
  return (
    <div className="canvas-swatches" role="group" aria-label={label}>
      {COLOR_SWATCHES.map((swatch) => (
        <button
          key={swatch.hex}
          type="button"
          className={`canvas-swatch${current === swatch.hex ? " active" : ""}`}
          style={{ background: swatch.hex }}
          title={swatch.name}
          aria-label={swatch.name}
          aria-pressed={current === swatch.hex}
          onClick={() => onChange(swatch.hex)}
        />
      ))}
      <label
        className={`canvas-swatch canvas-swatch--custom${
          COLOR_SWATCHES.some((swatch) => swatch.hex === current) ? "" : " active"
        }`}
        title="Any other colour"
      >
        <input
          type="color"
          value={value}
          aria-label="Any other colour"
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    </div>
  );
}

// The CSS a text item is drawn with, shared by the caption on the page, the
// box it is typed into and the previews in the font editor - so what you pick
// is what you get, in every one of those places.
function textCss(style: LayoutTextStyle | null | undefined): React.CSSProperties {
  const text = style ?? DEFAULT_TEXT_STYLE;
  return {
    fontSize: text.size_mm ?? 8,
    color: text.color ?? "#111111",
    fontWeight: text.weight ?? 600,
    fontStyle: text.italic ? "italic" : "normal",
    textAlign: text.align ?? "left",
    fontFamily: text.font,
    lineHeight: text.line_height ?? 1.25,
    letterSpacing: `${text.letter_spacing ?? 0}em`,
  };
}

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLES: { key: Handle; cx: number; cy: number; cursor: string }[] = [
  { key: "nw", cx: 0, cy: 0, cursor: "nwse-resize" },
  { key: "n", cx: 0.5, cy: 0, cursor: "ns-resize" },
  { key: "ne", cx: 1, cy: 0, cursor: "nesw-resize" },
  { key: "e", cx: 1, cy: 0.5, cursor: "ew-resize" },
  { key: "se", cx: 1, cy: 1, cursor: "nwse-resize" },
  { key: "s", cx: 0.5, cy: 1, cursor: "ns-resize" },
  { key: "sw", cx: 0, cy: 1, cursor: "nesw-resize" },
  { key: "w", cx: 0, cy: 0.5, cursor: "ew-resize" },
];

// What a pointer is currently doing on the canvas. One union rather than a
// scatter of booleans: exactly one of these can be true at a time, and the
// pointer handlers read much better for it.
type Drag =
  | { kind: "none" }
  | { kind: "pan"; startX: number; startY: number; left: number; top: number }
  | { kind: "marquee"; fromX: number; fromY: number; toX: number; toY: number; additive: boolean }
  | { kind: "move"; startX: number; startY: number; origin: Map<string, LayoutItem>; moved: boolean }
  | { kind: "resize"; handle: Handle; startX: number; startY: number; origin: LayoutItem; keepAspect: boolean }
  | { kind: "rotate"; id: string; centerX: number; centerY: number; startAngle: number; origin: number }
  | { kind: "content"; id: string; startX: number; startY: number; origin: LayoutItem }
  | { kind: "place"; imageId: string; x: number; y: number };

function uuid(): string {
  return crypto.randomUUID();
}

// Pages and the free canvas are the same coordinates read two ways: an item's
// world position is its position on its sheet plus that sheet's offset. So the
// two transforms below are exact inverses, and switching mode moves NOTHING on
// screen - it only changes which sheet each thing is filed under. That is what
// makes the free canvas's page guide worth drawing: lay out against the
// outlines and switching to Pages is a relabelling, not a redesign.
function toFreeCanvas(current: Doc): Doc {
  if (current.page_mode === "infinite") return current;
  return {
    ...current,
    page_mode: "infinite",
    items: current.items.map((item) => ({
      ...item,
      page: 0,
      y_mm: item.y_mm + pageOffsetMm(item.page, current),
    })),
  };
}

function toPages(current: Doc): Doc {
  if (current.page_mode === "pages") return current;
  const stride = current.page_height_mm + PAGE_GAP_MM;
  // Enough sheets to hold everything, and never fewer than the canvas had.
  const count = Math.max(
    1,
    current.page_count,
    ...current.items.map((item) => Math.floor(Math.max(0, item.y_mm) / stride) + 1)
  );
  return {
    ...current,
    page_mode: "pages",
    page_count: count,
    items: current.items.map((item) => {
      const page = Math.max(0, Math.min(count - 1, Math.floor(item.y_mm / stride)));
      return { ...item, page, y_mm: item.y_mm - page * stride };
    }),
  };
}

export function CanvasEditor({
  canvasId,
  title,
  files,
  stripImages,
  imagesLoading,
  onExit,
  onMembershipChanged,
}: {
  canvasId: string;
  // The canvas's name - what an export is called.
  title: string;
  // Every FILE the canvas can draw (members plus placed photos): unfiltered, with RAW+JPEG pairs still both
  // present. Nothing the filter bar does may reach this list - it is what a
  // placed frame is resolved against, so a photo that is on the page has to
  // stay resolvable whatever the bar is currently showing. Collapsing pairs
  // here would break it too: a placed RAW is folded away by the pairing and
  // would come back as "Photo unavailable".
  files: ImageOut[];
  // The membership as the filter bar currently narrows it - the strip of
  // photos you pick from. RAW+JPG / RAW / JPG and the other filters act here
  // and nowhere else on this screen.
  stripImages: ImageOut[];
  imagesLoading: boolean;
  // Called when Escape has nothing left to step out of - the way back to the
  // overview, same as the lightbox's and the editor's Escape.
  onExit?: () => void;
  // The canvas edited a photo (a virtual copy appeared or changed): the owner
  // of the `files` query refetches, so edit_rev-based thumbnail URLs bust.
  onMembershipChanged?: () => void;
}) {
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: saved, isLoading } = useQuery({
    queryKey: ["canvas-layout", canvasId],
    queryFn: () => api.canvases.getLayout(canvasId),
  });

  const [doc, setDoc] = useState<Doc | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(1.6);
  const [drag, setDrag] = useState<Drag>({ kind: "none" });
  const [guides, setGuides] = useState<Guide[]>([]);
  // The one item whose photo is being moved inside its frame, and the one
  // whose text is being typed. Both are modes rather than tools: they end on
  // Escape or on a click somewhere else.
  const [croppingId, setCroppingId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  // Whether typing a new width also changes the height (and the other way
  // round) so the frame keeps its shape. On by default: most resizes are
  // "make it bigger", not "make it squarer".
  const [aspectLock, setAspectLock] = useState(true);
  // The settings last copied from an item, for pasting onto others. Held in a
  // ref (it is not rendered) with a tick so the Paste button can wake up.
  const settingsClipboard = useRef<ItemSettings | null>(null);
  const [clipboardTick, setClipboardTick] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved">("idle");
  const [showFilmstrip, setShowFilmstrip] = useState(true);
  // Holding Space turns any drag into a pan. Every canvas editor works this
  // way, and once the paper is covered in photos it is the only place left to
  // grab: dragging the background would otherwise always mean "select".
  const [panKey, setPanKey] = useState(false);

  // Undo history of whole documents. A canvas edit is rarely one field - a
  // drag moves several items, a delete removes them - so snapshots are both
  // simpler and more honest than diffs at this size.
  const past = useRef<Doc[]>([]);
  const future = useRef<Doc[]>([]);
  const [historyTick, setHistoryTick] = useState(0);

  // What a placed frame is drawn from: every file, so nothing on the page can
  // be filtered out from under it.
  const [extraFiles, setExtraFiles] = useState<ImageOut[]>([]);
  const byId = useMemo(() => {
    const map = new Map(files.map((file) => [file.id, file]));
    // Virtual copies minted in this session, and rows re-fetched right after
    // a docked-editor save: the files query catches up on its next refetch;
    // until then the fresher row wins the merge. By edit_rev, not blindly -
    // a stale extra row must never shadow a newer server row.
    for (const file of extraFiles) {
      const known = map.get(file.id);
      if (!known || (file.edit_rev ?? 0) >= (known.edit_rev ?? 0)) map.set(file.id, file);
    }
    return map;
  }, [files, extraFiles]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  // Editing a placed photo happens on a virtual copy ("canvas edit"): the
  // library original stays untouched, the frame follows the copy.
  const [editingImage, setEditingImage] = useState<ImageOut | null>(null);
  const editingOpenRef = useRef(false);
  editingOpenRef.current = editingImage !== null;
  const editingImageIdRef = useRef<string | null>(null);
  editingImageIdRef.current = editingImage?.id ?? null;
  // The frame being edited shows the editor's own preview frames live, so the
  // photo is developed right there on the page. One object URL at a time.
  const [livePreviewUrl, setLivePreviewUrl] = useState<string | null>(null);
  const livePreviewRef = useRef<string | null>(null);
  const onPreviewFrame = useCallback((blob: Blob, size: { width: number; height: number }) => {
    const url = URL.createObjectURL(blob);
    const old = livePreviewRef.current;
    livePreviewRef.current = url;
    setLivePreviewUrl(url);
    if (old) URL.revokeObjectURL(old);
    // The frame also follows the SHAPE of what the editor renders, live: a
    // quarter-turn (or a legacy crop) reshapes the frame in the same paint as
    // the turned picture appears - the editor sends the frame's pixel size
    // along, so both state writes batch into one render and the picture is
    // never cover-cropped into the old shape for a beat (which read as the
    // mask lagging behind the turn). See adoptLiveAspect for who follows.
    const imageId = editingImageIdRef.current;
    if (imageId && size.width > 0 && size.height > 0) {
      adoptLiveAspectRef.current(imageId, size.width / size.height);
    }
  }, []);

  // Coming back from the editor: the copy's pixels changed (new edit_rev), so
  // refresh our row and let the files query refetch - both thumbnail URLs
  // bust and the frame redraws sharp.
  const onMembershipChangedRef = useRef(onMembershipChanged);
  onMembershipChangedRef.current = onMembershipChanged;
  // What shape the editor left the picture in: the stored size is the file's,
  // so a quarter-turn swaps the sides and the saved crop (fractions of the
  // turned frame - the editor crops the picture as it is shown) scales them.
  // Straighten auto-crops to the same aspect; perspective can trim a whisker
  // off, which is close enough for a frame.
  function editedAspect(image: ImageOut): number | null {
    if (!image.width || !image.height) return null;
    const turned = ((image.edit_rotation ?? 0) / 90) % 2 !== 0;
    let w = turned ? image.height : image.width;
    let h = turned ? image.width : image.height;
    if (image.edit_crop_width && image.edit_crop_height) {
      w *= image.edit_crop_width;
      h *= image.edit_crop_height;
    }
    return w / h;
  }

  // Give a frame the picture's proportions, keeping its centre and its area,
  // and start the content over (the old pan/zoom belonged to the old shape).
  function reshapeToAspect(item: LayoutItem, aspect: number): LayoutItem {
    const area = item.width_mm * item.height_mm;
    const width = Math.sqrt(area * aspect);
    const height = width / aspect;
    return {
      ...item,
      x_mm: item.x_mm + (item.width_mm - width) / 2,
      y_mm: item.y_mm + (item.height_mm - height) / 2,
      width_mm: width,
      height_mm: height,
      content_scale: 1,
      content_dx: 0,
      content_dy: 0,
    };
  }

  // Assigned below once updateItems exists - refreshEditedFile only runs long
  // after the first render.
  const updateItemsRef = useRef<
    (fn: (items: LayoutItem[]) => LayoutItem[], options?: { history?: boolean }) => void
  >(() => {});

  // Live shape-following while the dock is open. Only frames still tracking
  // the photo's shape follow (a deliberately shaped frame keeps its shape),
  // and history is skipped so fiddling with the crop doesn't fill the undo
  // stack with reshapes - the closing refreshEditedFile pass writes the
  // durable state. Editor-stage niceties ride along by design: the crop tool
  // previews UNCROPPED, so opening it relaxes the frame and applying the crop
  // snaps it to the new shape.
  const liveAspectRef = useRef<number | null>(null);
  const adoptLiveAspect = useCallback((imageId: string, aspect: number) => {
    const row = byIdRef.current.get(imageId);
    const from = liveAspectRef.current ?? (row ? editedAspect(row) : null);
    if (!from || Math.abs(aspect / from - 1) <= 0.005) {
      liveAspectRef.current = from ?? aspect;
      return;
    }
    liveAspectRef.current = aspect;
    updateItemsRef.current(
      (list) =>
        list.map((item) => {
          if (item.kind !== "photo" || item.image_id !== imageId) return item;
          const frameAspect = item.width_mm / item.height_mm;
          if (Math.abs(frameAspect / from - 1) > 0.02) return item;
          return reshapeToAspect(item, aspect);
        }),
      { history: false }
    );
  }, []);
  const adoptLiveAspectRef = useRef(adoptLiveAspect);
  adoptLiveAspectRef.current = adoptLiveAspect;

  // Fetch a photo's row again after the docked editor wrote its edits (its
  // unmount-path save can land AFTER closeEditor's refetch read the pre-save
  // row) and make the page agree with the new pixels: a crop or turn reshapes
  // the picture, so a frame that still had the photo's previous proportions
  // follows it - keeping its centre and its area, the same trade
  // fitFrameToPhoto makes. A frame the user shaped deliberately keeps its
  // shape and cover-crops; only its content pan is re-clamped so the new
  // shape can't leave a gap.
  const refreshEditedFile = useCallback((imageId: string) => {
    const before = byIdRef.current.get(imageId);
    void api.images
      .get(imageId)
      .then((fresh) => {
        setExtraFiles((list) => [...list.filter((file) => file.id !== fresh.id), fresh]);
        const oldAspect = before ? editedAspect(before) : null;
        const newAspect = editedAspect(fresh);
        if (oldAspect && newAspect && Math.abs(newAspect / oldAspect - 1) > 0.005) {
          updateItemsRef.current((list) =>
            list.map((item) => {
              if (item.kind !== "photo" || item.image_id !== fresh.id) return item;
              const frameAspect = item.width_mm / item.height_mm;
              if (Math.abs(frameAspect / oldAspect - 1) > 0.02) {
                return clampContent(item, newAspect);
              }
              return reshapeToAspect(item, newAspect);
            })
          );
        }
        // Re-announce so the files query refetches with the save now visible -
        // closeEditor's own announcement can have raced the write.
        onMembershipChangedRef.current?.();
      })
      .catch(() => {
        // Non-fatal: the next files refetch carries the fresh row anyway.
      });
  }, []);

  const closeEditor = useCallback(async () => {
    setEditingImage((edited) => {
      if (edited) refreshEditedFile(edited.id);
      return null;
    });
    liveAspectRef.current = null;
    if (livePreviewRef.current) URL.revokeObjectURL(livePreviewRef.current);
    livePreviewRef.current = null;
    setLivePreviewUrl(null);
    onMembershipChangedRef.current?.();
  }, [refreshEditedFile]);
  // One entry per shot - what "Place N photos" counts and what a brand new
  // canvas is seeded with. Placing both halves of a pair would put the same
  // picture on the page twice.
  const images = useMemo(() => collapsePairs(files), [files]);

  // Adopt the saved layout once it arrives. Keyed on the canvas so switching
  // canvases reloads, but a later refetch must never stomp on unsaved edits.
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!saved || loadedFor.current === canvasId) return;
    loadedFor.current = canvasId;
    fitted.current = false;
    const { canvas_id: _a, updated_at: _u, active_version_id: _v, versions: _vs, ...rest } = saved;
    setDoc(rest);
    past.current = [];
    future.current = [];
  }, [saved, canvasId]);

  // --- Saving ---------------------------------------------------------------

  const save = useMutation({
    mutationFn: (next: Doc) => api.canvases.saveLayout(canvasId, next),
    onSuccess: (result) => {
      queryClient.setQueryData(["canvas-layout", canvasId], result);
      setSaveState((state) => (state === "saving" ? "saved" : state));
    },
  });

  // Autosave: a layout is a thing you fiddle with, and fiddling that can be
  // lost isn't fiddling. Debounced so a drag writes once when it settles, not
  // on every frame. The explicit Save below covers the two cases autosave
  // deliberately leaves alone: keeping a brand new canvas exactly as seeded,
  // and retrying after a failed write.
  const pending = useRef<Doc | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!doc || saveState !== "dirty") return;
    pending.current = doc;
    const timer = setTimeout(() => {
      setSaveState("saving");
      saveRef.current.mutate(doc);
      pending.current = null;
    }, 700);
    return () => clearTimeout(timer);
  }, [doc, saveState]);

  // Leaving the canvas (or the page) must not drop the last edit that hadn't
  // reached its debounce yet.
  useEffect(() => {
    return () => {
      if (pending.current) api.canvases.saveLayout(canvasId, pending.current).catch(() => {});
    };
  }, [canvasId]);

  // True until the first write reaches the server: the GET for a canvas nobody
  // has saved yet answers with the default document and no timestamp.
  const neverSaved = !!saved && !saved.updated_at;

  // Explicit save (the toolbar button and ⌘S): skips the debounce, and -
  // unlike the autosave, which only fires on an edit - also writes the
  // untouched starting layout. That is how a freshly opened canvas becomes the
  // canvas's saved layout without the user having to nudge a photo first.
  const docRef = useRef(doc);
  docRef.current = doc;
  const saveNow = useCallback(() => {
    const current = docRef.current;
    if (!current) return;
    pending.current = null;
    setSaveState("saving");
    saveRef.current.mutate(current);
  }, []);

  // Every edit goes through here: it records history, marks the document dirty
  // and hands the autosave something to write.
  const commit = useCallback(
    (next: Doc | ((current: Doc) => Doc), options: { history?: boolean } = {}) => {
      setDoc((current) => {
        if (!current) return current;
        const value = typeof next === "function" ? next(current) : next;
        if (value === current) return current;
        if (options.history !== false) {
          past.current = [...past.current.slice(-MAX_HISTORY), current];
          future.current = [];
          setHistoryTick((tick) => tick + 1);
        }
        return value;
      });
      setSaveState("dirty");
    },
    []
  );

  // Snapshot before a gesture that will then write with history:false on every
  // frame - one undo step per drag rather than one per pixel.
  const pushHistory = useCallback(() => {
    setDoc((current) => {
      if (!current) return current;
      past.current = [...past.current.slice(-MAX_HISTORY), current];
      future.current = [];
      setHistoryTick((tick) => tick + 1);
      return current;
    });
  }, []);

  const undo = useCallback(() => {
    setDoc((current) => {
      if (!current || past.current.length === 0) return current;
      const previous = past.current[past.current.length - 1];
      past.current = past.current.slice(0, -1);
      future.current = [current, ...future.current];
      setHistoryTick((tick) => tick + 1);
      setSaveState("dirty");
      return previous;
    });
  }, []);

  const redo = useCallback(() => {
    setDoc((current) => {
      if (!current || future.current.length === 0) return current;
      const next = future.current[0];
      future.current = future.current.slice(1);
      past.current = [...past.current, current];
      setHistoryTick((tick) => tick + 1);
      setSaveState("dirty");
      return next;
    });
  }, []);

  // --- Kept versions --------------------------------------------------------
  //
  // The autosave above means the working layout is a draft that forever
  // overwrites itself; a version is the user saying "keep this one", under a
  // name. The version list lives on the layout query (the server sends it
  // with every layout response), and every version call answers with the
  // fresh layout, so the cache is simply replaced.

  const versions = saved?.versions ?? [];
  const activeVersionId = saved?.active_version_id ?? null;

  const adoptServerLayout = useCallback(
    (result: CanvasLayout) => {
      queryClient.setQueryData(["canvas-layout", canvasId], result);
      // The Canvases shelf on the Albums page draws from these versions.
      queryClient.invalidateQueries({ queryKey: ["canvases"] });
    },
    [queryClient, canvasId]
  );

  const keepVersion = useCallback(
    async (name: string) => {
      const current = docRef.current;
      if (!current) return;
      // The snapshot is taken from the server's rows, so what is on screen
      // must reach them first - autosave may still be counting down.
      pending.current = null;
      try {
        await api.canvases.saveLayout(canvasId, current);
        adoptServerLayout(await api.canvases.createLayoutVersion(canvasId, name));
        setSaveState("saved");
      } catch {
        await dialogs.alert({
          title: "The version could not be kept",
          message: "Check that the app is still connected, then try again.",
        });
      }
    },
    [canvasId, adoptServerLayout, dialogs]
  );

  const loadVersion = useCallback(
    async (versionId: string, name: string) => {
      if (
        !(await dialogs.confirm({
          title: `Load “${name}”?`,
          message:
            "The canvas becomes this version. Keep the current state as a version first if you want a way back - or undo right after.",
          confirmLabel: "Load it",
        }))
      )
        return;
      pending.current = null;
      try {
        const result = await api.canvases.restoreLayoutVersion(canvasId, versionId);
        adoptServerLayout(result);
        const { canvas_id: _a, updated_at: _u, active_version_id: _v, versions: _vs, ...rest } = result;
        // Through the history, so loading a version is itself undoable.
        commit(rest);
        setSaveState("saved");
      } catch {
        await dialogs.alert({
          title: "The version could not be loaded",
          message: "Check that the app is still connected, then try again.",
        });
      }
    },
    [canvasId, adoptServerLayout, commit, dialogs]
  );

  const renameVersion = useCallback(
    async (versionId: string, name: string) => {
      try {
        adoptServerLayout(await api.canvases.renameLayoutVersion(canvasId, versionId, name));
      } catch {
        // The old name stands; nothing to clean up.
      }
    },
    [canvasId, adoptServerLayout]
  );

  const removeVersion = useCallback(
    async (versionId: string, name: string) => {
      if (
        !(await dialogs.confirm({
          title: `Forget version “${name}”?`,
          message: "Only this kept copy is forgotten - the canvas itself is untouched.",
          confirmLabel: "Forget it",
          danger: true,
        }))
      )
        return;
      try {
        adoptServerLayout(await api.canvases.deleteLayoutVersion(canvasId, versionId));
      } catch {
        // The version stays in the list; trying again is free.
      }
    },
    [canvasId, adoptServerLayout, dialogs]
  );

  // --- Geometry -------------------------------------------------------------
  //
  // The viewport is a real scroll container: the world is laid out at its
  // on-screen size and the browser gives it ordinary scrollbars in both
  // directions. So "where am I looking" is scrollLeft/scrollTop rather than a
  // pan of our own - which means the wheel, the trackpad, the scrollbars, the
  // keyboard and touch all work without this component knowing about any of
  // them. Zoom is still ours, and every zoom rewrites the scroll position to
  // keep the point under the cursor where it was.

  const items = doc?.items ?? [];
  const pageCount = doc?.page_mode === "pages" ? Math.max(1, doc.page_count) : 1;

  // The docked editor exists only while a photo is active: deselecting (a
  // click on empty paper, Escape's ladder, a marquee that caught nothing)
  // takes the panel with it.
  useEffect(() => {
    if (!editingImage) return;
    const activePhoto = items.some((item) => selected.has(item.id) && item.kind === "photo");
    if (!activePhoto) void closeEditor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, editingImage]);

  // Where the viewport is looking, mirrored into state so that everything
  // derived from it - the rail's highlight, the sheet a new photo lands on -
  // re-renders when the user scrolls.
  const [view, setView] = useState({ left: 0, top: 0, width: 0, height: 0, offsetX: 0, offsetY: 0 });
  // A scroll position to apply once the DOM has been laid out at the new zoom.
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  // Bumped to force a render when only the scroll position is changing, so the
  // layout effect below always gets a chance to apply it.
  const [scrollNonce, setScrollNonce] = useState(0);

  // The last view actually pushed into state, checked BEFORE calling setView.
  // The "nothing changed" test must not live inside a setView updater: syncView
  // is called both from scroll events and from the layout effect below, and
  // React queues those at different priorities - so an updater can be handed a
  // base state older than what is already committed. Against that stale value
  // the DOM always looks different, every call then produces a fresh object,
  // and the layout effect that follows each commit feeds the queue for ever -
  // "Maximum update depth exceeded" on every zoom of the free canvas. A ref
  // makes "nothing changed" a fact about the DOM, not about React's queue.
  const lastView = useRef(view);
  const syncView = useCallback(() => {
    const el = viewportRef.current;
    const surface = scrollRef.current;
    if (!el) return;
    // offsetLeft/offsetTop are the auto margins CSS gives the surface when it
    // is smaller than the window - zero whenever the canvas actually scrolls.
    const offsetX = surface?.offsetLeft ?? 0;
    const offsetY = surface?.offsetTop ?? 0;
    const current = lastView.current;
    if (
      current.left === el.scrollLeft &&
      current.top === el.scrollTop &&
      current.width === el.clientWidth &&
      current.height === el.clientHeight &&
      current.offsetX === offsetX &&
      current.offsetY === offsetY
    ) {
      return;
    }
    const next = {
      left: el.scrollLeft,
      top: el.scrollTop,
      width: el.clientWidth,
      height: el.clientHeight,
      offsetX,
      offsetY,
    };
    lastView.current = next;
    setView(next);
  }, []);

  // Until the saved layout arrives the component renders a loading line, not
  // the canvas - so on MOUNT there is no viewport element, and any effect that
  // binds to it would grab null once and never look again. Everything that
  // attaches to the viewport node re-runs on this flag instead; it flips when
  // the real canvas appears. Wheel zoom was silently dead for exactly this
  // reason: the listener was "bound" while the loading line was on screen.
  const canvasReady = !isLoading && doc !== null;

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    syncView();
    const observer = new ResizeObserver(syncView);
    observer.observe(el);
    return () => observer.disconnect();
  }, [syncView, canvasReady]);

  // The world's box in millimetres - what the scroll container can reach. With
  // native scrolling, whatever the world does not cover is simply not
  // reachable, so it has to hold anything dragged off the paper's edge.
  //
  // The free canvas is open in every direction FROM THE START: pages of slack
  // on all four sides of whatever is on it, negative coordinates included. A
  // canvas that only grows once you have shoved a photo against an edge isn't
  // free, it's a page that gives ground grudgingly. The slack is measured from
  // the content, so dragging outwards always finds more room ahead - and the
  // range still stops somewhere, which is what makes the scrollbars mean
  // something instead of receding for ever as you chase them.
  const world = useMemo(() => {
    if (!doc) return { x: 0, y: 0, w: 1, h: 1 };
    const box = boundsOf(doc.items.map((item) => worldRect(item, doc)));
    const slackX = doc.page_mode === "infinite" ? doc.page_width_mm * 3 : 0;
    const slackY = doc.page_mode === "infinite" ? doc.page_height_mm * 3 : 0;
    const paperW = doc.page_width_mm;
    const paperH =
      doc.page_mode === "infinite"
        ? doc.page_height_mm
        : Math.max(1, doc.page_count) * (doc.page_height_mm + PAGE_GAP_MM);
    // Negative coordinates are reachable in both modes: an item dragged off the
    // top-left of the paper must not become impossible to get back to.
    const left = Math.min(0, box ? box.x : 0) - slackX;
    const top = Math.min(0, box ? box.y : 0) - slackY;
    const right = Math.max(paperW, box ? box.x + box.w : 0) + slackX;
    const bottom = Math.max(paperH, box ? box.y + box.h : 0) + slackY;
    return { x: left, y: top, w: right - left, h: bottom - top };
  }, [doc]);

  // Where millimetre (0, 0) lands on the scroll surface, and how big that
  // surface is: the world at this zoom plus a slack border, and nothing else.
  //
  // Deliberately blind to the window. It used to fold the measured client size
  // in so it could centre a small world - and that closed a circle: the client
  // size decides the surface size, the surface size decides whether a scrollbar
  // appears, and a scrollbar changes the client size. Zooming set it spinning
  // and React eventually gave up with "Maximum update depth exceeded".
  // Centring is CSS's job now (.canvas-scroll gets `margin: auto`), which needs
  // no measurement at all and therefore cannot feed back.
  const originAt = useCallback(
    (at: number) => ({
      x: PAD - world.x * at,
      y: PAD - world.y * at,
      w: world.w * at + PAD * 2,
      h: world.h * at + PAD * 2,
    }),
    [world.x, world.y, world.w, world.h]
  );
  const origin = originAt(zoom);

  // The print view: nothing but the paper, the whole window, and Escape to
  // come back. The number is the sheet it opened on - the one centred in the
  // window at the time, so "show me this page" is one key.
  const [printPage, setPrintPage] = useState<number | null>(null);
  const openPrint = useCallback(() => {
    if (!doc) return;
    setPrintPage(
      doc.page_mode === "pages"
        ? pageAtMm((view.top + view.height / 2 - view.offsetY - origin.y) / zoom, doc, pageCount)
        : 0
    );
  }, [doc, origin.y, pageCount, view.height, view.offsetY, view.top, zoom]);

  // Applied after every render, and this is what keeps a drag feeling solid.
  //
  // Two things can move millimetre zero on the scroll surface. A zoom, which
  // sets pendingScroll deliberately - and the world growing around the content,
  // which nobody asked for: drag a photo past the left edge of the paper and
  // the world has to reach further left to hold it, which pushes everything
  // else right by the same amount. Uncompensated, the page slid out from under
  // the pointer exactly while the photo was being dragged, which is what made
  // moving things feel uncontrolled. So when the origin moves on its own, the
  // scroll position moves with it and the view does not budge.
  const lastAnchor = useRef({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    // Where millimetre zero sits in SCROLL coordinates: the surface's own
    // position (CSS may have centred it) plus the origin within it. Read after
    // layout, so both halves are the ones actually on screen.
    const anchor = {
      x: (scrollRef.current?.offsetLeft ?? 0) + origin.x,
      y: (scrollRef.current?.offsetTop ?? 0) + origin.y,
    };
    const target = pendingScroll.current;
    if (target) {
      pendingScroll.current = null;
      el.scrollLeft = Math.max(0, target.left);
      el.scrollTop = Math.max(0, target.top);
    } else {
      // Millimetre zero moved without anyone asking - the world grew around an
      // item dragged past an edge. Move the scroll position with it and the
      // view does not budge. Sub-pixel drift is not worth a write; one write
      // per render is how a loop starts.
      const dx = anchor.x - lastAnchor.current.x;
      const dy = anchor.y - lastAnchor.current.y;
      if (Math.abs(dx) >= 0.5) el.scrollLeft += dx;
      if (Math.abs(dy) >= 0.5) el.scrollTop += dy;
    }
    lastAnchor.current = anchor;
    syncView();
  });


  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const el = viewportRef.current;
      const rect = el?.getBoundingClientRect();
      if (!el || !rect) return { x: 0, y: 0 };
      // Measured off the surface itself, because CSS may have centred it: the
      // viewport's own left edge is no longer where millimetre zero counts from.
      const surface = scrollRef.current?.getBoundingClientRect() ?? rect;
      return {
        x: (clientX - surface.left - origin.x) / zoom,
        y: (clientY - surface.top - origin.y) / zoom,
      };
    },
    [origin.x, origin.y, zoom]
  );

  // Zoom and scroll until one world rectangle fills the window.
  const fitRect = useCallback(
    (content: Rect) => {
      const el = viewportRef.current;
      if (!el) return;
      const padding = 48;
      const next = Math.max(
        MIN_ZOOM,
        Math.min(
          MAX_ZOOM,
          Math.min(
            (el.clientWidth - padding * 2) / Math.max(1, content.w),
            (el.clientHeight - padding * 2) / Math.max(1, content.h)
          )
        )
      );
      const at = originAt(next);
      pendingScroll.current = {
        left: at.x + content.x * next - (el.clientWidth - content.w * next) / 2,
        top: at.y + content.y * next - padding,
      };
      setZoom(next);
      setScrollNonce((nonce) => nonce + 1);
    },
    [originAt]
  );

  // Fit one page (the first, or the one in view), or - with `all` - the whole
  // layout at once: every sheet of the book, or everything on the free canvas.
  const fitToView = useCallback(
    (all = false) => {
      if (!doc) return;
      const content = boundsOf(items.map((item) => worldRect(item, doc)));
      if (all) {
        fitRect(
          doc.page_mode === "pages"
            ? {
                x: 0,
                y: 0,
                w: doc.page_width_mm,
                h: Math.max(1, doc.page_count) * (doc.page_height_mm + PAGE_GAP_MM) - PAGE_GAP_MM,
              }
            : content ?? { x: 0, y: 0, w: doc.page_width_mm, h: doc.page_height_mm }
        );
        return;
      }
      fitRect(
        doc.page_mode === "pages"
          ? { x: 0, y: 0, w: doc.page_width_mm, h: doc.page_height_mm }
          : content ?? { x: 0, y: 0, w: doc.page_width_mm, h: doc.page_height_mm }
      );
    },
    [doc, fitRect, items]
  );

  // The way back from having scrolled off into the white. An endless canvas has
  // no edges to stop you and no scrollbar that means anything once you are a
  // long way out, so double-clicking the empty canvas jumps to the first photo
  // placed on it - framed with room around it, and selected, so it is obvious
  // where you landed.
  const jumpToWork = useCallback(() => {
    if (!doc) return;
    const photos = doc.items.filter((item) => item.kind === "photo");
    const first = [...(photos.length ? photos : doc.items)].sort((a, b) => a.z - b.z)[0];
    if (!first) {
      fitToView();
      return;
    }
    const rect = worldRect(first, doc);
    fitRect({ x: rect.x - rect.w / 2, y: rect.y - rect.h / 2, w: rect.w * 2, h: rect.h * 2 });
    setSelected(new Set([first.id]));
  }, [doc, fitRect, fitToView]);

  const goToPage = useCallback(
    (page: number) => {
      if (!doc) return;
      fitRect({ x: 0, y: pageOffsetMm(page, doc), w: doc.page_width_mm, h: doc.page_height_mm });
    },
    [doc, fitRect]
  );

  // Frame the page once, when the canvas first has both a document and a size.
  const fitted = useRef(false);
  useEffect(() => {
    // Not before the viewport has been laid out: fitting into a box of zero
    // width would pin the zoom to its minimum.
    if (fitted.current || !doc || view.width === 0) return;
    fitted.current = true;
    fitToView();
  }, [doc, fitToView, view.width]);

  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const el = viewportRef.current;
      if (!el) return;
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
      if (next === zoom) return;
      const rect = el.getBoundingClientRect();
      // Keep whatever sits under the cursor under the cursor.
      const px = (clientX ?? rect.left + rect.width / 2) - rect.left;
      const py = (clientY ?? rect.top + rect.height / 2) - rect.top;
      const worldX = (px + el.scrollLeft - origin.x) / zoom;
      const worldY = (py + el.scrollTop - origin.y) / zoom;
      const at = originAt(next);
      pendingScroll.current = { left: at.x + worldX * next - px, top: at.y + worldY * next - py };
      setZoom(next);
    },
    [origin.x, origin.y, originAt, zoom]
  );

  // Scroll (never zoom) until a world rectangle is on screen. Anything the
  // canvas adds for the user goes through here, so a photo placed by a click is
  // never dropped somewhere they aren't looking.
  const revealRect = useCallback(
    (rect: Rect) => {
      const el = viewportRef.current;
      if (!el) return;
      const pad = 48;
      // Scroll coordinates, so the surface's own offset (non-zero only while it
      // is small enough to be centred) has to be in here too.
      const ox = scrollRef.current?.offsetLeft ?? 0;
      const oy = scrollRef.current?.offsetTop ?? 0;
      const left = ox + origin.x + rect.x * zoom;
      const right = ox + origin.x + (rect.x + rect.w) * zoom;
      const top = oy + origin.y + rect.y * zoom;
      const bottom = oy + origin.y + (rect.y + rect.h) * zoom;
      let { scrollLeft, scrollTop } = el;
      if (left < scrollLeft + pad) scrollLeft = left - pad;
      else if (right > scrollLeft + el.clientWidth - pad) scrollLeft = right - el.clientWidth + pad;
      if (top < scrollTop + pad) scrollTop = top - pad;
      else if (bottom > scrollTop + el.clientHeight - pad) scrollTop = bottom - el.clientHeight + pad;
      pendingScroll.current = { left: scrollLeft, top: scrollTop };
      setScrollNonce((nonce) => nonce + 1);
    },
    [origin.x, origin.y, zoom]
  );

  // The sheet the user is currently looking at. New photos land there rather
  // than always on page one, which is what made "click a photo to place it"
  // feel like nothing had happened.
  const visiblePage = useCallback(() => {
    const el = viewportRef.current;
    if (!el || !doc || doc.page_mode !== "pages") return 0;
    const surface = scrollRef.current?.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const middle = surface ? rect.top + rect.height / 2 - surface.top : el.clientHeight / 2;
    return pageAtMm((middle - origin.y) / zoom, doc, Math.max(1, doc.page_count));
  }, [doc, origin.y, zoom]);

  // --- Item helpers ---------------------------------------------------------

  const updateItems = useCallback(
    (fn: (items: LayoutItem[]) => LayoutItem[], options?: { history?: boolean }) =>
      commit((current) => ({ ...current, items: fn(current.items) }), options),
    [commit]
  );
  updateItemsRef.current = updateItems;

  const patchItem = useCallback(
    (id: string, patch: Partial<LayoutItem>, options?: { history?: boolean }) =>
      updateItems(
        (list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)),
        options
      ),
    [updateItems]
  );

  const topZ = useMemo(() => items.reduce((max, item) => Math.max(max, item.z), 0), [items]);

  const imageAspect = useCallback(
    (imageId: string | null): number | null => {
      // A photo turned or cropped in the editor is shown that way everywhere
      // else too, so the frame must agree - see editedAspect.
      const image = imageId ? byId.get(imageId) : null;
      return image ? editedAspect(image) : null;
    },
    [byId]
  );

  // A canvas nobody has saved yet opens AS THE ALBUM: its photos flowed into a
  // plain grid, ready to be rearranged. Opening the canvas should show you your
  // photos - an empty sheet that first makes you go and ask for them is the
  // thing everyone got stuck on.
  //
  // Deliberately neither dirty nor undoable: until the user changes something
  // this is a starting point rather than a document, so merely opening the
  // canvas in the library still writes no rows. That is also
  // what makes starting empty possible - clearing a canvas DOES save, so a
  // layout the user emptied has been written, and is never seeded again.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!doc || !saved || saved.updated_at || imagesLoading) return;
    if (seededFor.current === canvasId || images.length === 0 || doc.items.length > 0) return;
    seededFor.current = canvasId;
    const { items: flowed, pages } = autoFlow(
      images.map((image) => ({ id: image.id, aspect: imageAspect(image.id) ?? 1.5 })),
      doc,
      { columns: 3, marginMm: marginOf(doc), gapMm: 6, startZ: 1 }
    );
    setDoc((current) =>
      current
        ? {
            ...current,
            page_count:
              current.page_mode === "pages" ? Math.max(current.page_count, pages) : current.page_count,
            items: flowed.map((item) => ({ ...item, id: uuid() })),
          }
        : current
    );
  }, [canvasId, doc, imageAspect, images, imagesLoading, saved]);

  const addPhotos = useCallback(
    (imageIds: string[], at?: { x: number; y: number }) => {
      if (!doc || imageIds.length === 0) return;
      const pageCount = Math.max(1, doc.page_count);
      const added: LayoutItem[] = [];
      let z = doc.items.reduce((max, item) => Math.max(max, item.z), 0);
      imageIds.forEach((imageId, index) => {
        const aspect = imageAspect(imageId) ?? 1.5;
        // A new frame comes in at a third of the page width - big enough to
        // see, small enough to leave room to arrange around it.
        const width = doc.page_width_mm / 3;
        const height = width / aspect;
        // Dropped where the pointer let go; clicked onto the sheet the user is
        // actually looking at.
        const page = at ? pageAtMm(at.y, doc, pageCount) : visiblePage();
        const spot = at
          ? { x: at.x - width / 2, y: at.y - pageOffsetMm(page, doc) - height / 2 }
          : nextFreeSpot(
              doc.items
                .filter((item) => item.page === page)
                .map((item) => ({ x: item.x_mm, y: item.y_mm, w: item.width_mm, h: item.height_mm })),
              doc,
              { w: width, h: height },
              marginOf(doc)
            );
        added.push({
          id: uuid(),
          kind: "photo",
          image_id: imageId,
          page,
          x_mm: spot.x + index * 4,
          y_mm: spot.y + index * 4,
          width_mm: width,
          height_mm: height,
          rotation: 0,
          z: ++z,
          content_scale: 1,
          content_dx: 0,
          content_dy: 0,
          text: null,
          style: null,
        });
      });
      commit((current) => ({ ...current, items: [...current.items, ...added] }));
      // Select and show what just appeared: on a canvas the size of a room,
      // an unacknowledged addition is indistinguishable from a dead button.
      setSelected(new Set(added.map((item) => item.id)));
      const box = boundsOf(added.map((item) => worldRect(item, doc)));
      if (box) revealRect(box);
    },
    [commit, doc, imageAspect, revealRect, visiblePage]
  );

  const addText = useCallback(() => {
    if (!doc) return;
    const id = uuid();
    const page = visiblePage();
    const margin = marginOf(doc);
    const width = Math.max(20, Math.min(120, doc.page_width_mm - margin * 2));
    // Below whatever is already on this sheet, so a new caption never lands on
    // top of a photo and reads as a glitch.
    const spot = nextFreeSpot(
      doc.items
        .filter((item) => item.page === page)
        .map((item) => ({ x: item.x_mm, y: item.y_mm, w: item.width_mm, h: item.height_mm })),
      doc,
      { w: width, h: 16 },
      margin
    );
    const item: LayoutItem = {
      id,
      kind: "text",
      image_id: null,
      page,
      x_mm: margin,
      y_mm: spot.y,
      width_mm: width,
      height_mm: 16,
      rotation: 0,
      z: topZ + 1,
      content_scale: 1,
      content_dx: 0,
      content_dy: 0,
      // Empty, not a sentence the user has to select and delete first. The
      // frame shows a ghost "Text" until something is typed.
      text: "",
      style: { ...DEFAULT_TEXT_STYLE },
    };
    commit((current) => ({ ...current, items: [...current.items, item] }));
    setSelected(new Set([id]));
    setEditingTextId(id);
    revealRect(worldRect(item, doc));
  }, [commit, doc, revealRect, topZ, visiblePage]);

  const removeSelected = useCallback(() => {
    if (selected.size === 0) return;
    updateItems((list) => list.filter((item) => !selected.has(item.id)));
    setSelected(new Set());
    setCroppingId(null);
    setEditingTextId(null);
  }, [selected, updateItems]);

  // Restack by rewriting the z of the whole page, so the numbers stay small and
  // predictable however often the user shuffles things around.
  const restack = useCallback(
    (direction: "front" | "back" | "forward" | "backward") => {
      if (selected.size === 0) return;
      updateItems((list) => {
        const ordered = [...list].sort((a, b) => a.z - b.z);
        if (direction === "front" || direction === "back") {
          const moving = ordered.filter((item) => selected.has(item.id));
          const rest = ordered.filter((item) => !selected.has(item.id));
          const next = direction === "front" ? [...rest, ...moving] : [...moving, ...rest];
          return next.map((item, index) => ({ ...item, z: index }));
        }
        const step = direction === "forward" ? 1 : -1;
        const next = [...ordered];
        const indices = next
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => selected.has(item.id))
          .map(({ index }) => index);
        // Walk from the end the swap is heading towards, or two selected items
        // side by side would leapfrog each other.
        const order = step > 0 ? indices.reverse() : indices;
        for (const index of order) {
          const target = index + step;
          if (target < 0 || target >= next.length || selected.has(next[target].id)) continue;
          [next[index], next[target]] = [next[target], next[index]];
        }
        return next.map((item, index) => ({ ...item, z: index }));
      });
    },
    [selected, updateItems]
  );

  // Give the frame back the photo's own proportions, keeping its centre and
  // its longer side - the way out of a crop the user no longer wants.
  const fitFrameToPhoto = useCallback(() => {
    updateItems((list) =>
      list.map((item) => {
        if (!selected.has(item.id) || item.kind !== "photo") return item;
        const aspect = imageAspect(item.image_id);
        if (!aspect) return item;
        return reshapeToAspect(item, aspect);
      })
    );
  }, [imageAspect, selected, updateItems]);

  // Typed size for every selected photo. The top-left corner stays put, which
  // is where the eye expects a frame to grow from when a number changes.
  const resizeSelected = useCallback(
    (size: { width_mm?: number; height_mm?: number }) => {
      updateItems((list) =>
        list.map((item) => {
          if (!selected.has(item.id) || item.kind !== "photo") return item;
          const aspect = item.width_mm / item.height_mm;
          let width = size.width_mm ?? item.width_mm;
          let height = size.height_mm ?? item.height_mm;
          if (aspectLock) {
            if (size.width_mm !== undefined) height = width / aspect;
            else if (size.height_mm !== undefined) width = height * aspect;
          }
          return {
            ...item,
            width_mm: Math.max(MIN_SIZE_MM, width),
            height_mm: Math.max(MIN_SIZE_MM, height),
          };
        })
      );
    },
    [aspectLock, selected, updateItems]
  );

  const stylePhotos = useCallback(
    (style: Partial<LayoutTextStyle>) =>
      updateItems(
        (list) =>
          list.map((item) =>
            selected.has(item.id) && item.kind === "photo"
              ? { ...item, style: { ...item.style, ...style } }
              : item
          ),
        { history: false }
      ),
    [selected, updateItems]
  );

  const copySettings = useCallback(
    (item: LayoutItem) => {
      settingsClipboard.current = {
        kind: item.kind,
        width_mm: item.width_mm,
        height_mm: item.height_mm,
        rotation: item.rotation,
        style: item.style ? { ...item.style } : null,
      };
      setClipboardTick((tick) => tick + 1);
    },
    []
  );

  // Pasting goes only onto items of the same kind: a caption's typography
  // means nothing to a photo and a photo's frame nothing to a caption. Photos
  // take the shape, the turn and the border; captions take the style alone,
  // since their box is sized to their words.
  const pasteSettings = useCallback(() => {
    const settings = settingsClipboard.current;
    if (!settings) return;
    updateItems((list) =>
      list.map((item) => {
        if (!selected.has(item.id) || item.kind !== settings.kind) return item;
        if (item.kind === "text") return { ...item, style: settings.style ? { ...settings.style } : null };
        return {
          ...item,
          width_mm: settings.width_mm,
          height_mm: settings.height_mm,
          rotation: settings.rotation,
          style: settings.style ? { ...settings.style } : null,
        };
      })
    );
  }, [selected, updateItems]);

  // Which of the canvas's photos are already on the page. A RAW+JPEG pair is
  // one shot, so placing either half settles both - otherwise "Place N photos"
  // would flow in the sibling of something already laid out, and the strip
  // would badge one half of a pair and not the other.
  const placedShots = useMemo(() => {
    const placed = new Set(items.map((item) => item.image_id).filter(Boolean) as string[]);
    for (const id of [...placed]) {
      const partner = byId.get(id)?.paired_image_id;
      if (partner) placed.add(partner);
    }
    return placed;
  }, [byId, items]);

  const unplaced = useMemo(
    () => images.filter((image) => !placedShots.has(image.id)),
    [images, placedShots]
  );

  // Flow everything the canvas hasn't got yet into a plain grid. On an empty
  // canvas this is the "just show me my photos" button, so it doesn't ask; once
  // there is a layout to disturb, it does.
  const fillFromAlbum = useCallback(async () => {
    if (!doc || unplaced.length === 0) return;
    if (
      items.length > 0 &&
      !(await dialogs.confirm({
        title: `Place ${unplaced.length} more photo${unplaced.length === 1 ? "" : "s"}?`,
        message:
          "The canvas's photos that aren't on the canvas yet will be flowed into a grid after what you already have. Nothing you placed by hand moves.",
        confirmLabel: "Place them",
      }))
    ) {
      return;
    }
    const startPage = doc.page_mode === "pages" && items.length ? Math.max(...items.map((i) => i.page)) + 1 : 0;
    const { items: flowed, pages } = autoFlow(
      unplaced.map((image) => ({ id: image.id, aspect: imageAspect(image.id) ?? 1.5 })),
      doc,
      { columns: 3, marginMm: marginOf(doc), gapMm: 6, startZ: topZ + 1 }
    );
    const added = flowed.map((item) => ({ ...item, id: uuid(), page: item.page + startPage }));
    commit((current) => ({
      ...current,
      page_count:
        current.page_mode === "pages" ? Math.max(current.page_count, startPage + pages) : current.page_count,
      items: [...current.items, ...added],
    }));
    setSelected(new Set());
    const box = boundsOf(added.map((item) => worldRect(item, doc)));
    if (box) revealRect(box);
  }, [commit, dialogs, doc, imageAspect, items, revealRect, topZ, unplaced]);

  // The way back out of a layout that went wrong. The canvas's photos are
  // untouched - only the placing is thrown away.
  const clearCanvas = useCallback(async () => {
    if (items.length === 0) return;
    if (
      !(await dialogs.confirm({
        title: "Clear the canvas?",
        message:
          "Every frame and caption you placed is removed and the page starts empty. The photos stay in your library.",
        confirmLabel: "Clear it",
        danger: true,
      }))
    ) {
      return;
    }
    setSelected(new Set());
    setCroppingId(null);
    setEditingTextId(null);
    updateItems(() => []);
  }, [dialogs, items.length, updateItems]);

  // --- Pages as things in their own right -----------------------------------
  //
  // A page is not stored anywhere: it is just the number every item on it
  // carries. So arranging pages means renumbering items, and every operation
  // below is one renumbering - which is why they can all be a single undo step
  // and why nothing can end up on a page that doesn't exist.

  // Drop the page that was at `from` into position `to`.
  const movePage = useCallback(
    (from: number, to: number) => {
      if (from === to) return;
      commit((current) => {
        const order = Array.from({ length: Math.max(1, current.page_count) }, (_, i) => i);
        if (from < 0 || from >= order.length || to < 0 || to >= order.length) return current;
        order.splice(to, 0, ...order.splice(from, 1));
        // order[newIndex] is the page that used to live there; invert it.
        const renumbered = new Map(order.map((oldPage, newPage) => [oldPage, newPage]));
        return {
          ...current,
          items: current.items.map((item) => ({ ...item, page: renumbered.get(item.page) ?? item.page })),
        };
      });
      setSelected(new Set());
      // Follow the page that moved. Panning, not re-fitting: the stage showing
      // different photos at the same scroll position with no explanation is
      // exactly the kind of silence this canvas had too much of.
      if (doc) {
        revealRect({
          x: 0,
          y: pageOffsetMm(to, doc),
          w: doc.page_width_mm,
          h: doc.page_height_mm,
        });
      }
    },
    [commit, doc, revealRect]
  );

  const addPage = useCallback(
    (after: number) => {
      commit((current) => ({
        ...current,
        page_count: current.page_count + 1,
        items: current.items.map((item) => (item.page > after ? { ...item, page: item.page + 1 } : item)),
      }));
      setSelected(new Set());
      goToPage(after + 1);
    },
    [commit, goToPage]
  );

  const duplicatePage = useCallback(
    (page: number) => {
      commit((current) => ({
        ...current,
        page_count: current.page_count + 1,
        items: [
          ...current.items.map((item) => (item.page > page ? { ...item, page: item.page + 1 } : item)),
          ...current.items
            .filter((item) => item.page === page)
            .map((item) => ({ ...item, id: uuid(), page: page + 1 })),
        ],
      }));
      setSelected(new Set());
      goToPage(page + 1);
    },
    [commit, goToPage]
  );

  const removePage = useCallback(
    async (page: number) => {
      if (!doc) return;
      const onIt = doc.items.filter((item) => item.page === page).length;
      const last = doc.page_count <= 1;
      if (
        onIt > 0 &&
        !(await dialogs.confirm({
          title: last ? "Empty this page?" : `Delete page ${page + 1}?`,
          message: `The ${onIt} thing${onIt === 1 ? "" : "s"} on it ${
            onIt === 1 ? "is" : "are"
          } taken off the canvas. The photos stay in your library.`,
          confirmLabel: last ? "Empty it" : "Delete the page",
          danger: true,
        }))
      ) {
        return;
      }
      commit((current) => ({
        ...current,
        // A canvas with no pages at all has nothing to draw on, so the last
        // page is emptied rather than removed.
        page_count: Math.max(1, current.page_count - 1),
        items: current.items
          .filter((item) => item.page !== page)
          .map((item) => (item.page > page ? { ...item, page: item.page - 1 } : item)),
      }));
      setSelected(new Set());
    },
    [commit, dialogs, doc]
  );

  // Put the picture back in the middle of its frame at full size.
  const resetCrop = useCallback(() => {
    if (!croppingId) return;
    patchItem(croppingId, { content_scale: 1, content_dx: 0, content_dy: 0 });
  }, [croppingId, patchItem]);

  // Zoom the picture inside its frame. A frame that already has the photo's
  // own proportions - which is every frame an auto-flowed canvas starts with -
  // has NO room to slide the photo in until it is zoomed, so this cannot only
  // live on the scroll wheel: dragging a photo that physically cannot move is
  // what "cropping doesn't work" looks like.
  const setCropScale = useCallback(
    (scale: number) => {
      if (!croppingId) return;
      const item = doc?.items.find((i) => i.id === croppingId);
      if (!item) return;
      const next = clampContent(
        { ...item, content_scale: Math.max(1, Math.min(6, scale)) },
        imageAspect(item.image_id)
      );
      patchItem(
        croppingId,
        {
          content_scale: next.content_scale,
          content_dx: next.content_dx,
          content_dy: next.content_dy,
        },
        { history: false }
      );
    },
    [croppingId, doc, imageAspect, patchItem]
  );

  // --- Pointer interaction --------------------------------------------------

  const dragRef = useRef<Drag>({ kind: "none" });
  dragRef.current = drag;

  const beginMove = (event: React.PointerEvent, id: string) => {
    if (!doc) return;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    let next = new Set(selected);
    if (additive) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    } else if (!next.has(id)) {
      next = new Set([id]);
    }
    setSelected(next);
    const world = toWorld(event.clientX, event.clientY);
    const origin = new Map(doc.items.filter((item) => next.has(item.id)).map((item) => [item.id, item]));
    setDrag({ kind: "move", startX: world.x, startY: world.y, origin, moved: false });
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const current = dragRef.current;
    if (current.kind === "none" || !doc) return;
    const world = toWorld(event.clientX, event.clientY);
    const threshold = SNAP_PX / zoom;
    const grid = doc.snap && doc.show_grid ? doc.grid_mm : null;

    if (current.kind === "pan") {
      const el = viewportRef.current;
      if (el) {
        el.scrollLeft = current.left - (event.clientX - current.startX);
        el.scrollTop = current.top - (event.clientY - current.startY);
      }
      return;
    }

    if (current.kind === "marquee") {
      setDrag({ ...current, toX: world.x, toY: world.y });
      return;
    }

    if (current.kind === "move") {
      let dx = world.x - current.startX;
      let dy = world.y - current.startY;
      const moving = [...current.origin.values()];
      const box = boundsOf(moving.map((item) => worldRect(item, doc)));
      if (box && doc.snap) {
        const others = doc.items
          .filter(
            (item) =>
              !current.origin.has(item.id) &&
              // Only what is on the sheets the moving box actually touches. A
              // photo two pages down lines up in x as readily as the one beside
              // it, and being pulled onto something off-screen is the opposite
              // of help.
              item.page >= pageAtMm(box.y + dy, doc, pageCount) &&
              item.page <= pageAtMm(box.y + dy + box.h, doc, pageCount)
          )
          .map((item) => worldRect(item, doc));
        const result = snapMove({ ...box, x: box.x + dx, y: box.y + dy }, others, doc, pageCount, {
          threshold,
          grid,
        });
        dx += result.dx;
        dy += result.dy;
        setGuides(result.guides);
      }
      updateItems(
        (list) =>
          list.map((item) => {
            const from = current.origin.get(item.id);
            if (!from) return item;
            const worldY = from.y_mm + pageOffsetMm(from.page, doc) + dy;
            const page = pageAtMm(worldY, doc, pageCount);
            return { ...item, x_mm: from.x_mm + dx, y_mm: worldY - pageOffsetMm(page, doc), page };
          }),
        // One history entry per drag, written when it starts.
        { history: !current.moved }
      );
      if (!current.moved) setDrag({ ...current, moved: true });
      return;
    }

    if (current.kind === "resize") {
      const from = current.origin;
      const dx = world.x - current.startX;
      const dy = world.y - current.startY;
      let { x_mm: x, y_mm: y, width_mm: w, height_mm: h } = from;
      const handle = current.handle;
      if (handle.includes("e")) w = from.width_mm + dx;
      if (handle.includes("s")) h = from.height_mm + dy;
      if (handle.includes("w")) {
        w = from.width_mm - dx;
        x = from.x_mm + dx;
      }
      if (handle.includes("n")) {
        h = from.height_mm - dy;
        y = from.y_mm + dy;
      }
      const aspect = from.width_mm / from.height_mm;
      // Re-derive the axis a held shape dictates. At a corner the pointer's
      // dominant axis wins so the frame follows it; at a side only one axis is
      // being dragged and the other grows about the frame's middle.
      const holdShape = () => {
        if (handle.length === 2) {
          if (Math.abs(w / aspect) > Math.abs(h)) h = w / aspect;
          else w = h * aspect;
          if (handle.includes("w")) x = from.x_mm + from.width_mm - w;
          if (handle.includes("n")) y = from.y_mm + from.height_mm - h;
        } else if (handle === "e" || handle === "w") {
          h = w / aspect;
          y = from.y_mm + (from.height_mm - h) / 2;
        } else {
          w = h * aspect;
          x = from.x_mm + (from.width_mm - w) / 2;
        }
      };
      if (current.keepAspect) holdShape();
      w = Math.max(MIN_SIZE_MM, w);
      h = Math.max(MIN_SIZE_MM, h);
      if (doc.snap) {
        const others = doc.items
          .filter((item) => item.id !== from.id && item.page === from.page)
          .map((item) => worldRect(item, doc));
        const box = { x, y: y + pageOffsetMm(from.page, doc), w, h };
        const result = snapResize(
          box,
          {
            x: handle.includes("w") ? "w" : handle.includes("e") ? "e" : null,
            y: handle.includes("n") ? "n" : handle.includes("s") ? "s" : null,
          },
          others,
          doc,
          pageCount,
          { threshold, grid }
        );
        // Only the edges being dragged may move, or a resize would slide the
        // frame instead of reshaping it.
        if (handle.includes("w")) {
          x += result.dx;
          w -= result.dx;
        } else if (handle.includes("e")) {
          w += result.dx;
        }
        if (handle.includes("n")) {
          y += result.dy;
          h -= result.dy;
        } else if (handle.includes("s")) {
          h += result.dy;
        }
        let guides = result.guides;
        if (current.keepAspect && guides.length > 0) {
          // A snap on one axis re-derives the other from the held shape, so
          // the frame stays true and the line shows only where it caught.
          const caughtX = guides.some((guide) => guide.axis === "x");
          if (handle.length === 2) {
            if (caughtX) {
              h = w / aspect;
              if (handle.includes("n")) y = from.y_mm + from.height_mm - h;
            } else {
              w = h * aspect;
              if (handle.includes("w")) x = from.x_mm + from.width_mm - w;
            }
          } else {
            holdShape();
          }
          guides = guides.filter((guide) => guide.axis === (caughtX ? "x" : "y"));
        }
        setGuides(guides);
      }
      patchItem(
        from.id,
        {
          x_mm: x,
          y_mm: y,
          width_mm: Math.max(MIN_SIZE_MM, w),
          height_mm: Math.max(MIN_SIZE_MM, h),
        },
        { history: false }
      );
      return;
    }

    if (current.kind === "rotate") {
      const angle = (Math.atan2(world.y - current.centerY, world.x - current.centerX) * 180) / Math.PI;
      let rotation = current.origin + (angle - current.startAngle);
      // Shift steps in 15°, and a rotation always lands somewhere readable.
      if (event.shiftKey) rotation = Math.round(rotation / 15) * 15;
      patchItem(current.id, { rotation: Math.round(rotation * 10) / 10 }, { history: false });
      return;
    }

    if (current.kind === "content") {
      const from = current.origin;
      const aspect = imageAspect(from.image_id);
      const next = clampContent(
        {
          ...from,
          content_dx: from.content_dx + (world.x - current.startX) / from.width_mm,
          content_dy: from.content_dy + (world.y - current.startY) / from.height_mm,
        },
        aspect
      );
      patchItem(from.id, { content_dx: next.content_dx, content_dy: next.content_dy }, { history: false });
    }
  };

  // A photo dragged out of the filmstrip starts its gesture OUTSIDE the
  // viewport, so the canvas's own pointer handlers never see it. Track it on
  // the window instead and drop it wherever the pointer is released - releasing
  // anywhere but over the canvas simply cancels, which leaves a plain click on
  // the chip to mean "place it for me".
  useEffect(() => {
    if (drag.kind !== "place") return;
    function onMove(event: PointerEvent) {
      const world = toWorld(event.clientX, event.clientY);
      setDrag((current) => (current.kind === "place" ? { ...current, x: world.x, y: world.y } : current));
    }
    function onUp(event: PointerEvent) {
      const rect = viewportRef.current?.getBoundingClientRect();
      const inside =
        rect &&
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      const current = dragRef.current;
      if (inside && current.kind === "place") {
        addPhotos([current.imageId], toWorld(event.clientX, event.clientY));
      }
      setDrag({ kind: "none" });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // Only the START of a placement re-subscribes; the id travels in dragRef,
    // so a moving pointer doesn't tear the listeners down and rebuild them.
  }, [addPhotos, drag.kind, toWorld]);

  const onPointerUp = () => {
    const current = dragRef.current;
    if (current.kind === "marquee" && doc) {
      const x1 = Math.min(current.fromX, current.toX);
      const x2 = Math.max(current.fromX, current.toX);
      const y1 = Math.min(current.fromY, current.toY);
      const y2 = Math.max(current.fromY, current.toY);
      const hit = doc.items.filter((item) => {
        const rect = worldRect(item, doc);
        return rect.x < x2 && rect.x + rect.w > x1 && rect.y < y2 && rect.y + rect.h > y1;
      });
      setSelected((previous) => {
        const next = current.additive ? new Set(previous) : new Set<string>();
        hit.forEach((item) => next.add(item.id));
        return next;
      });
    }
    if (current.kind === "resize") {
      // Reshaping the frame changes how much room the picture inside it has to
      // slide; without this a crop set on a wide frame shows a bare corner once
      // the frame is made tall.
      const id = current.origin.id;
      updateItems(
        (list) => list.map((item) => (item.id === id ? clampContent(item, imageAspect(item.image_id)) : item)),
        { history: false }
      );
    }
    if (current.kind === "place") return; // the window listeners finish this one
    setDrag({ kind: "none" });
    setGuides([]);
  };

  const beginPan = (event: React.PointerEvent) => {
    const el = viewportRef.current;
    setDrag({
      kind: "pan",
      startX: event.clientX,
      startY: event.clientY,
      left: el?.scrollLeft ?? 0,
      top: el?.scrollTop ?? 0,
    });
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  };

  const onBackgroundPointerDown = (event: React.PointerEvent) => {
    if (event.button === 1 || event.altKey || panKey) {
      beginPan(event);
      return;
    }
    if (event.button !== 0) return;
    setCroppingId(null);
    setEditingTextId(null);
    const world = toWorld(event.clientX, event.clientY);
    const additive = event.shiftKey || event.metaKey;
    if (!additive) setSelected(new Set());
    setDrag({ kind: "marquee", fromX: world.x, fromY: world.y, toX: world.x, toY: world.y, additive });
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  };

  // Only the two wheel gestures that are NOT scrolling belong to us. Plain
  // scrolling is left to the browser, which is what gives the canvas its
  // scrollbars, its horizontal scrolling and its momentum for free.
  const onWheel = (event: WheelEvent) => {
    // Four ways in, because the obvious two are not reliably ours to take:
    // macOS gives ctrl+scroll to its own screen zoom and an Electron window
    // may take cmd+scroll for the app zoom, so Alt and a held Space are here
    // as modifiers nothing else claims. A trackpad pinch also arrives as
    // ctrl+wheel, which is why that one stays whatever else it means.
    if (event.ctrlKey || event.metaKey || event.altKey || panKey) {
      event.preventDefault();
      zoomAt(Math.exp(-event.deltaY / 300), event.clientX, event.clientY);
      return;
    }
    if (croppingId) {
      // While a frame is open for cropping the wheel belongs to the picture in
      // it, not to the canvas - that is the whole point of the mode.
      const item = items.find((i) => i.id === croppingId);
      if (!item) return;
      event.preventDefault();
      const scale = Math.max(1, Math.min(6, item.content_scale * Math.exp(-event.deltaY / 400)));
      const next = clampContent({ ...item, content_scale: scale }, imageAspect(item.image_id));
      patchItem(croppingId, {
        content_scale: next.content_scale,
        content_dx: next.content_dx,
        content_dy: next.content_dy,
      }, { history: false });
    }
  };

  // React registers wheel handlers passively at the document root, where
  // preventDefault is ignored - which would leave ctrl+wheel zooming the whole
  // window instead of the canvas. Bind it to the viewport ourselves.
  const wheelRef = useRef(onWheel);
  wheelRef.current = onWheel;
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    function handle(event: WheelEvent) {
      wheelRef.current(event);
    }
    node.addEventListener("wheel", handle, { passive: false });
    return () => node.removeEventListener("wheel", handle);
  }, [canvasReady]);

  // --- Keyboard -------------------------------------------------------------

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      // Never steal keys from a text box - including the canvas's own.
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      // The print view has the keyboard while it is up: its Escape closes it,
      // and must not also drop the selection underneath.
      if (printPage !== null) return;
      // Same for the docked photo editor: while it is open the keyboard is
      // its (undo, arrows, Escape) - the canvas underneath must not also
      // undo, nudge frames or step its own Escape ladder.
      if (editingOpenRef.current) return;
      // A focused button still owns Space: hold-to-pan must not stop the
      // toolbar being driven from the keyboard.
      const onButton = target?.tagName === "BUTTON";
      const meta = event.metaKey || event.ctrlKey;
      if (meta && !event.shiftKey && event.key.toLowerCase() === "s") {
        // Mostly a comfort blanket next to the autosave - but on a brand new
        // canvas it is what keeps the seeded layout as it stands.
        event.preventDefault();
        saveNow();
        return;
      }
      if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      // Zoom is on the BARE keys, not on Cmd/Ctrl. Those belong to the window:
      // the app registers them as menu accelerators on macOS and off the
      // renderer's input stream on Windows and Linux, both of which run before
      // the page sees the key - so a Cmd-+ here could only ever zoom the whole
      // program, never the canvas. Bare +/-/0 are nothing else's.
      if (!meta && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        zoomAt(1.2);
        return;
      }
      if (!meta && (event.key === "-" || event.key === "_")) {
        event.preventDefault();
        zoomAt(1 / 1.2);
        return;
      }
      if (!meta && event.key === "0") {
        event.preventDefault();
        fitToView();
        return;
      }
      if (!meta && !event.altKey && (event.key === "p" || event.key === "P")) {
        event.preventDefault();
        openPrint();
        return;
      }
      if (!meta && (event.key === ")" || (event.shiftKey && event.code === "Digit0"))) {
        event.preventDefault();
        fitToView(true);
        return;
      }
      if (event.key === " ") {
        if (onButton) return;
        // Held, not tapped: a canvas that scrolls the page when you reach for
        // the pan gesture is a canvas nobody reaches for twice.
        event.preventDefault();
        setPanKey(true);
        return;
      }
      if (event.key === "Escape") {
        // Step out one level at a time, so Escape out of a crop doesn't also
        // drop the selection the user is still working with. Only with
        // nothing left to step out of does it leave the canvas - the same
        // ladder the lightbox climbs (zoom first, then back).
        if (croppingId) setCroppingId(null);
        else if (editingTextId) setEditingTextId(null);
        else if (selected.size > 0) setSelected(new Set());
        else onExit?.();
        return;
      }
      if (selected.size === 0) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        removeSelected();
        return;
      }
      if (meta && event.key === "]") {
        event.preventDefault();
        restack(event.shiftKey ? "front" : "forward");
        return;
      }
      if (meta && event.key === "[") {
        event.preventDefault();
        restack(event.shiftKey ? "back" : "backward");
        return;
      }
      const nudge: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const step = nudge[event.key];
      if (step) {
        event.preventDefault();
        const distance = event.shiftKey ? 10 : 1;
        updateItems((list) =>
          list.map((item) =>
            selected.has(item.id)
              ? { ...item, x_mm: item.x_mm + step[0] * distance, y_mm: item.y_mm + step[1] * distance }
              : item
          )
        );
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === " ") setPanKey(false);
    }
    // A window that loses focus mid-gesture would otherwise never see the
    // keyup, leaving the canvas stuck in pan mode.
    function onBlur() {
      setPanKey(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [croppingId, editingTextId, fitToView, onExit, openPrint, printPage, redo, removeSelected, restack, saveNow, selected, undo, updateItems, zoomAt]);

  // --- Render ---------------------------------------------------------------

  if (isLoading || !doc) return <div className="empty-state">Loading the canvas…</div>;

  const pages = doc.page_mode === "pages" ? Array.from({ length: pageCount }, (_, i) => i) : [0];
  const endless = doc.page_mode === "infinite";
  // The world element only needs to reach the world's FAR edge. Anything above
  // or left of millimetre zero overflows it, and overflow in those directions
  // is not scrollable anyway - the surface's own slack is what makes that side
  // reachable.
  //
  // Sizing it to the whole world instead pushed its transformed box PAST the
  // right of the scroll surface, which enlarged the scrollable area, which
  // flipped a scrollbar on, which changed the client size that the surface is
  // measured from, which moved the box again. That loop is what "Maximum update
  // depth exceeded" was: zooming kicked it off, and it never settled.
  const worldWidth = Math.max(1, world.x + world.w);
  const worldHeight = Math.max(1, world.y + world.h);
  const selectedItems = items.filter((item) => selected.has(item.id));
  const single = selectedItems.length === 1 ? selectedItems[0] : null;

  // Open the photo editor on a frame's photo - via a virtual copy. The first
  // edit mints the copy (tagged "canvas edit" in the library) and re-points
  // the frame at it; editing again just reopens the same copy. The library
  // original is never touched from here. With the editor already docked,
  // clicking another frame switches it to that photo.
  async function switchEditTo(frame: LayoutItem) {
    if (frame.kind !== "photo" || !frame.image_id) return;
    const image = byId.get(frame.image_id);
    if (!image || (editingImage && image.id === editingImage.id)) return;
    // The old photo's live preview must not flash on the new frame - and the
    // live shape-following starts over from the new photo's own shape.
    liveAspectRef.current = null;
    if (livePreviewRef.current) URL.revokeObjectURL(livePreviewRef.current);
    livePreviewRef.current = null;
    setLivePreviewUrl(null);
    if (image.virtual_of_image_id) {
      setEditingImage(image);
      return;
    }
    try {
      const copy = await api.images.virtualCopy(image.id);
      setExtraFiles((list) => [...list, copy]);
      updateItems((list) =>
        list.map((item) => (item.id === frame.id ? { ...item, image_id: copy.id } : item))
      );
      onMembershipChanged?.();
      setEditingImage(copy);
    } catch (e) {
      void dialogs.alert({
        title: "Could not start the edit",
        message: (e as Error).message || "The virtual copy could not be created.",
      });
    }
  }

  async function editPhoto() {
    if (single) await switchEditTo(single);
  }

  const croppingItem = croppingId ? items.find((item) => item.id === croppingId) ?? null : null;
  // Whether the photo has any room to slide at its current zoom - if it has
  // none, saying "drag it" would simply be untrue.
  const cropRoom = croppingItem
    ? (() => {
        const travel = contentTravel(
          croppingItem.width_mm / croppingItem.height_mm,
          imageAspect(croppingItem.image_id),
          croppingItem.content_scale
        );
        return travel.x > 0.001 || travel.y > 0.001;
      })()
    : false;
  // How many sheets the guide draws: enough to hold everything on the canvas,
  // plus one empty one ahead to carry on into.
  const guideSheets =
    Math.ceil(
      items.reduce((bottom, item) => Math.max(bottom, item.y_mm + item.height_mm), 0) /
        (doc.page_height_mm + PAGE_GAP_MM)
    ) + 1;
  const marquee = drag.kind === "marquee" ? drag : null;
  const placing = drag.kind === "place" ? drag : null;
  // Which sheet is centred right now, for the rail's highlight - straight off
  // the mirrored scroll position, so it follows the scrollbar as it moves.
  const currentPage =
    doc.page_mode === "pages"
      ? pageAtMm(
          (view.top + view.height / 2 - view.offsetY - origin.y) / zoom,
          doc,
          pageCount
        )
      : 0;

  return (
    <div className="canvas-shell">
      <div className="canvas-main">
        <div className="canvas-main-left">
      <CanvasToolbar
        doc={doc}
        commit={commit}
        zoom={zoom}
        onZoom={zoomAt}
        onFit={() => fitToView()}
        onFitAll={() => fitToView(true)}
        onPrint={openPrint}
        canUndo={past.current.length > 0}
        canRedo={future.current.length > 0}
        historyTick={historyTick}
        onUndo={undo}
        onRedo={redo}
        onAddText={addText}
        onFill={fillFromAlbum}
        unplaced={unplaced.length}
        memberCount={images.length}
        title={title}
        onExit={onExit}
        onClear={clearCanvas}
        canClear={items.length > 0}
        saveState={saveState}
        saveFailed={save.isError}
        neverSaved={neverSaved}
        exportChip={<ExportChip doc={doc} byId={byId} title={title} />}
        versionsChip={
          <VersionsChip
            doc={doc}
            commit={commit}
            versions={versions}
            activeVersionId={activeVersionId}
            onKeep={keepVersion}
            onLoad={loadVersion}
            onRename={renameVersion}
            onRemove={removeVersion}
          />
        }
      />

      {/* A second, always-present bar: what is selected and what can be done
          with it. Its own row rather than more buttons in the toolbar, so the
          toolbar never reshuffles under the pointer - and when nothing is
          selected it says how to select something instead of going blank. */}
      <CanvasActionBar
        selection={selectedItems}
        endless={endless}
        cropping={croppingId !== null}
        onRestack={restack}
        onDelete={removeSelected}
        onFitFrame={fitFrameToPhoto}
        onCrop={() => single && single.kind === "photo" && setCroppingId(single.id)}
        onEditPhoto={() => (editingImage ? void closeEditor() : void editPhoto())}
        editingOpen={editingImage !== null}
        onEndCrop={() => setCroppingId(null)}
        onResetCrop={resetCrop}
        onResetRotation={() =>
          updateItems((list) =>
            list.map((item) => (selected.has(item.id) ? { ...item, rotation: 0 } : item))
          )
        }
        aspectLock={aspectLock}
        onAspectLock={setAspectLock}
        onResize={resizeSelected}
        onPhotoStyle={stylePhotos}
        onCopySettings={() => single && copySettings(single)}
        onPasteSettings={pasteSettings}
        // The tick is what re-renders the bar when the clipboard fills.
        pasteable={clipboardTick > 0 ? settingsClipboard.current?.kind ?? null : null}
        onStyle={(style) =>
          updateItems((list) =>
            list.map((item) =>
              selected.has(item.id) && item.kind === "text"
                ? { ...item, style: { ...DEFAULT_TEXT_STYLE, ...item.style, ...style } }
                : item
            )
          )
        }
      />

      {/* The rail and the stage sit side by side: arranging the RUN of pages is
          a different job from arranging one page, and it gets its own column. */}
      <div className="canvas-stage">
        {doc.page_mode === "pages" && (
          <PageRail
            doc={doc}
            pageCount={pageCount}
            current={currentPage}
            byId={byId}
            onGo={goToPage}
            onMove={movePage}
            onAdd={addPage}
            onDuplicate={duplicatePage}
            onRemove={removePage}
          />
        )}
        <div
          className={`canvas-frame${croppingId ? " is-cropping" : ""}`}
          data-canvas-frame

          // On the free canvas the paper is the whole stage, so its colour
          // lives here - behind the grid layer, which the transparent viewport
          // then lets through.
          style={{ background: endless ? doc.background : undefined }}
        >
          {/* The free canvas's grid. Outside the scroll container on purpose:
              it is exactly one screen big and slides its PATTERN, so it adds
              nothing to the scrollable area and needs no measurement of its
              own size. A grid element the size of an endless canvas would in
              any case be unpaintable at high zoom. */}
          {endless && doc.show_grid && (
            <div
              className="canvas-grid-layer"
              style={{
                backgroundSize: `${doc.grid_mm * zoom}px ${doc.grid_mm * zoom}px`,
                backgroundPosition: `${view.offsetX - view.left + origin.x}px ${
                  view.offsetY - view.top + origin.y
                }px`,
                backgroundImage:
                  "linear-gradient(to right, rgba(120,120,120,0.35) 1px, transparent 1px)," +
                  "linear-gradient(to bottom, rgba(120,120,120,0.35) 1px, transparent 1px)",
              }}
            />
          )}
          <div
            className="canvas-viewport"
            ref={viewportRef}
            onScroll={syncView}
            onPointerDown={onBackgroundPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={(event) => {
              // Only a double-click on the canvas ITSELF - one on a photo means
              // "crop this", and that handler has already run.
              if (!endless) return;
              if ((event.target as Element | null)?.closest?.(".canvas-item")) return;
              jumpToWork();
            }}
            style={{
              cursor: drag.kind === "pan" ? "grabbing" : panKey ? "grab" : undefined,
              // The free canvas's colour is painted by the frame behind, so
              // the grid layer in between can show through.
              background: endless ? "transparent" : undefined,
            }}
          >
            {/* The scroll surface is the world at its ON-SCREEN size, so the
                browser sizes and places its scrollbars correctly; the world
                inside it is still drawn in millimetres and scaled onto it. */}
            <div
              className="canvas-scroll"
              ref={scrollRef}
              style={{ width: origin.w, height: origin.h }}
            >
              <div
                className="canvas-world"
                style={{
                  transform: `translate(${origin.x}px, ${origin.y}px) scale(${zoom})`,
                  width: worldWidth,
                  height: worldHeight,
                }}
              >
                {/* Sheets of paper. The FREE canvas has none: its colour is
                    the stage's own, so there is no element here that would have
                    to be as big as the world - and at high zoom such an element
                    is a painted surface hundreds of megapixels across, which the
                    browser gives up rasterising and leaves blank. */}
                {!endless &&
                  pages.map((page) => (
                    <div
                      key={page}
                      className="canvas-page"
                      style={{
                        left: 0,
                        top: pageOffsetMm(page, doc),
                        width: doc.page_width_mm,
                        height: doc.page_height_mm,
                        background: doc.background,
                        boxShadow: `0 ${2 / zoom}px ${8 / zoom}px rgba(0,0,0,0.35)`,
                      }}
                    >
                      {doc.show_grid && (
                        <div
                          className="canvas-grid"
                          style={{
                            backgroundSize: `${doc.grid_mm}px ${doc.grid_mm}px`,
                            // Hairlines: one screen pixel whatever the zoom.
                            backgroundImage:
                              `linear-gradient(to right, rgba(120,120,120,0.35) ${1 / zoom}px, transparent ${1 / zoom}px),` +
                              `linear-gradient(to bottom, rgba(120,120,120,0.35) ${1 / zoom}px, transparent ${1 / zoom}px)`,
                          }}
                        />
                      )}
                      {/* The page margin, as a hairline you lay out against.
                          An editing aid like the grid: never printed, never
                          exported, and gone when the margin is 0. */}
                      {marginOf(doc) > 0 && (
                        <div
                          className="canvas-margin-guide"
                          style={{ inset: marginOf(doc), borderWidth: 1 / zoom }}
                        />
                      )}
                      <span className="canvas-page-number" style={{ fontSize: 5, bottom: -8 }}>
                        {page + 1}
                      </span>
                    </div>
                  ))}

                {/* The sheets this free-canvas design would be cut into. Drawn
                    OVER the work, because it is a measurement, not part of the
                    design - and never interactive. */}
                {endless &&
                  doc.show_page_guide &&
                  Array.from({ length: guideSheets }, (_, page) => (
                    <div
                      key={`guide-${page}`}
                      className="canvas-page-guide"
                      style={{
                        left: 0,
                        top: pageOffsetMm(page, doc),
                        width: doc.page_width_mm,
                        height: doc.page_height_mm,
                        borderWidth: 1 / zoom,
                      }}
                    >
                      <span className="canvas-page-guide-label" style={{ fontSize: 5, top: -7 }}>
                        Page {page + 1}
                      </span>
                    </div>
                  ))}

                {[...items]
                  .sort((a, b) => a.z - b.z)
                  .map((item) => (
                    <CanvasItem
                      key={item.id}
                      item={item}
                      doc={doc}
                      image={item.image_id ? byId.get(item.image_id) ?? null : null}
                      livePreviewUrl={
                        editingImage && item.image_id === editingImage.id ? livePreviewUrl : null
                      }
                      zoom={zoom}
                      selected={selected.has(item.id)}
                      cropping={croppingId === item.id}
                      editing={editingTextId === item.id}
                      onPointerDown={(event) => {
                        if (panKey || event.altKey || event.button === 1) return; // let the viewport pan
                        event.stopPropagation();
                        if (croppingId === item.id) {
                          const world = toWorld(event.clientX, event.clientY);
                          setDrag({ kind: "content", id: item.id, startX: world.x, startY: world.y, origin: item });
                          (event.target as Element).setPointerCapture?.(event.pointerId);
                          return;
                        }
                        beginMove(event, item.id);
                        // The docked editor follows the click: selecting
                        // another photo switches the edit to it.
                        if (editingOpenRef.current && item.kind === "photo") void switchEditTo(item);
                      }}
                      onDoubleClick={() => {
                        if (item.kind === "text") setEditingTextId(item.id);
                        else setCroppingId(item.id);
                      }}
                      onText={(text) => patchItem(item.id, { text })}
                      onEndEdit={() => setEditingTextId(null)}
                    />
                  ))}

                {single && !editingTextId && (
                  <SelectionFrame
                    item={single}
                    doc={doc}
                    zoom={zoom}
                    cropping={croppingId === single.id}
                    onHandle={(event, handle) => {
                      event.stopPropagation();
                      const world = toWorld(event.clientX, event.clientY);
                      setDrag({
                        kind: "resize",
                        handle,
                        startX: world.x,
                        startY: world.y,
                        origin: single,
                        // A photo keeps its shape while the lock is on - that
                        // is the rule, Shift the exception; a caption's box is
                        // free either way and Shift holds it, as before.
                        keepAspect:
                          single.kind === "photo" ? aspectLock !== event.shiftKey : event.shiftKey,
                      });
                      (event.target as Element).setPointerCapture?.(event.pointerId);
                      pushHistory();
                    }}
                    onRotate={(event) => {
                      event.stopPropagation();
                      const rect = worldRect(single, doc);
                      const centerX = rect.x + rect.w / 2;
                      const centerY = rect.y + rect.h / 2;
                      const world = toWorld(event.clientX, event.clientY);
                      setDrag({
                        kind: "rotate",
                        id: single.id,
                        centerX,
                        centerY,
                        startAngle: (Math.atan2(world.y - centerY, world.x - centerX) * 180) / Math.PI,
                        origin: single.rotation,
                      });
                      (event.target as Element).setPointerCapture?.(event.pointerId);
                      pushHistory();
                    }}
                    onResetRotation={() => {
                      // The double-click's own pointerdowns armed rotate drags
                      // - drop the drag so the reset isn't overwritten by a
                      // stray pointer move.
                      setDrag({ kind: "none" });
                      patchItem(single.id, { rotation: 0 });
                    }}
                  />
                )}

                {selectedItems.length > 1 &&
                  selectedItems.map((item) => {
                    const rect = worldRect(item, doc);
                    return (
                      <div
                        key={`sel-${item.id}`}
                        className="canvas-selection-outline"
                        style={{
                          left: rect.x,
                          top: rect.y,
                          width: rect.w,
                          height: rect.h,
                          transform: `rotate(${item.rotation}deg)`,
                          borderWidth: 1 / zoom,
                        }}
                      />
                    );
                  })}

                {guides.map((guide, index) => (
                  <div
                    key={index}
                    className="canvas-guide"
                    style={
                      guide.axis === "x"
                        ? {
                            left: guide.at,
                            top: guide.from,
                            height: guide.to - guide.from,
                            width: 1 / zoom,
                          }
                        : {
                            top: guide.at,
                            left: guide.from,
                            width: guide.to - guide.from,
                            height: 1 / zoom,
                          }
                    }
                  />
                ))}

                {marquee && (
                  <div
                    className="canvas-marquee"
                    style={{
                      left: Math.min(marquee.fromX, marquee.toX),
                      top: Math.min(marquee.fromY, marquee.toY),
                      width: Math.abs(marquee.toX - marquee.fromX),
                      height: Math.abs(marquee.toY - marquee.fromY),
                      borderWidth: 1 / zoom,
                    }}
                  />
                )}

                {placing && (
                  <div
                    className="canvas-drop-ghost"
                    style={{
                      left: placing.x - doc.page_width_mm / 6,
                      top: placing.y - doc.page_width_mm / 9,
                      width: doc.page_width_mm / 3,
                      height: doc.page_width_mm / 4.5,
                      borderWidth: 1 / zoom,
                    }}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Cropping changes what dragging and scrolling do, so it says so. A
              mode you can't see you are in is the canvas's easiest way to feel
              broken. */}
          {croppingItem && (
            <div className="canvas-mode-banner">
              <IconCrop size={14} />
              <span>
                <strong>Moving the photo inside its frame.</strong>{" "}
                {cropRoom
                  ? "Drag it to choose what shows. The frame stays where it is."
                  : "It fills the frame exactly, so zoom it in to give it room to move."}
              </span>
              <label className="canvas-crop-zoom" title="How far into the photo the frame is cropped">
                Zoom
                <input
                  type="range"
                  min={1}
                  max={6}
                  step={0.02}
                  value={croppingItem.content_scale}
                  onChange={(event) => setCropScale(Number(event.target.value))}
                />
                {croppingItem.content_scale.toFixed(1)}×
              </label>
              <button className="btn btn-sm" onClick={resetCrop} title="Centre the photo again at full size">
                Reset
              </button>
              <button className="btn btn-sm primary" onClick={() => setCroppingId(null)}>
                Done
              </button>
            </div>
          )}

          {panKey && !croppingItem && (
            <div className="canvas-mode-banner canvas-mode-banner--quiet">
              Drag anywhere to move the view · scroll to zoom
            </div>
          )}
        </div>
      </div>

      <Filmstrip
        images={stripImages}
        loading={imagesLoading}
        placed={placedShots}
        backButton={
          onExit && (
            <button
              className="btn btn-sm back-btn"
              onClick={onExit}
              title="Back to your canvases (Esc)"
            >
              <IconArrowLeft size={14} /> Back
            </button>
          )
        }
        open={showFilmstrip}
        onToggle={() => setShowFilmstrip((open) => !open)}
        onAdd={(id) => addPhotos([id])}
        onDragStart={(event, id) => {
          const world = toWorld(event.clientX, event.clientY);
          setDrag({ kind: "place", imageId: id, x: world.x, y: world.y });
        }}
      />
        </div>
        {/* Editing docks as the row's right column, top to bottom of the
            window: it pushes everything left, the filmstrip included. */}
        {editingImage && (
          <PhotoEditor
            key={editingImage.id}
            docked
            image={editingImage}
            onClose={() => void closeEditor()}
            onPreviewFrame={onPreviewFrame}
            onAutoSaved={refreshEditedFile}
          />
        )}
      </div>

      {printPage !== null &&
        createPortal(
          <PrintView doc={doc} byId={byId} pageCount={pageCount} start={printPage} title={title} onClose={() => setPrintPage(null)} />,
          document.body
        )}
    </div>
  );
}

// --- The print view ---------------------------------------------------------
//
// The layout with everything that is not the layout taken away: no toolbar,
// no rail, no grid, no handles - one sheet at a time, as big as the window
// allows, on a dark ground. It is for LOOKING, so it does nothing else: the
// arrow keys turn the pages and Escape brings the canvas back.

interface PrintSheet {
  // The sheet's rectangle in world millimetres, and what is drawn on it.
  x: number;
  y: number;
  w: number;
  h: number;
  items: LayoutItem[];
}

// What "a sheet" is depends on the kind of canvas: a page of a paged layout;
// a sheet of the page guide on a free canvas that has one; and otherwise the
// free canvas cut to the work on it, with a little margin, since a boundless
// sheet cannot be shown whole.
function printSheets(doc: Doc, pageCount: number): PrintSheet[] {
  const w = doc.page_width_mm;
  const h = doc.page_height_mm;
  if (doc.page_mode === "pages") {
    return Array.from({ length: pageCount }, (_, page) => ({
      x: 0,
      y: pageOffsetMm(page, doc),
      w,
      h,
      items: doc.items.filter((item) => item.page === page),
    }));
  }
  const box = boundsOf(doc.items.map((item) => worldRect(item, doc)));
  if (doc.show_page_guide) {
    // The same count the guide draws, minus the empty sheet it keeps ahead.
    const sheets = box ? Math.max(1, Math.ceil((box.y + box.h) / (h + PAGE_GAP_MM))) : 1;
    return Array.from({ length: sheets }, (_, page) => ({
      x: 0,
      y: pageOffsetMm(page, doc),
      w,
      h,
      items: doc.items,
    }));
  }
  if (!box) return [{ x: 0, y: 0, w, h, items: [] }];
  const margin = 10;
  return [{ x: box.x - margin, y: box.y - margin, w: box.w + margin * 2, h: box.h + margin * 2, items: doc.items }];
}

// Room kept around the sheet: the arrows live in the side bands, the page
// count in the bottom one.
const PRINT_PAD_X = 84;
const PRINT_PAD_Y = 64;
const PRINT_IDLE_MS = 2200;

function PrintView({
  doc,
  byId,
  pageCount,
  start,
  title,
  onClose,
}: {
  doc: Doc;
  byId: Map<string, ImageOut>;
  pageCount: number;
  start: number;
  title: string;
  onClose: () => void;
}) {
  const sheets = useMemo(() => printSheets(doc, pageCount), [doc, pageCount]);
  const [index, setIndex] = useState(() => Math.max(0, Math.min(sheets.length - 1, start)));
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  // The controls fade once the pointer has settled, so a page can be looked at
  // with nothing at all around it; any movement brings them back.
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | null>(null);
  // A closer look at the sheet: the wheel zooms about the cursor, a drag
  // moves the page under it. In multiples of FIT - 1 is the whole sheet in
  // the window, which is also what every page opens at and what a page turn
  // returns to. x/y displace the sheet's centre, in screen pixels.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [look, setLook] = useState({ scale: 1, x: 0, y: 0 });
  const lookRef = useRef(look);
  lookRef.current = look;
  const pan = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const [panning, setPanning] = useState(false);

  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), PRINT_IDLE_MS);
  }, []);

  useEffect(() => {
    wake();
    return () => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    };
  }, [wake]);

  useEffect(() => {
    function onResize() {
      setSize({ w: window.innerWidth, h: window.innerHeight });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const last = sheets.length - 1;
  const go = useCallback(
    (to: number) => {
      setIndex(Math.max(0, Math.min(last, to)));
      wake();
    },
    [last, wake]
  );

  // Every page opens at fit: a zoom is an inspection of THIS page, not a
  // setting to carry to the next.
  useEffect(() => {
    setLook({ scale: 1, x: 0, y: 0 });
  }, [index]);

  // The wheel zooms about the cursor: the spot under the pointer stays under
  // the pointer. Bound by hand because React registers wheel handlers
  // passively, and a passive handler cannot preventDefault.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const from = lookRef.current;
      const scale = Math.max(1, Math.min(10, from.scale * Math.exp(-event.deltaY * 0.0022)));
      if (scale === from.scale) return;
      if (scale === 1) {
        // Back at fit, the sheet also comes back to the middle - a fit-sized
        // page left half off-screen only looks broken.
        setLook({ scale: 1, x: 0, y: 0 });
      } else {
        const cx = event.clientX - window.innerWidth / 2;
        const cy = event.clientY - window.innerHeight / 2;
        const ratio = scale / from.scale;
        setLook({ scale, x: cx - (cx - from.x) * ratio, y: cy - (cy - from.y) * ratio });
      }
      wake();
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [wake]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          onClose();
          return;
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
        case " ":
          event.preventDefault();
          go(index + 1);
          return;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          event.preventDefault();
          go(index - 1);
          return;
        case "Home":
          event.preventDefault();
          go(0);
          return;
        case "End":
          event.preventDefault();
          go(last);
          return;
        case "0":
          event.preventDefault();
          setLook({ scale: 1, x: 0, y: 0 });
          return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go, index, last, onClose]);

  // Fetch the neighbouring sheets' photos ahead of time, so turning a page
  // shows a page and not a page filling in.
  useEffect(() => {
    for (const near of [index + 1, index - 1]) {
      const sheet = sheets[near];
      if (!sheet) continue;
      for (const item of sheet.items) {
        const image = item.image_id ? byId.get(item.image_id) : null;
        if (image) new Image().src = api.images.previewUrl(image.id, editVersion(image));
      }
    }
  }, [byId, index, sheets]);

  const sheet = sheets[index] ?? sheets[0];
  const zoom = Math.max(
    0.01,
    Math.min((size.w - PRINT_PAD_X * 2) / sheet.w, (size.h - PRINT_PAD_Y * 2) / sheet.h)
  );

  return (
    <div
      ref={boxRef}
      className={`canvas-print${idle ? " is-idle" : ""}${panning ? " is-panning" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Print view"
      onPointerDown={(event) => {
        wake();
        if (event.button !== 0) return;
        if ((event.target as Element).closest("button")) return;
        pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
        setPanning(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        wake();
        const start = pan.current;
        if (!start || start.id !== event.pointerId) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (!dx && !dy) return;
        pan.current = { id: start.id, x: event.clientX, y: event.clientY, moved: true };
        setLook((from) => ({ ...from, x: from.x + dx, y: from.y + dy }));
      }}
      onPointerUp={() => {
        pan.current = null;
        setPanning(false);
      }}
      onPointerCancel={() => {
        pan.current = null;
        setPanning(false);
      }}
      onDoubleClick={(event) => {
        // The lightbox's gesture: in for a closer look, back out to the whole
        // page - about the point that was double-clicked.
        if ((event.target as Element).closest("button")) return;
        const from = lookRef.current;
        if (from.scale > 1) {
          setLook({ scale: 1, x: 0, y: 0 });
        } else {
          const scale = 2.5;
          const cx = event.clientX - window.innerWidth / 2;
          const cy = event.clientY - window.innerHeight / 2;
          setLook({ scale, x: cx - (cx - from.x) * scale, y: cy - (cy - from.y) * scale });
        }
        wake();
      }}
    >
      <div
        className="canvas-print-sheet"
        style={{
          width: sheet.w * zoom,
          height: sheet.h * zoom,
          background: doc.background,
          transform: `translate(${look.x}px, ${look.y}px) scale(${look.scale})`,
        }}
      >
        <div
          className="canvas-world"
          style={{
            transform: `translate(${-sheet.x * zoom}px, ${-sheet.y * zoom}px) scale(${zoom})`,
            width: Math.max(1, sheet.x + sheet.w),
            height: Math.max(1, sheet.y + sheet.h),
          }}
        >
          {[...sheet.items]
            .sort((a, b) => a.z - b.z)
            .map((item) => (
              <CanvasItem
                key={item.id}
                item={item}
                doc={doc}
                image={item.image_id ? byId.get(item.image_id) ?? null : null}
                zoom={zoom}
                selected={false}
                cropping={false}
                editing={false}
                print
                onPointerDown={() => {}}
                onDoubleClick={() => {}}
                onText={() => {}}
                onEndEdit={() => {}}
              />
            ))}
        </div>
      </div>

      {sheets.length > 1 && (
        <>
          <button
            className="lightbox-nav-btn lightbox-nav-prev canvas-print-chrome"
            onClick={() => go(index - 1)}
            disabled={index === 0}
            aria-label="Previous page"
            title="Previous page (←)"
          >
            <IconChevronLeft size={20} />
          </button>
          <button
            className="lightbox-nav-btn lightbox-nav-next canvas-print-chrome"
            onClick={() => go(index + 1)}
            disabled={index === last}
            aria-label="Next page"
            title="Next page (→)"
          >
            <IconChevronRight size={20} />
          </button>
        </>
      )}

      {/* Same bottom bar as the shelf's print view (and the photo stages):
          the standard Back flush left, the caption centred, Export flush
          right. */}
      <div className="canvas-print-foot canvas-print-chrome" aria-live="polite">
        <button
          className="btn btn-sm back-btn stage-back-btn"
          onClick={onClose}
          title="Back to the canvas (Escape)"
        >
          <IconArrowLeft size={13} /> Back
        </button>
        {sheets.length > 1 ? `Page ${index + 1} of ${sheets.length}` : "Print view"}
        <span className="canvas-print-hint">Scroll to zoom · drag to move · Esc to come back</span>
        <span className="canvas-print-export">
          <ExportChip doc={doc} byId={byId} title={title} drop="up" />
        </span>
      </div>
    </div>
  );
}

// --- The run of pages -------------------------------------------------------
//
// The canvas edits ONE page at a time; this rail is where the book is put in
// order. A page has no record of its own - it is only the number its items
// carry - so everything here is a renumbering, and the miniature is drawn from
// the same items the stage draws, at a hundredth of the size.

// Keep in step with .page-rail-list's gap.
const RAIL_GAP_PX = 8;

function PageRail({
  doc,
  pageCount,
  current,
  byId,
  onGo,
  onMove,
  onAdd,
  onDuplicate,
  onRemove,
}: {
  doc: Doc;
  pageCount: number;
  current: number;
  byId: Map<string, ImageOut>;
  onGo: (page: number) => void;
  onMove: (from: number, to: number) => void;
  onAdd: (after: number) => void;
  onDuplicate: (page: number) => void;
  onRemove: (page: number) => void;
}) {
  // Which card is being carried, and where it would land. `over` is an
  // insertion point BETWEEN cards, so it can also mean "after the last one".
  const [carrying, setCarrying] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  // How far the carried card has travelled from where it was picked up, so it
  // rides under the pointer instead of staying put while a line moves.
  const [travel, setTravel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // The gesture's own state, kept in refs: the window listeners below read it
  // while it changes, and a page must be moved exactly once however often
  // React chooses to re-run a render.
  const press = useRef<{ page: number; y: number } | null>(null);
  const carryRef = useRef<number | null>(null);
  const overRef = useRef<number | null>(null);
  const dragged = useRef(false);

  const pages = Array.from({ length: pageCount }, (_, i) => i);
  // How far a card steps aside: the carried card's own height plus the gap
  // between cards, measured because a card can be any height.
  const stride =
    carrying !== null
      ? (listRef.current?.querySelector<HTMLElement>(`[data-page="${carrying}"]`)?.offsetHeight ?? 0) +
        RAIL_GAP_PX
      : 0;

  // The gap the pointer is nearest, found from the cards themselves rather
  // than from arithmetic on a fixed card height - the rail scrolls, and a card
  // can be any height once the page shape changes.
  function slotAt(clientY: number): number {
    const cards = listRef.current?.querySelectorAll("[data-page]");
    if (!cards || cards.length === 0) return 0;
    for (let i = 0; i < cards.length; i++) {
      const box = cards[i].getBoundingClientRect();
      if (clientY < box.top + box.height / 2) return i;
    }
    return cards.length;
  }

  useEffect(() => {
    function onMoveEvent(event: PointerEvent) {
      const start = press.current;
      if (!start) return;
      // A few pixels of slack, so a click on a card stays a click and the
      // drop line doesn't flash up every time someone jumps to a page.
      if (carryRef.current === null) {
        if (Math.abs(event.clientY - start.y) < 5) return;
        carryRef.current = start.page;
        dragged.current = true;
        setCarrying(start.page);
      }
      const slot = slotAt(event.clientY);
      overRef.current = slot;
      setOver(slot);
      setTravel(event.clientY - start.y);
    }
    function onUp() {
      const from = carryRef.current;
      const slot = overRef.current;
      press.current = null;
      carryRef.current = null;
      overRef.current = null;
      setCarrying(null);
      setOver(null);
      setTravel(0);
      // The slot counts gaps in the list as it stands, so a card dropped below
      // itself lands one place higher once it has been lifted out.
      if (from !== null && slot !== null) onMove(from, slot > from ? slot - 1 : slot);
    }
    window.addEventListener("pointermove", onMoveEvent);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMoveEvent);
      window.removeEventListener("pointerup", onUp);
    };
  }, [onMove]);

  return (
    <div className={`page-rail${carrying !== null ? " is-dragging" : ""}`} aria-label="Pages">
      <div className="page-rail-head">
        Pages
        <span className="page-rail-hint">Drag to reorder</span>
      </div>

      <div className="page-rail-list" ref={listRef}>
        {pages.map((page) => {
          // While a card is carried the others step aside to open its
          // landing place, the way a list reorders anywhere else - the gap IS
          // the drop indicator, so there is nothing else to draw.
          let shift = 0;
          if (carrying !== null && over !== null && page !== carrying) {
            if (carrying < page && page < over) shift = -stride;
            else if (over <= page && page < carrying) shift = stride;
          }
          const ghost = carrying === page;
          return (
          <div key={page} data-page={page} className="page-rail-slot">
            <div
              className={`page-card${page === current ? " is-current" : ""}${ghost ? " is-carrying" : ""}`}
              style={
                ghost
                  ? { transform: `translateY(${travel}px) scale(1.03)` }
                  : shift
                    ? { transform: `translateY(${shift}px)` }
                    : undefined
              }
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                dragged.current = false;
                press.current = { page, y: event.clientY };
              }}
              // A press that never turned into a drag is a plain click, and a
              // click on a page means "show me that page".
              onClick={() => {
                if (!dragged.current) onGo(page);
              }}
              title={`Page ${page + 1}`}
            >
              <div
                className="page-card-paper"
                style={{
                  background: doc.background,
                  aspectRatio: `${doc.page_width_mm} / ${doc.page_height_mm}`,
                }}
              >
                {doc.items
                  .filter((item) => item.page === page)
                  .sort((a, b) => a.z - b.z)
                  .map((item) => {
                    const box: React.CSSProperties = {
                      left: `${(item.x_mm / doc.page_width_mm) * 100}%`,
                      top: `${(item.y_mm / doc.page_height_mm) * 100}%`,
                      width: `${(item.width_mm / doc.page_width_mm) * 100}%`,
                      height: `${(item.height_mm / doc.page_height_mm) * 100}%`,
                      transform: `rotate(${item.rotation}deg)`,
                    };
                    const image = item.image_id ? byId.get(item.image_id) : null;
                    if (item.kind === "text" || !image) {
                      return <span key={item.id} className="page-card-mark" style={box} />;
                    }
                    return (
                      <img
                        key={item.id}
                        className="page-card-photo"
                        style={box}
                        src={api.images.thumbnailUrl(image.id, editVersion(image), "small")}
                        alt=""
                        draggable={false}
                      />
                    );
                  })}
              </div>
              {/* The number and, on hover, the page's two actions - in a row
                  UNDER the miniature, never over it: the picture of the page
                  is the point of the card. */}
              <div className="page-card-foot">
                <span className="page-card-number">{page + 1}</span>
                <span className="page-card-tools">
                  <button
                    className="page-card-tool"
                    title="Duplicate this page and everything on it"
                    aria-label="Duplicate page"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDuplicate(page);
                    }}
                  >
                    <IconDuplicate size={13} />
                  </button>
                  <button
                    className="page-card-tool is-danger"
                    title={
                      pageCount === 1
                        ? "Take everything off this page"
                        : "Delete this page and everything on it"
                    }
                    aria-label="Delete page"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemove(page);
                    }}
                  >
                    <IconTrash size={13} />
                  </button>
                </span>
              </div>
            </div>
          </div>
          );
        })}
      </div>

      <button className="btn btn-sm page-rail-add" onClick={() => onAdd(pageCount - 1)} title="Add a page at the end">
        <IconPlus size={12} /> Add a page
      </button>
    </div>
  );
}

// --- One placed item --------------------------------------------------------

function CanvasItem({
  item,
  doc,
  image,
  livePreviewUrl = null,
  zoom,
  selected,
  cropping,
  editing,
  onPointerDown,
  onDoubleClick,
  onText,
  onEndEdit,
  print = false,
}: {
  item: LayoutItem;
  doc: Doc;
  image: ImageOut | null;
  // While this frame's photo is open in the docked editor: the newest preview
  // frame, shown instead of the cached thumbnail - the edit happens IN the page.
  livePreviewUrl?: string | null;
  zoom: number;
  selected: boolean;
  cropping: boolean;
  editing: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onDoubleClick: () => void;
  onText: (text: string) => void;
  onEndEdit: () => void;
  // In the print view the frame can be as big as the window, so it takes the
  // sharper preview rather than the thumbnail the editing canvas gets by with.
  print?: boolean;
}) {
  const rect = worldRect(item, doc);
  const style: React.CSSProperties = {
    left: rect.x,
    top: rect.y,
    width: rect.w,
    height: rect.h,
    transform: `rotate(${item.rotation}deg)`,
    zIndex: 10 + item.z,
  };

  if (item.kind === "text") {
    const textStyle = textCss(item.style);
    return (
      <div
        className={`canvas-item canvas-item--text${selected ? " is-selected" : ""}`}
        style={{ ...style, alignItems: VALIGN_CSS[item.style?.valign ?? "top"] }}
        onPointerDown={editing ? undefined : onPointerDown}
        onDoubleClick={onDoubleClick}
      >
        {editing ? (
          <textarea
            className="canvas-text-input"
            style={textStyle}
            autoFocus
            value={item.text ?? ""}
            onChange={(event) => onText(event.target.value)}
            onBlur={onEndEdit}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") onEndEdit();
            }}
          />
        ) : item.text ? (
          <div className="canvas-text" style={textStyle}>
            {item.text}
          </div>
        ) : (
          // An empty caption must never be an invisible box: it shows where it
          // sits and says how to fill it.
          <div className="canvas-text canvas-text--empty" style={{ ...textStyle, color: undefined }}>
            Double-click to write
          </div>
        )}
      </div>
    );
  }

  // The photo covers its frame and is then zoomed and shifted inside it, so a
  // frame of any shape shows an uncropped-looking picture and never a squashed
  // one. translate comes first so a drag moves the content by exactly the
  // distance the pointer moved, whatever the zoom.
  const contentTransform = `translate(${item.content_dx * 100}%, ${item.content_dy * 100}%) scale(${item.content_scale})`;
  // The border is a shadow with spread rather than a CSS border: it sits
  // OUTSIDE the frame, so turning it on adds to the picture instead of eating
  // into it - and the frame's own box, which is what snaps and is dragged,
  // stays the photo's.
  const border = frameMm(item);

  return (
    <div
      className={`canvas-item canvas-item--photo${selected ? " is-selected" : ""}${cropping ? " is-cropping" : ""}`}
      style={
        border > 0
          ? {
              ...style,
              boxShadow: `0 0 0 ${border}px ${item.style?.frame_color ?? "#ffffff"}`,
              // The box behind the photo wears the frame's own colour: the
              // picture is clipped to the box while the frame is rasterised
              // outside it, and at fractional zooms a sub-pixel sliver of the
              // box peeks out between them - showing the page through the
              // box's near-transparent default as a hairline. In frame colour
              // the sliver IS frame, and there is no line.
              backgroundColor: item.style?.frame_color ?? "#ffffff",
            }
          : style
      }
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    >
      {image ? (
        <img
          className="canvas-photo"
          src={
            livePreviewUrl ??
            (print
              ? api.images.previewUrl(image.id, editVersion(image))
              : api.images.thumbnailUrl(image.id, editVersion(image)))
          }
          alt=""
          draggable={false}
          style={{ transform: contentTransform }}
        />
      ) : (
        <div className="canvas-photo-missing" style={{ fontSize: 4 }}>
          {item.missing
            ? "Photo deleted"
            : item.available === false
              ? "Photo in the Trash"
              : "Photo unavailable"}
        </div>
      )}
      {cropping && <div className="canvas-crop-hint" style={{ borderWidth: 2 / zoom }} />}
    </div>
  );
}

// --- Selection frame, handles and rotation ----------------------------------

function SelectionFrame({
  item,
  doc,
  zoom,
  cropping,
  onHandle,
  onRotate,
  onResetRotation,
}: {
  item: LayoutItem;
  doc: Doc;
  zoom: number;
  cropping: boolean;
  onHandle: (event: React.PointerEvent, handle: Handle) => void;
  onRotate: (event: React.PointerEvent) => void;
  onResetRotation: () => void;
}) {
  const rect = worldRect(item, doc);
  const size = HANDLE_PX / zoom;
  return (
    <div
      className="canvas-selection"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        transform: `rotate(${item.rotation}deg)`,
        borderWidth: 1.5 / zoom,
        zIndex: 5000,
      }}
    >
      {!cropping && (
        <>
          {HANDLES.map((handle) => (
            <div
              key={handle.key}
              className="canvas-handle"
              style={{
                left: `calc(${handle.cx * 100}% - ${size / 2}px)`,
                top: `calc(${handle.cy * 100}% - ${size / 2}px)`,
                width: size,
                height: size,
                borderWidth: 1 / zoom,
                cursor: handle.cursor,
              }}
              onPointerDown={(event) => onHandle(event, handle.key)}
            />
          ))}
          <div
            className="canvas-rotate-handle"
            style={{
              left: `calc(50% - ${size / 2}px)`,
              top: -size * 2.2,
              width: size,
              height: size,
              borderWidth: 1 / zoom,
            }}
            onPointerDown={onRotate}
            onDoubleClick={(event) => {
              // The handle is the one place a rotation is made, so it is also
              // where it's unmade - dragging back to exactly 0° by hand is
              // the one angle the handle is bad at.
              event.stopPropagation();
              onResetRotation();
            }}
            title="Drag to rotate — hold Shift for 15° steps · double-click to straighten (0°)"
          />
        </>
      )}
    </div>
  );
}

// --- Kept versions ----------------------------------------------------------
//
// The chip where a canvas worth keeping gets a name. It also holds the
// "Canvases shelf" switch: the Albums page shows, per opted-in canvas, the one
// version last kept or last loaded here - never the autosaving working draft.

function versionDate(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function VersionsChip({
  doc,
  commit,
  versions,
  activeVersionId,
  onKeep,
  onLoad,
  onRename,
  onRemove,
}: {
  doc: Doc;
  commit: (next: Doc | ((current: Doc) => Doc), options?: { history?: boolean }) => void;
  versions: LayoutVersion[];
  activeVersionId: string | null;
  onKeep: (name: string) => Promise<void>;
  onLoad: (id: string, name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onRemove: (id: string, name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // The one version whose name is open for editing, and the text in the box.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  async function keep() {
    if (busy) return;
    setBusy(true);
    await onKeep(name.trim());
    setBusy(false);
    setName("");
  }

  async function finishRename(id: string) {
    const next = draft.trim();
    setRenamingId(null);
    if (next) await onRename(id, next);
  }

  return (
    <FilterChip
      label={versions.length ? `Versions: ${versions.length}` : "Versions"}
      active={doc.show_in_canvases}
      title="Keep the canvas as a named version, load one back, and choose what the Canvas Shelf shows"
    >
      <div className="canvas-panel">
        <form
          className="canvas-panel-row"
          onSubmit={(event) => {
            event.preventDefault();
            keep();
          }}
        >
          <span className="canvas-panel-label">Keep the canvas as it is now</span>
          <div className="canvas-version-keep">
            <input
              type="text"
              placeholder={`Version ${versions.length + 1}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <button className="btn btn-sm primary" type="submit" disabled={busy}>
              Keep version
            </button>
          </div>
          <span className="canvas-panel-note">
            A version is a frozen copy - keep editing and it stays as it was.
          </span>
        </form>

        {versions.length > 0 && (
          <div className="canvas-panel-row canvas-version-list" role="list">
            {versions.map((version) =>
              renamingId === version.id ? (
                <form
                  key={version.id}
                  className="canvas-version"
                  onSubmit={(event) => {
                    event.preventDefault();
                    finishRename(version.id);
                  }}
                >
                  <input
                    type="text"
                    className="canvas-version-rename"
                    value={draft}
                    autoFocus
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => finishRename(version.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        setRenamingId(null);
                      }
                    }}
                  />
                </form>
              ) : (
                <div
                  key={version.id}
                  role="listitem"
                  className={`canvas-version${version.id === activeVersionId ? " is-active" : ""}`}
                >
                  <span
                    className="canvas-version-name"
                    title={
                      version.id === activeVersionId
                        ? `“${version.name}” is what the Canvas Shelf shows`
                        : version.name
                    }
                  >
                    {version.name}
                  </span>
                  <span className="canvas-version-date">{versionDate(version.created_at)}</span>
                  <button
                    className="btn btn-sm"
                    onClick={() => onLoad(version.id, version.name)}
                    title="Put this version back on the canvas"
                  >
                    Load
                  </button>
                  <button
                    className="canvas-version-tool"
                    title="Rename this version"
                    aria-label={`Rename version ${version.name}`}
                    onClick={() => {
                      setDraft(version.name);
                      setRenamingId(version.id);
                    }}
                  >
                    <IconPencil size={12} />
                  </button>
                  <button
                    className="canvas-version-tool is-danger"
                    title="Forget this version (the canvas itself is untouched)"
                    aria-label={`Delete version ${version.name}`}
                    onClick={() => onRemove(version.id, version.name)}
                  >
                    <IconX size={12} />
                  </button>
                </div>
              )
            )}
          </div>
        )}

        <label className="canvas-panel-row canvas-panel-row--last">
          <span className="canvas-panel-label">Canvas Shelf</span>
          <input
            type="checkbox"
            checked={doc.show_in_canvases}
            disabled={versions.length === 0 && !doc.show_in_canvases}
            onChange={(event) =>
              commit((c) => ({ ...c, show_in_canvases: event.target.checked }), { history: false })
            }
          />
          <span className="canvas-panel-note">
            {versions.length === 0
              ? "Show this canvas on the Canvas Shelf of the Albums page. Keep a version first - the shelf shows kept versions, never the working draft."
              : "Show this canvas on the Canvas Shelf of the Albums page. The shelf shows the version marked with a dot - the one last kept or loaded."}
          </span>
        </label>
      </div>
    </FilterChip>
  );
}

// --- Toolbar ----------------------------------------------------------------
//
// Two bars, and the split is the point. The top one only ever holds things
// that are always available - add, set up the paper, navigate, undo - so it
// never changes shape while the user works. Everything that depends on what is
// selected lives in the bar below it (CanvasActionBar), where it can appear and
// disappear without moving a single button the user was reaching for.

function CanvasToolbar({
  doc,
  commit,
  zoom,
  onZoom,
  onFit,
  onFitAll,
  onPrint,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onAddText,
  onFill,
  unplaced,
  memberCount,
  title,
  onExit,
  onClear,
  canClear,
  saveState,
  saveFailed,
  neverSaved,
  exportChip,
  versionsChip,
}: {
  title: string;
  onExit?: () => void;
  doc: Doc;
  commit: (next: Doc | ((current: Doc) => Doc), options?: { history?: boolean }) => void;
  zoom: number;
  onZoom: (factor: number) => void;
  onFit: () => void;
  onFitAll: () => void;
  onPrint: () => void;
  canUndo: boolean;
  canRedo: boolean;
  historyTick: number;
  onUndo: () => void;
  onRedo: () => void;
  onAddText: () => void;
  onFill: () => void;
  unplaced: number;
  memberCount: number;
  onClear: () => void;
  canClear: boolean;
  saveState: "idle" | "dirty" | "saving" | "saved";
  saveFailed: boolean;
  neverSaved: boolean;
  exportChip: React.ReactNode;
  versionsChip: React.ReactNode;
}) {
  const presetKey =
    PAGE_PRESETS.find((p) => p.w === doc.page_width_mm && p.h === doc.page_height_mm)?.key ?? "custom";
  const presetLabel =
    PAGE_PRESETS.find((p) => p.key === presetKey)?.label ??
    `${Math.round(doc.page_width_mm)}×${Math.round(doc.page_height_mm)} mm`;

  // Everything the old "Paper" popover held sits IN the bar now, as icons with
  // their explanations in the tooltips: nothing to open before you can read or
  // change what the canvas is. Toggles carry aria-pressed + the is-on tint;
  // anything destructive keeps its confirm dialog behind the icon.
  return (
    <div className="filter-bar canvas-toolbar">
      <div className="control-group">
        <span className="canvas-title" title={title}>
          {title}
        </span>
      </div>

      <div className="control-group">
        <button
          className="btn btn-sm canvas-tool"
          onClick={onFill}
          disabled={unplaced === 0}
          aria-label={unplaced === 0 ? "All photos placed" : `Place ${unplaced} photo${unplaced === 1 ? "" : "s"}`}
          title={
            unplaced === 0
              ? memberCount === 0
                ? "This canvas has no photos yet - add some from the library's Select mode"
                : "Every photo of this canvas is already placed"
              : `Place ${unplaced} photo${unplaced === 1 ? "" : "s"}: flow the canvas's photos that aren't placed yet into a grid after what you have`
          }
        >
          <IconImage size={15} />
          {unplaced > 0 && <span className="canvas-tool-badge">{unplaced}</span>}
        </button>
        <button
          className="btn btn-sm canvas-tool"
          onClick={onAddText}
          aria-label="Add text"
          title="Add text: put a caption or a title on the page"
        >
          <IconTextT size={15} />
        </button>
      </div>

      <div className="control-group">
        <span className="segmented segmented--icons" role="group" aria-label="Canvas kind">
          <button
            className={doc.page_mode === "pages" ? "active" : ""}
            onClick={() => commit(toPages)}
            aria-label="Pages"
            aria-pressed={doc.page_mode === "pages"}
            title="Pages: a run of sheets of a fixed size, like a photo book. Photos stay inside the page; the rail on the left adds, copies and reorders pages."
          >
            <IconSheets size={15} />
          </button>
          <button
            className={doc.page_mode === "infinite" ? "active" : ""}
            onClick={() => commit(toFreeCanvas)}
            aria-label="Free canvas"
            aria-pressed={doc.page_mode === "infinite"}
            title="Free canvas: one endless sheet with no edges. Every page is merged into the first."
          >
            <IconInfinity size={15} />
          </button>
        </span>
        {/* The free canvas has no page, so a page size means nothing there -
            the picker only appears when a sheet exists to size: real pages,
            or the page guide drawn over the free canvas. */}
        {/* One chip for everything the page IS - preset, exact size, margin -
            so the bar carries a single readable label instead of a run of
            fields. The closed chip names the current size. */}
        {(doc.page_mode === "pages" || doc.show_page_guide) && (
          <FilterChip
            label={presetLabel}
            title={
              doc.page_mode === "pages"
                ? "Page setup: size and margin"
                : "Page guide setup: size and margin"
            }
          >
            <div className="canvas-panel">
              <div className="canvas-panel-row">
                <span className="canvas-panel-label">Size</span>
                <select
                  className="canvas-size-select"
                  value={presetKey}
                  aria-label={doc.page_mode === "pages" ? "Page size" : "Guide size"}
                  onChange={(event) => {
                    const next = PAGE_PRESETS.find((p) => p.key === event.target.value);
                    if (next) commit((c) => ({ ...c, page_width_mm: next.w, page_height_mm: next.h }));
                  }}
                >
                  {presetKey === "custom" && <option value="custom">Custom ({presetLabel})</option>}
                  {PAGE_PRESETS.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              {/* Typing a size IS choosing custom - no mode to switch first;
                  the select above simply reads "Custom" while the numbers
                  match no preset. */}
              <div className="canvas-panel-row">
                <span className="canvas-panel-label">Custom</span>
                <span className="canvas-field-group" title="Page size in millimetres">
                  <MmField
                    value={round1(doc.page_width_mm)}
                    min={10}
                    max={2000}
                    unit="×"
                    title="Page width in millimetres"
                    onChange={(page_width_mm) => commit((c) => ({ ...c, page_width_mm }))}
                  />
                  <MmField
                    value={round1(doc.page_height_mm)}
                    min={10}
                    max={2000}
                    title="Page height in millimetres"
                    onChange={(page_height_mm) => commit((c) => ({ ...c, page_height_mm }))}
                  />
                </span>
              </div>
              <div className="canvas-panel-row">
                <span className="canvas-panel-label">Margin</span>
                <MmField
                  value={round1(marginOf(doc))}
                  min={0}
                  max={100}
                  title="Page margin: a hairline guide on every sheet that photos snap to, and where placed photos flow. 0 hides it."
                  onChange={(margin_mm) => commit((c) => ({ ...c, margin_mm }))}
                />
              </div>
            </div>
          </FilterChip>
        )}
        <label
          className="canvas-swatch canvas-toolbar-swatch"
          style={{ background: doc.background }}
          title={`Paper colour: ${swatchName(doc.background)}`}
        >
          <input
            type="color"
            value={doc.background}
            aria-label="Paper colour"
            onChange={(event) => commit((c) => ({ ...c, background: event.target.value }), { history: false })}
          />
        </label>
        {doc.page_mode === "infinite" && (
          <button
            className={`btn btn-sm canvas-tool${doc.show_page_guide ? " is-on" : ""}`}
            onClick={() => commit((c) => ({ ...c, show_page_guide: !c.show_page_guide }), { history: false })}
            aria-label="Page guide"
            aria-pressed={doc.show_page_guide}
            title="Page guide: outlines the sheets this design would be cut into. Keep your work inside them and switching to Pages moves nothing."
          >
            <IconGuide size={15} />
          </button>
        )}
        <button
          className={`btn btn-sm canvas-tool${doc.show_grid ? " is-on" : ""}`}
          onClick={() => commit((c) => ({ ...c, show_grid: !c.show_grid }), { history: false })}
          aria-label="Grid"
          aria-pressed={doc.show_grid}
          title="Grid: show a measuring grid on the paper (it is never printed)"
        >
          <IconGrid size={15} />
        </button>
        {doc.show_grid && (
          <MmField
            value={doc.grid_mm}
            min={1}
            max={100}
            title="Grid spacing"
            onChange={(grid_mm) => commit((c) => ({ ...c, grid_mm }), { history: false })}
          />
        )}
        <button
          className={`btn btn-sm canvas-tool${doc.snap ? " is-on" : ""}`}
          onClick={() => commit((c) => ({ ...c, snap: !c.snap }), { history: false })}
          aria-label="Snap"
          aria-pressed={doc.snap}
          title="Snap: line edges and centres up with each other and with the page while you drag"
        >
          <IconMagnet size={15} />
        </button>
        <button
          className="btn btn-sm canvas-tool quiet-danger"
          onClick={onClear}
          disabled={!canClear}
          aria-label="Clear the canvas"
          title="Clear the canvas: removes everything you placed. The photos stay in your library."
        >
          <IconTrash size={15} />
        </button>
        {versionsChip}
      </div>

      <span style={{ flex: 1 }} />

      {/* Ahead of the buttons, not after them: its width is reserved so the
          notice never jolts the toolbar, and a reserved-but-empty box at the
          end would hold the buttons off the right edge. */}
      <span
        className={`canvas-save-state${saveFailed ? " is-error" : ""}`}
        aria-live="polite"
        title={
          saveFailed
            ? "The last change could not be saved - check that the app is still connected (⌘S retries)"
            : "The canvas saves itself as you work (⌘S saves right away)"
        }
      >
        {saveFailed
          ? "Not saved"
          : saveState === "saved"
            ? "All changes saved"
            : saveState === "idle"
              ? neverSaved
                ? "Not saved yet"
                : ""
              : "Saving…"}
      </span>

      <div className="control-group">
        <button className="btn btn-sm" onClick={onUndo} disabled={!canUndo} title="Undo (⌘Z)">
          <IconUndo size={14} />
        </button>
        <button className="btn btn-sm" onClick={onRedo} disabled={!canRedo} title="Redo (⌘⇧Z)">
          <IconRedo size={14} />
        </button>
        <button className="btn btn-sm" onClick={() => onZoom(1 / 1.2)} aria-label="Zoom out" title="Zoom out (−)">
          <IconMinus size={14} />
        </button>
        <span className="canvas-zoom-readout" title="How big the page is on screen next to its real printed size">
          {Math.round((zoom * 100) / 3.78)}%
        </span>
        <button className="btn btn-sm" onClick={() => onZoom(1.2)} aria-label="Zoom in" title="Zoom in (+)">
          <IconPlus size={14} />
        </button>
        <button
          className="btn btn-sm canvas-tool"
          onClick={onFit}
          aria-label="Fit one page"
          title="Fit one page in the window (press 0)"
        >
          <IconFitPage size={15} />
        </button>
        <button
          className="btn btn-sm canvas-tool"
          onClick={onFitAll}
          aria-label="Fit the whole layout"
          title="Fit the whole layout in the window - every page at once (press Shift-0)"
        >
          <IconFitAll size={15} />
        </button>
        <button
          className="btn btn-sm canvas-tool"
          onClick={onPrint}
          aria-label="Print view"
          title="Print view: see the pages as they will print - only the paper, filling the window (press P, Escape to come back)"
        >
          <IconPrinter size={15} />
        </button>
        {exportChip}
        <CanvasHelp />
      </div>
    </div>
  );
}

// A millimetre box you can actually type into. A controlled number input that
// writes every keystroke straight to the document cannot take "5": clearing the
// box to type it makes the value empty for a moment, the clamp turns that into
// the minimum, and the 5 lands behind it as 15. So the box keeps its own draft
// while it has focus, hands over only values that are in range, and snaps back
// to the real value when focus leaves.
function MmField({
  value,
  min,
  max,
  unit = "mm",
  label,
  title,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  unit?: string;
  // A word in front of the box saying what the number is.
  label?: string;
  title?: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);
  return (
    <span className="canvas-pages-field" title={title}>
      {label && <span className="canvas-field-label">{label}</span>}
      <input
        type="number"
        className="canvas-number"
        min={min}
        max={max}
        step="any"
        value={draft}
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
        }}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const next = Number(text);
          if (text.trim() !== "" && Number.isFinite(next) && next >= min && next <= max) {
            onChange(next);
          }
        }}
      />
      {unit}
    </span>
  );
}

// The typography of the selected captions, behind one chip that names the
// current face. Size, colour and alignment stay inline in the bar - they are
// the things people reach for constantly; the face, the weight and the
// spacing are set once and then left alone, so they live in the popover.
function FontEditor({
  style,
  onStyle,
}: {
  style: LayoutTextStyle;
  onStyle: (style: Partial<LayoutTextStyle>) => void;
}) {
  const weight = style.weight ?? 600;
  const custom = style.font !== undefined && !FONT_CHOICES.some((choice) => choice.stack === style.font);
  // The "any installed font" box is typed into, not picked from, so it keeps
  // a draft and applies on Enter or blur - a half-typed family name would
  // otherwise flash every caption through nonsense faces.
  const [draft, setDraft] = useState(custom ? fontLabel(style.font) : "");
  useEffect(() => {
    setDraft(custom ? fontLabel(style.font) : "");
  }, [custom, style.font]);
  const applyCustom = () => {
    const name = draft.trim();
    if (!name) {
      if (custom) onStyle({ font: undefined });
      return;
    }
    const quoted = /[\s"']/.test(name) ? `"${name.replace(/"/g, "")}"` : name;
    onStyle({ font: quoted });
  };
  const preview = (stack: string | undefined): React.CSSProperties => ({
    fontFamily: stack,
    fontWeight: weight,
    fontStyle: style.italic ? "italic" : "normal",
  });

  return (
    <FilterChip
      label={`${fontLabel(style.font)} · ${WEIGHT_NAMES[weight] ?? weight}${style.italic ? " Italic" : ""}`}
      title="The typeface, weight and spacing of the selected text"
    >
      <div className="canvas-panel canvas-font-panel">
        <div className="canvas-panel-row">
          <span className="canvas-panel-label">Typeface</span>
          <div className="canvas-font-list" role="listbox" aria-label="Typeface">
            <button
              type="button"
              role="option"
              aria-selected={style.font === undefined}
              className={`canvas-font-option${style.font === undefined ? " active" : ""}`}
              style={preview(undefined)}
              onClick={() => onStyle({ font: undefined })}
            >
              App font
            </button>
            {FONT_CHOICES.map((choice) => (
              <button
                key={choice.label}
                type="button"
                role="option"
                aria-selected={style.font === choice.stack}
                className={`canvas-font-option${style.font === choice.stack ? " active" : ""}`}
                style={preview(choice.stack)}
                onClick={() => onStyle({ font: choice.stack })}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>

        <label className="canvas-panel-row">
          <span className="canvas-panel-label">Any installed font</span>
          <input
            type="text"
            className="canvas-font-custom"
            placeholder="e.g. Cochin"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={applyCustom}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          <span className="canvas-panel-note">
            Type the name of a font on this computer exactly as it appears in Font Book or the Fonts
            settings. It prints from this machine; on another one the closest match is used.
          </span>
        </label>

        <div className="canvas-panel-row">
          <span className="canvas-panel-label">Weight</span>
          <span className="segmented" role="group" aria-label="Weight">
            {[300, 400, 500, 600, 700].map((w) => (
              <button
                key={w}
                className={weight === w ? "active" : ""}
                style={{ fontWeight: w }}
                onClick={() => onStyle({ weight: w })}
              >
                {WEIGHT_NAMES[w]}
              </button>
            ))}
          </span>
        </div>

        <label className="canvas-panel-row">
          <span className="canvas-panel-label">Italic</span>
          <input
            type="checkbox"
            checked={style.italic ?? false}
            onChange={(event) => onStyle({ italic: event.target.checked })}
          />
        </label>

        <div className="canvas-panel-row">
          <span className="canvas-panel-label">Line height</span>
          <MmField
            value={style.line_height ?? 1.25}
            min={0.7}
            max={3}
            unit="×"
            title="Distance between lines, as a multiple of the type size"
            onChange={(line_height) => onStyle({ line_height })}
          />
        </div>

        <div className="canvas-panel-row">
          <span className="canvas-panel-label">Letter spacing</span>
          <MmField
            value={style.letter_spacing ?? 0}
            min={-0.1}
            max={1}
            unit="em"
            title="Extra space between letters, in fractions of the type size"
            onChange={(letter_spacing) => onStyle({ letter_spacing })}
          />
        </div>

        <div className="canvas-panel-row canvas-panel-row--last">
          <div className="canvas-font-sample" style={{ ...textCss(style), fontSize: 18, color: undefined }}>
            The quick brown fox jumps over the lazy dog
          </div>
        </div>
      </div>
    </FilterChip>
  );
}

// Getting the layout OUT of the app: a PDF for the printer, or one HTML file
// that carries its photos inside it. Both are drawn from the same document
// (see canvasExport.ts) with the photos exactly as they are kept: a photo
// without edits goes in as its own saved bytes, an edited one as a lossless
// full-resolution render - never a re-compressed JPEG (see /images/{id}/export).
// That render is why an export is not instant.
// The gestures the canvas can't show you. Everything here is also reachable by
// pointing and clicking - this is the shortcut for people who already know what
// they want, not the only door.
function CanvasHelp() {
  const rows: [string, string][] = [
    ["Move a photo", "Drag it"],
    ["Reorder the pages", "Drag a page up or down the rail on the left"],
    ["Jump to a page", "Click it in the rail"],
    ["Find your way back", "Double-click the empty free canvas to jump to your first photo"],
    ["Design for print", "Turn on the free canvas's page guide and keep your work inside it"],
    ["Select several", "Drag on empty paper, or Shift-click"],
    ["Move the view", "Scroll, or drag the scrollbars · hold Space and drag"],
    ["Zoom the canvas", "+ and − · Alt and scroll · hold Space and scroll"],
    ["Fit one page in the window", "0 (⌘+ and ⌘− zoom the whole app, not the canvas)"],
    ["Fit the whole layout", "Shift-0 - every page, or the whole free canvas, at once"],
    ["See it as it will print", "P - only the paper, filling the window · ← → turn the pages · scroll to zoom, drag to move, 0 fits again · Escape to come back"],
    ["Crop inside a frame", "Double-click the photo, then drag and scroll"],
    ["Resize", "Drag a corner or a side · a photo keeps its shape while the lock is on, Shift frees it · type a size in the bar"],
    ["Rotate", "Drag the round handle above it · Shift for 15° steps"],
    ["Nudge", "Arrow keys · Shift for 10 mm at a time"],
    ["Stacking order", "⌘] and ⌘[ · add Shift for all the way"],
    ["Remove from the page", "Delete (the photo stays in the library)"],
    ["Undo", "⌘Z · ⌘⇧Z to redo"],
  ];
  return (
    <FilterChip
      align="right"
      label={
        <>
          <IconHelp size={13} /> How this works
        </>
      }
      title="Every gesture the canvas understands"
    >
      <dl className="canvas-help">
        {rows.map(([what, how]) => (
          <div key={what}>
            <dt>{what}</dt>
            <dd>{how}</dd>
          </div>
        ))}
      </dl>
    </FilterChip>
  );
}

// --- What is selected, and what can be done with it -------------------------

function CanvasActionBar({
  selection,
  endless,
  cropping,
  onRestack,
  onDelete,
  onFitFrame,
  onCrop,
  onEditPhoto,
  editingOpen,
  onEndCrop,
  onResetCrop,
  onResetRotation,
  aspectLock,
  onAspectLock,
  onResize,
  onPhotoStyle,
  onCopySettings,
  onPasteSettings,
  pasteable,
  onStyle,
}: {
  selection: LayoutItem[];
  endless: boolean;
  cropping: boolean;
  onRestack: (direction: "front" | "back" | "forward" | "backward") => void;
  onDelete: () => void;
  onFitFrame: () => void;
  onCrop: () => void;
  onEditPhoto: () => void;
  editingOpen: boolean;
  onEndCrop: () => void;
  onResetCrop: () => void;
  onResetRotation: () => void;
  aspectLock: boolean;
  onAspectLock: (lock: boolean) => void;
  onResize: (size: { width_mm?: number; height_mm?: number }) => void;
  onPhotoStyle: (style: Partial<LayoutTextStyle>) => void;
  onCopySettings: () => void;
  onPasteSettings: () => void;
  // The kind of item whose settings are on the clipboard, if any.
  pasteable: LayoutItem["kind"] | null;
  onStyle: (style: Partial<LayoutTextStyle>) => void;
}) {
  // With nothing selected the bar teaches instead of going blank - and keeping
  // it in the layout means the canvas below never jumps when a selection
  // appears.
  if (selection.length === 0) {
    return (
      <div className="canvas-action-bar canvas-action-bar--hint">
        Click a photo to select it · drag across the paper to select several · double-click a photo to
        move it inside its frame ·{" "}
        {endless
          ? "double-click the empty canvas to jump back to your first photo"
          : "scroll or drag the scrollbars to get around"}
      </div>
    );
  }

  const photos = selection.filter((item) => item.kind === "photo").length;
  const texts = selection.length - photos;
  const what =
    texts === 0
      ? `${photos} photo${photos === 1 ? "" : "s"} selected`
      : photos === 0
        ? `${texts} text box${texts === 1 ? "" : "es"} selected`
        : `${selection.length} items selected`;
  const textStyle = { ...DEFAULT_TEXT_STYLE, ...(selection.find((i) => i.kind === "text")?.style ?? {}) };
  const firstPhoto = selection.find((item) => item.kind === "photo") ?? null;

  return (
    <div className="canvas-action-bar">
      <span className="canvas-action-what">{what}</span>

      {photos === 1 && selection.length === 1 && !cropping && (
        <button
          className={`btn btn-sm${editingOpen ? " primary" : ""}`}
          aria-pressed={editingOpen}
          onClick={onEditPhoto}
          title={
            editingOpen
              ? "Close the edit panel"
              : "Develop this photo in the editor. Works on a virtual copy tagged 'canvas edit' in the library - the original photo is never changed."
          }
        >
          <IconPencil size={13} /> Edit photo
        </button>
      )}
      {photos === 1 && selection.length === 1 && (
        <button
          className={`btn btn-sm${cropping ? " primary" : ""}`}
          onClick={cropping ? onEndCrop : onCrop}
          title="Move and zoom the photo inside its frame without moving the frame"
        >
          <IconCrop size={13} /> {cropping ? "Done cropping" : "Crop in frame"}
        </button>
      )}
      {cropping && (
        <button className="btn btn-sm" onClick={onResetCrop} title="Centre the photo again at full size">
          Reset crop
        </button>
      )}
      {photos > 0 && !cropping && (
        <button
          className="btn btn-sm"
          onClick={onFitFrame}
          title="Reshape the frame to the photo's own proportions, undoing any crop"
        >
          <IconRotate size={13} /> Fit frame to photo
        </button>
      )}
      {/* Only offered while something is actually turned: a rotation is set by
          the drag handle, and getting back to exactly 0° by hand is the one
          angle the handle is bad at. */}
      {!cropping && selection.some((item) => item.rotation !== 0) && (
        <button
          className="btn btn-sm"
          onClick={onResetRotation}
          title="Set the selected items straight again (0°)"
        >
          Reset rotation
        </button>
      )}

      {photos > 0 && !cropping && firstPhoto && (
        <>
          <span className="canvas-action-divider" />
          {/* Typed size, with the lock tying width and height together. With
              several photos selected the box shows the first one's numbers and
              a new number goes to all of them. */}
          <span className="canvas-field-group" title="The frame's size on the page">
            <MmField
              label="Size"
              value={round1(firstPhoto.width_mm)}
              min={MIN_SIZE_MM}
              max={2000}
              unit="×"
              title="Width in millimetres"
              onChange={(width_mm) => onResize({ width_mm })}
            />
            <MmField
              value={round1(firstPhoto.height_mm)}
              min={MIN_SIZE_MM}
              max={2000}
              title="Height in millimetres"
              onChange={(height_mm) => onResize({ height_mm })}
            />
            <button
              className={`btn btn-sm canvas-lock${aspectLock ? " active" : ""}`}
              aria-pressed={aspectLock}
              title={
                aspectLock
                  ? "Shape locked: width and height change together (click to unlock)"
                  : "Shape free: width and height change separately (click to lock)"
              }
              onClick={() => onAspectLock(!aspectLock)}
            >
              {aspectLock ? <IconLock size={13} /> : <IconLockOpen size={13} />}
            </button>
          </span>

          <span className="canvas-action-divider" />
          {/* The border, measured like the editor's white frame: a share of
              the shorter edge, added around the photo. */}
          <span className="canvas-field-group">
            <MmField
              label="Frame"
              value={firstPhoto.style?.frame_pct ?? 0}
              min={0}
              max={50}
              unit="%"
              title="A border added around the photo, as a share of its shorter edge - like the editor's white frame"
              onChange={(frame_pct) => onPhotoStyle({ frame_pct })}
            />
          <FilterChip
            label={
              <>
                <span
                  className="canvas-swatch-dot"
                  style={{ background: firstPhoto.style?.frame_color ?? "#ffffff" }}
                />
                {swatchName(firstPhoto.style?.frame_color ?? "#ffffff")}
              </>
            }
            title="Frame colour"
          >
            <div className="canvas-panel">
              <div className="canvas-panel-row">
                <span className="canvas-panel-label">Frame colour</span>
                <SwatchPicker
                  value={firstPhoto.style?.frame_color ?? "#ffffff"}
                  label="Frame colour"
                  onChange={(frame_color) => onPhotoStyle({ frame_color })}
                />
              </div>
            </div>
          </FilterChip>
          </span>
        </>
      )}

      {!cropping && (
        <>
          <span className="canvas-action-divider" />
          <button
            className="btn btn-sm"
            onClick={onCopySettings}
            disabled={selection.length !== 1}
            title={
              selection.length === 1
                ? "Remember this item's size, rotation and style, to give to others"
                : "Select one item to copy its settings"
            }
          >
            Copy settings
          </button>
          <button
            className="btn btn-sm"
            onClick={onPasteSettings}
            disabled={!pasteable || !selection.some((item) => item.kind === pasteable)}
            title={
              pasteable
                ? `Give the selected ${pasteable === "photo" ? "photos" : "text boxes"} the copied size, rotation and style`
                : "Copy an item's settings first"
            }
          >
            Paste settings
          </button>
        </>
      )}

      {!cropping && (
        <>
          <span className="canvas-action-divider" />
          <button className="btn btn-sm" onClick={() => onRestack("front")} title="Bring to front (⌘⇧])">
            Bring to front
          </button>
          <button className="btn btn-sm" onClick={() => onRestack("back")} title="Send to back (⌘⇧[)">
            Send to back
          </button>
        </>
      )}

      {texts > 0 && !cropping && (
        <>
          <span className="canvas-action-divider" />
          <FontEditor style={textStyle} onStyle={onStyle} />
          <MmField
            value={textStyle.size_mm ?? 8}
            min={2}
            max={80}
            title="Type size in millimetres, as it would print"
            onChange={(size_mm) => onStyle({ size_mm })}
          />
          <input
            type="color"
            className="canvas-color"
            value={textStyle.color}
            title="Text colour"
            onChange={(event) => onStyle({ color: event.target.value })}
          />
          <span className="segmented segmented--icons" role="group" aria-label="Text alignment">
            {(
              [
                ["left", "Align left", IconAlignLeft],
                ["center", "Centre", IconAlignCenter],
                ["right", "Align right", IconAlignRight],
                ["justify", "Justify", IconAlignJustify],
              ] as const
            ).map(([align, label, Icon]) => (
              <button
                key={align}
                className={(textStyle.align ?? "left") === align ? "active" : ""}
                title={label}
                aria-label={label}
                aria-pressed={(textStyle.align ?? "left") === align}
                onClick={() => onStyle({ align })}
              >
                <Icon size={14} />
              </button>
            ))}
          </span>
          <span className="segmented segmented--icons" role="group" aria-label="Vertical alignment">
            {(
              [
                ["top", "Top of the box", IconAlignTop],
                ["middle", "Middle of the box", IconAlignMiddle],
                ["bottom", "Bottom of the box", IconAlignBottom],
              ] as const
            ).map(([valign, label, Icon]) => (
              <button
                key={valign}
                className={(textStyle.valign ?? "top") === valign ? "active" : ""}
                title={label}
                aria-label={label}
                aria-pressed={(textStyle.valign ?? "top") === valign}
                onClick={() => onStyle({ valign })}
              >
                <Icon size={14} />
              </button>
            ))}
          </span>
        </>
      )}

      <span style={{ flex: 1 }} />
      <button
        className="btn btn-sm quiet-danger"
        onClick={onDelete}
        title="Take these off the page (Delete). The photos stay in the library."
      >
        <IconTrash size={13} /> Remove from page
      </button>
    </div>
  );
}

// --- The canvas's photos, to drag onto the canvas ----------------------------

function Filmstrip({
  images,
  loading,
  placed,
  open,
  onToggle,
  onAdd,
  onDragStart,
  backButton,
}: {
  images: ImageOut[];
  loading: boolean;
  placed: Set<string>;
  open: boolean;
  onToggle: () => void;
  onAdd: (id: string) => void;
  onDragStart: (event: React.PointerEvent, id: string) => void;
  // The workspace's Back, docked into the strip's bottom row so the way out
  // sits bottom-left like in every other view.
  backButton?: React.ReactNode;
}) {
  const remaining = images.filter((image) => !placed.has(image.id)).length;
  // The strip follows the app's shared thumbnail Size, the same control that
  // sizes every grid - one setting for "how big do I want to see photos", not a
  // second one hidden in the canvas. Scaled down from the grid's tile width: a
  // strip is a row you skim along, not a wall you browse.
  const thumbSize = useThumbSize();
  const chipWidth = Math.round(thumbPx(thumbSize) * 0.42);
  return (
    <div className={`canvas-filmstrip${open ? "" : " is-closed"}`}>
      {open && (
        <div className="canvas-filmstrip-row">
          {loading && <span className="canvas-filmstrip-note">Loading…</span>}
          {!loading && images.length === 0 && (
            <span className="canvas-filmstrip-note">No photos yet - select some in the library and choose &ldquo;Add to canvas&rdquo;.</span>
          )}
          {images.map((image) => (
            <button
              key={image.id}
              className={`canvas-chip${placed.has(image.id) ? " is-placed" : ""}`}
              style={{ width: chipWidth, height: Math.round(chipWidth * 0.74) }}
              title={
                placed.has(image.id)
                  ? `${image.original_filename} — already on the canvas. Click to place another copy.`
                  : `${image.original_filename} — click to place it, or drag it where you want it`
              }
              onPointerDown={(event) => {
                // A press that turns into a drag places the photo where it is
                // dropped; a press that doesn't is a plain click and places it
                // on the page for you.
                if (event.button === 0) onDragStart(event, image.id);
              }}
              onClick={() => onAdd(image.id)}
            >
              <img
                src={api.images.thumbnailUrl(image.id, editVersion(image), "small")}
                alt={image.original_filename}
                draggable={false}
              />
              {placed.has(image.id) && (
                <span className="canvas-chip-badge" title="Already placed on the canvas">
                  <IconCheck size={10} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="canvas-filmstrip-head">
        {backButton}
        <button className="btn btn-sm ghost canvas-filmstrip-toggle" onClick={onToggle}>
          <span className="canvas-filmstrip-caret" style={{ transform: open ? "rotate(180deg)" : "none" }}>
            <IconChevronDown size={13} />
          </span>
          The canvas&rsquo;s photos ({images.length})
        </button>
        {open && images.length > 0 && (
          <span className="canvas-filmstrip-note">
            {remaining === 0
              ? "All of them are on the canvas."
              : `${remaining} not on the canvas yet.`}{" "}
            Drag one onto the paper, or click it to drop it on the page you are looking at.
          </span>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import type { ImageOut } from "../api/types";
import { api, editVersion } from "../api/client";
import { COLOR_HEX } from "./ColorLabelPicker";
import { TimelineScrubber } from "./TimelineScrubber";
import { useMergePairs } from "../state/viewPrefs";
import { watchNearViewport } from "../utils/preload";
import { clearLastViewedImage, peekLastViewedImage } from "../utils/lastViewed";

interface Props {
  images: ImageOut[];
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string, index: number, shiftKey: boolean) => void;
  selectMode?: boolean;
  // Immich-style timeline: break the grid into "Month Year" sections with
  // sticky headers. The list is expected to already be sorted newest-first.
  groupByDate?: boolean;
  // Optional per-photo remove (e.g. "remove from this album"); shown as an ×
  // when not in select mode.
  onRemove?: (id: string) => void;
  removeTitle?: string;
}

// Short badge shown on every thumbnail so the file kind is obvious at a glance.
// "RAW+JPG" only when this one card stands in for a merged pair; when both
// halves are shown as separate cards, each shows its own type (RAW / JPG / PNG).
export function fileTypeBadge(fileType: string, merged: boolean): string {
  if (merged) return "RAW+JPG";
  return fileType === "jpeg" ? "JPG" : fileType.toUpperCase();
}

// Badge class so RAW (and merged pairs) get a distinct color from JPG — the
// text alone is too small to tell the kinds apart when scanning a grid.
export function fileTypeBadgeClass(fileType: string, merged: boolean, base = "badge"): string {
  if (merged) return `${base} badge-pair`;
  return fileType === "raw" ? `${base} badge-raw` : base;
}

// Aspect ratio (width/height) used to size a justified grid tile. Clamped so a
// stray panorama or missing dimensions can't blow a row's height out; falls back
// to 3:2 landscape when the photo has no known dimensions.
export function tileAspectRatio(width: number | null | undefined, height: number | null | undefined): number {
  if (!width || !height) return 1.5;
  return Math.min(2.5, Math.max(0.5, width / height));
}

// Inline CSS custom property the justified grid reads for each tile's width.
export function tileStyle(width: number | null | undefined, height: number | null | undefined) {
  return { "--ar": tileAspectRatio(width, height) } as CSSProperties;
}

// Delay before a near-viewport tile actually issues its request. A tile that
// merely flies through the preload zone during a fast scroll leaves it again
// within this window and never hits the network at all.
const LOAD_STABILIZE_MS = 150;

// Grid thumbnail that starts loading shortly after it comes within the
// preload margin of the viewport (see utils/preload.ts) - well before it's
// visible. Replaces native loading="lazy", whose preload distance is
// browser-chosen and (especially in Safari) short enough to read as pop-in.
// Fast scrolling stays cheap twice over: the stabilize delay keeps fly-by
// tiles from requesting at all, and a tile that leaves the preload zone with
// its request still in flight aborts it (src cleared), freeing the connection
// for the region the user actually stopped at. Once a thumbnail has fully
// loaded it stays loaded - scrolling back never re-fetches. Also used by the
// import review grid, which otherwise fired every staged request at once.
export function Thumb({ src, alt }: { src: string; alt: string }) {
  const ref = useRef<HTMLImageElement | null>(null);
  const [shownSrc, setShownSrc] = useState<string | undefined>(undefined);
  const doneRef = useRef(false);
  // Tiles stay visually blank (just the card background) until the pixels
  // have actually arrived - never a broken-image glyph or alt text flash
  // while pending/aborted.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (doneRef.current) {
      // Loaded once already - just follow src changes (edit-version bumps);
      // never unload again.
      setShownSrc(src);
      return;
    }
    let timer: number | null = null;
    const unwatch = watchNearViewport(el, {
      enter: () => {
        if (timer === null && !doneRef.current) {
          timer = window.setTimeout(() => {
            timer = null;
            setShownSrc(src);
          }, LOAD_STABILIZE_MS);
        }
      },
      leave: () => {
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        // Far away again with the request still in flight: removing src makes
        // the browser abort it. No-op when the image already finished.
        if (!doneRef.current) setShownSrc(undefined);
      },
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unwatch();
      // Unmounting mid-flight (a long jump in the virtualized grid): abort
      // the request imperatively - React only discards the node, the browser
      // would finish the download anyway. Freeing the connection means the
      // newest viewport's thumbnails always win over stale ones.
      if (!doneRef.current && el.getAttribute("src")) el.removeAttribute("src");
    };
  }, [src]);

  return (
    <>
      {/* While a tile has requested its thumbnail but the pixels haven't
          arrived yet, fill the card with the same shimmer the Albums skeleton
          cards use - so freshly imported/loading photos animate instead of
          sitting as flat grey blocks. Only shown for tiles actually loading
          (src set, not yet loaded), never for far-off tiles that haven't
          started. */}
      {shownSrc && !visible && <div className="thumb-skeleton" aria-hidden />}
      <img
        ref={ref}
        src={shownSrc}
        decoding="async"
        alt={alt}
        // Fades in via opacity once the pixels arrive (see .thumb-card img in
        // index.css) instead of snapping to visible - a soft appearance rather
        // than a hard pop-in. Stays blank (opacity 0) while pending/aborted.
        className={visible ? "is-loaded" : undefined}
        onLoad={() => {
          doneRef.current = true;
          setVisible(true);
        }}
      />
    </>
  );
}

function monthLabel(iso: string | null): string {
  if (!iso) return "Unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// Group consecutive images sharing a month into sections, carrying each image's
// global index so range-select and arrow-key nav still address the flat list.
function buildSections(images: ImageOut[]): { label: string; items: { image: ImageOut; index: number }[] }[] {
  const sections: { label: string; items: { image: ImageOut; index: number }[] }[] = [];
  images.forEach((image, index) => {
    const label = monthLabel(image.taken_at);
    const last = sections[sections.length - 1];
    if (last && last.label === label) last.items.push({ image, index });
    else sections.push({ label, items: [{ image, index }] });
  });
  return sections;
}

export function ThumbnailGrid({
  images,
  selectedIds,
  onToggleSelect,
  selectMode,
  groupByDate,
  onRemove,
  removeTitle = "Remove",
}: Props) {
  const navigate = useNavigate();
  const mergePairs = useMergePairs();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sectionEls = useRef<Map<string, HTMLElement>>(new Map());
  const cardEls = useRef<Map<string, HTMLElement>>(new Map());

  // Coming back from the detail view: scroll the photo the user was looking
  // at back into view instead of landing at the top. The marker is one-shot -
  // consumed by the first grid that renders with data (which is exactly the
  // grid the back navigation returns to), found or not, so it can never cause
  // a surprise jump in some later, unrelated grid.
  const pendingScrollId = useRef<string | null>(peekLastViewedImage());
  const hasImages = images.length > 0;
  useEffect(() => {
    if (!hasImages || pendingScrollId.current === null) return;
    const target = cardEls.current.get(pendingScrollId.current);
    pendingScrollId.current = null;
    clearLastViewedImage();
    target?.scrollIntoView({ block: "center" });
  }, [hasImages]);

  if (images.length === 0) {
    return <div className="empty-state">No photos here yet.</div>;
  }

  const allIds = images.map((im) => im.id);

  function renderCard(image: ImageOut, index: number) {
    return (
      <div
        key={image.id}
        ref={(el) => {
          if (el) cardEls.current.set(image.id, el);
          else cardEls.current.delete(image.id);
        }}
        style={tileStyle(image.width, image.height)}
        className={`thumb-card${selectMode && selectedIds?.has(image.id) ? " selected" : ""}${
          !selectMode && onRemove ? " has-remove" : ""
        }`}
        onClick={(e) => {
          if (selectMode && onToggleSelect) {
            onToggleSelect(image.id, index, e.shiftKey);
          } else {
            navigate(`/image/${image.id}`, { state: { imageIds: allIds } });
          }
        }}
      >
        <Thumb src={api.images.thumbnailUrl(image.id, editVersion(image))} alt={image.original_filename} />
        <span className={fileTypeBadgeClass(image.file_type, mergePairs && Boolean(image.paired_image_id))}>
          {fileTypeBadge(image.file_type, mergePairs && Boolean(image.paired_image_id))}
        </span>
        {!selectMode && onRemove && (
          <button
            className="card-remove"
            title={removeTitle}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(image.id);
            }}
          >
            ×
          </button>
        )}
        {selectMode && onToggleSelect && (
          <input
            className="select-checkbox"
            type="checkbox"
            checked={selectedIds?.has(image.id) ?? false}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect(image.id, index, e.shiftKey);
            }}
            onChange={() => {}}
          />
        )}
        {(image.rating > 0 || image.color_label !== "none") && (
          <div className="overlay-info">
            <span className="overlay-stars">{image.rating > 0 ? "★".repeat(image.rating) : ""}</span>
            {image.color_label !== "none" && (
              <span
                className="overlay-color-dot"
                style={{ background: COLOR_HEX[image.color_label] }}
                title={image.color_label}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  // With only one or two photos in the view, the grid enlarges them to fill
  // the visible area (no scrolling needed) instead of rendering tiny tiles -
  // see .thumbnail-grid--few in index.css.
  const fewClass = images.length <= 2 ? " thumbnail-grid--few" : "";

  if (!groupByDate) {
    return (
      <div className={`thumbnail-grid${fewClass}`}>
        {images.map((image, index) => renderCard(image, index))}
        <i className="grid-filler" aria-hidden />
      </div>
    );
  }

  const sections = buildSections(images);

  return (
    <div className="timeline has-scrubber" ref={rootRef}>
      {sections.map((section) => (
        <section
          key={section.label}
          className="timeline-section"
          ref={(el) => {
            if (el) sectionEls.current.set(section.label, el);
            else sectionEls.current.delete(section.label);
          }}
        >
          <h3 className="timeline-header">
            {section.label}
            <span className="timeline-header-count">{section.items.length}</span>
          </h3>
          <div className={`thumbnail-grid${fewClass}`}>
            {section.items.map(({ image, index }) => renderCard(image, index))}
            <i className="grid-filler" aria-hidden />
          </div>
        </section>
      ))}

      <TimelineScrubber
        getScroller={() =>
          (rootRef.current?.closest(".page-scroll") ?? rootRef.current?.closest(".page")) as HTMLElement | null
        }
        getSectionEl={(label) => sectionEls.current.get(label) ?? null}
        sections={sections.map((s) => ({ label: s.label }))}
      />
    </div>
  );
}

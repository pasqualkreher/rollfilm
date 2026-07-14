import { useRef, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import type { ImageOut } from "../api/types";
import { api, editVersion } from "../api/client";
import { COLOR_HEX } from "./ColorLabelPicker";
import { TimelineScrubber } from "./TimelineScrubber";
import { useMergePairs } from "../state/viewPrefs";

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

  if (images.length === 0) {
    return <div className="empty-state">No photos here yet.</div>;
  }

  const allIds = images.map((im) => im.id);

  function renderCard(image: ImageOut, index: number) {
    return (
      <div
        key={image.id}
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
        <img src={api.images.thumbnailUrl(image.id, editVersion(image))} loading="lazy" alt={image.original_filename} />
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
        getAnchor={() => rootRef.current}
        sections={sections.map((s) => ({ label: s.label }))}
      />
    </div>
  );
}

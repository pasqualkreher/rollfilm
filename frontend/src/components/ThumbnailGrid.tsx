import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { ImageOut } from "../api/types";
import { api, editVersion } from "../api/client";
import { COLOR_HEX } from "./ColorLabelPicker";
import { TimelineScrubber } from "./TimelineScrubber";

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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sectionEls = useRef<Map<string, HTMLElement>>(new Map());

  if (images.length === 0) {
    return <div className="empty-state">No photos here yet.</div>;
  }

  const allIds = images.map((im) => im.id);

  function renderCard(image: ImageOut, index: number) {
    // Size each card to the photo's real aspect ratio so the grid shows the
    // whole frame uncropped (portrait stays portrait, panoramas stay wide),
    // instead of the previous square crop. Falls back to the CSS 1/1 when a
    // photo's dimensions aren't known. A manual 90°/270° edit rotation swaps
    // the displayed width/height, so mirror that here.
    let aspectRatio: string | undefined;
    if (image.width && image.height) {
      const quarterTurned = Math.abs(Math.round(image.edit_rotation / 90)) % 2 === 1;
      const [w, h] = quarterTurned ? [image.height, image.width] : [image.width, image.height];
      aspectRatio = `${w} / ${h}`;
    }
    return (
      <div
        key={image.id}
        style={aspectRatio ? { aspectRatio } : undefined}
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
        {image.paired_image_id && <span className="badge">RAW+JPG</span>}
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

  if (!groupByDate) {
    return <div className="thumbnail-grid">{images.map((image, index) => renderCard(image, index))}</div>;
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
          <div className="thumbnail-grid">{section.items.map(({ image, index }) => renderCard(image, index))}</div>
        </section>
      ))}

      <TimelineScrubber
        getScroller={() => rootRef.current?.closest(".page") as HTMLElement | null}
        getSectionEl={(label) => sectionEls.current.get(label) ?? null}
        getAnchor={() => rootRef.current}
        sections={sections.map((s) => ({ label: s.label }))}
      />
    </div>
  );
}

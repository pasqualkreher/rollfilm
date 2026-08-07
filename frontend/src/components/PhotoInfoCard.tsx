import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { COLOR_HEX } from "./ColorLabelPicker";
import { IconInfo } from "./Icons";
import { formatShutterSpeed } from "../utils/photoMeta";

// The card carries no thumbnail of its own - the photo is right there on the
// grid underneath it, and repeating it would only cover more neighbours. So it
// is sized for text: wide enough for a lens name, no wider.
const CARD_W = 268;
// Room the card keeps from the window edges when it is nudged back inside.
const VIEWPORT_MARGIN = 12;

// Gap between the "i" and the card it opens.
const ANCHOR_GAP = 8;

interface Anchor {
  id: string;
  // The "i" button itself, in viewport coordinates - the card opens right
  // beside it.
  rect: DOMRect;
}

function formatTaken(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** A metadata row, rendered only when there is something to say. */
function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function InfoCard({ anchor }: { anchor: Anchor }) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);

  // The same query key the lightbox uses, so a card that has been opened makes
  // opening that photo instant - and a photo opened before costs no request.
  const { data: image } = useQuery({
    queryKey: ["image", anchor.id],
    queryFn: () => api.images.get(anchor.id),
    staleTime: 60_000,
  });
  const { data: albums } = useQuery({
    queryKey: ["albums"],
    queryFn: () => api.albums.list(),
    staleTime: 5 * 60_000,
  });

  // Placed after the card has rendered, because where it fits depends on how
  // tall it turned out - which depends on how much metadata this photo has.
  // Until then it stays invisible rather than flashing at the wrong spot.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    // Right beside the "i", top-aligned with it - so the card reads as coming
    // out of the control that opened it. Flipped to its other side when there
    // isn't room, which is what happens on the last column of the grid.
    let left = anchor.rect.right + ANCHOR_GAP;
    if (left + width > window.innerWidth - VIEWPORT_MARGIN) {
      left = anchor.rect.left - ANCHOR_GAP - width;
    }
    // ...and clamped, for the case where neither side fits (a narrow window).
    // max(margin, …) last, so a card taller than the viewport starts at the
    // top edge instead of being pushed off it by the clamp.
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - width - VIEWPORT_MARGIN));
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(anchor.rect.top, window.innerHeight - height - VIEWPORT_MARGIN)
    );
    setPlaced({ left, top });
  }, [anchor, image, albums]);

  const albumNames = (albums ?? [])
    .filter((a) => image?.album_ids.includes(a.id))
    .map((a) => a.name);
  const place =
    image?.gps_country ??
    (image?.gps_lat != null && image?.gps_lon != null
      ? `${image.gps_lat.toFixed(4)}, ${image.gps_lon.toFixed(4)}`
      : null);

  return createPortal(
    <div
      ref={cardRef}
      className="info-card"
      role="tooltip"
      style={{
        left: placed?.left ?? 0,
        top: placed?.top ?? 0,
        width: CARD_W,
        visibility: placed ? "visible" : "hidden",
      }}
    >
      <div className="info-card-name">
        <span className="info-card-filename">{image?.original_filename ?? "…"}</span>
        {image && image.rating > 0 && (
          <span className="info-card-stars">{"★".repeat(image.rating)}</span>
        )}
        {image && image.color_label !== "none" && (
          <span className="info-card-dot" style={{ background: COLOR_HEX[image.color_label] }} />
        )}
      </div>

      <dl className="info-card-exif">
        <Row label="Taken" value={formatTaken(image?.taken_at ?? null)} />
        <Row
          label="Camera"
          value={[image?.camera_make, image?.camera_model].filter(Boolean).join(" ") || null}
        />
        <Row label="Lens" value={image?.lens_model ?? null} />
        <Row label="ISO" value={image?.iso != null ? String(image.iso) : null} />
        <Row label="Aperture" value={image?.aperture ? `f/${image.aperture}` : null} />
        <Row
          label="Shutter"
          value={image?.shutter_speed ? formatShutterSpeed(image.shutter_speed) : null}
        />
        <Row label="Focal" value={image?.focal_length ? `${image.focal_length}mm` : null} />
        <Row
          label="Size"
          value={image?.width && image?.height ? `${image.width}×${image.height}` : null}
        />
        <Row label="Place" value={place} />
      </dl>

      {/* The written note gets its own block under the measured facts - it is
          prose, not another key/value pair. */}
      {image?.description && <p className="info-card-description">{image.description}</p>}

      {image?.tags.length || albumNames.length ? (
        <div className="info-card-chips">
          {image?.tags.map((tag) => (
            <span key={tag} className="info-card-chip">
              {tag}
            </span>
          ))}
          {albumNames.map((name) => (
            <span key={name} className="info-card-chip info-card-chip--album">
              {name}
            </span>
          ))}
        </div>
      ) : null}
    </div>,
    document.body
  );
}

/**
 * The grid's per-photo info card: a small "i" in each tile's top-left corner
 * shows that photo's details - EXIF, place, its written description, tags and
 * albums. Text only; the photo itself is on the grid right underneath.
 *
 * Purely a hover affordance: rest on the "i" for a moment and the card
 * appears, move away and it is gone. Nothing to open and nothing to close, so
 * checking one photo's ISO costs a pause and no clicks. The card is inert to
 * the mouse - it must never come between the pointer and the grid, or it would
 * swallow the mouse-leave that dismisses it - and the "i" itself swallows
 * clicks so hitting it never opens the lightbox by accident.
 *
 * Returns the button to place inside each tile plus the overlay to render once
 * per grid; the card portals onto <body>, since the grid clips its own overflow.
 */
// Long enough that sweeping the pointer across the grid on the way somewhere
// else never summons a card, short enough to feel like an answer.
const PEEK_DELAY_MS = 550;

export function usePhotoInfoCard(enabled: boolean) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const peekTimer = useRef<number | null>(null);

  const cancelPeekTimer = useCallback(() => {
    if (peekTimer.current !== null) {
      window.clearTimeout(peekTimer.current);
      peekTimer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelPeekTimer();
    setAnchor(null);
  }, [cancelPeekTimer]);

  useEffect(() => cancelPeekTimer, [cancelPeekTimer]);

  // Anything that moves the grid under the card, or takes the user elsewhere,
  // dismisses it - it is placed against a rectangle measured when it opened.
  // Scroll is captured, since it happens on an inner scroller, not the window.
  useEffect(() => {
    if (!anchor) return;
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", close);
    };
  }, [anchor, close]);

  useEffect(() => {
    if (!enabled) close();
  }, [enabled, close]);

  const infoButton = useCallback(
    (id: string) =>
      enabled ? (
        <button
          className="thumb-info-btn"
          title="Photo details"
          aria-label="Show photo details"
          aria-expanded={anchor?.id === id}
          onMouseEnter={(e) => {
            const button = e.currentTarget;
            cancelPeekTimer();
            peekTimer.current = window.setTimeout(() => {
              peekTimer.current = null;
              // Measured now, not on enter: the grid may have been re-laid out
              // (or the tile unmounted by the virtual grid) in between. Taken
              // from the button, so the card opens where the pointer already is.
              if (!button.isConnected) return;
              setAnchor({ id, rect: button.getBoundingClientRect() });
            }, PEEK_DELAY_MS);
          }}
          onMouseLeave={close}
          // The card is a hover, so the "i" has nothing to do on a click -
          // except stop the tile underneath from opening the lightbox, and stop
          // the press from starting a selection on the grid.
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <IconInfo size={12} />
        </button>
      ) : null,
    [enabled, anchor, close, cancelPeekTimer]
  );

  return { infoButton, overlay: anchor ? <InfoCard key={anchor.id} anchor={anchor} /> : null };
}

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, editVersion } from "../api/client";
import type { CropBox, ImageOut } from "../api/types";

interface Props {
  image: ImageOut;
  onClose: () => void;
}

interface DragRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function normalize(rect: DragRect): CropBox {
  return {
    x: Math.min(rect.x0, rect.x1),
    y: Math.min(rect.y0, rect.y1),
    width: Math.abs(rect.x1 - rect.x0),
    height: Math.abs(rect.y1 - rect.y0),
  };
}

export function ImageEditor({ image, onClose }: Props) {
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragRect | null>(null);
  const [dragging, setDragging] = useState(false);

  const rotate = useMutation({
    mutationFn: (degrees: 90 | -90) => api.images.rotate(image.id, degrees),
    onSuccess: () => {
      setDrag(null);
      queryClient.invalidateQueries({ queryKey: ["image", image.id] });
      queryClient.invalidateQueries({ queryKey: ["images"] });
    },
  });

  const crop = useMutation({
    mutationFn: (box: CropBox | null) => api.images.crop(image.id, box),
    onSuccess: () => {
      setDrag(null);
      queryClient.invalidateQueries({ queryKey: ["image", image.id] });
      queryClient.invalidateQueries({ queryKey: ["images"] });
    },
  });

  function fractionAt(clientX: number, clientY: number) {
    const box = containerRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max((clientX - box.left) / box.width, 0), 1),
      y: Math.min(Math.max((clientY - box.top) / box.height, 0), 1),
    };
  }

  function handleMouseDown(e: React.MouseEvent) {
    const p = fractionAt(e.clientX, e.clientY);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    setDragging(true);
  }
  function handleMouseMove(e: React.MouseEvent) {
    if (!dragging || !drag) return;
    const p = fractionAt(e.clientX, e.clientY);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  }
  function handleMouseUp() {
    setDragging(false);
  }

  const normalized = drag ? normalize(drag) : null;
  const hasDrawnCrop = normalized && normalized.width > 0.02 && normalized.height > 0.02;
  const hasSavedCrop = image.edit_crop_x !== null;

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} aria-label="Close">
        ✕
      </button>
      <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
        <div
          ref={containerRef}
          style={{ position: "relative", display: "inline-block", cursor: "crosshair" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          <img
            className="lightbox-image"
            src={api.images.previewUrl(image.id, editVersion(image))}
            alt={image.original_filename}
            draggable={false}
            style={{ userSelect: "none" }}
          />
          {hasDrawnCrop && (
            <div
              style={{
                position: "absolute",
                left: `${normalized!.x * 100}%`,
                top: `${normalized!.y * 100}%`,
                width: `${normalized!.width * 100}%`,
                height: `${normalized!.height * 100}%`,
                border: "2px solid #fff",
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
                pointerEvents: "none",
              }}
            />
          )}
        </div>

        <div className="lightbox-controls">
          <button className="btn" onClick={() => rotate.mutate(-90)} disabled={rotate.isPending}>
            ⟲ Rotate left
          </button>
          <button className="btn" onClick={() => rotate.mutate(90)} disabled={rotate.isPending}>
            ⟳ Rotate right
          </button>
          <span style={{ color: "var(--text-muted)" }}>Drag on the image to draw a crop</span>
          <button
            className="btn primary"
            disabled={!hasDrawnCrop || crop.isPending}
            onClick={() => crop.mutate(normalized!)}
          >
            Apply crop
          </button>
          <button className="btn" disabled={!hasSavedCrop || crop.isPending} onClick={() => crop.mutate(null)}>
            Clear crop
          </button>
        </div>
      </div>
    </div>
  );
}

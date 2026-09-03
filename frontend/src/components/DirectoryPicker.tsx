import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { IconArrowUp, IconFolder, IconX } from "./Icons";

interface Props {
  onSelect: (path: string) => void;
  onClose: () => void;
}

// A server-side folder browser: navigates the backend's /sources mount so the
// user can pick a folder to index without typing a container path by hand.
export function DirectoryPicker({ onSelect, onClose }: Props) {
  // undefined => let the backend start at its browse root (/sources).
  const [path, setPath] = useState<string | undefined>(undefined);

  const { data, isLoading } = useQuery({
    queryKey: ["browse", path ?? "__root__"],
    queryFn: () => api.sources.browse(path),
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal dir-picker" onClick={(e) => e.stopPropagation()}>
        <div className="dir-picker-header">
          <h3 className="section-title" style={{ margin: 0, fontSize: 15 }}>
            Choose a folder
          </h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <IconX size={14} />
          </button>
        </div>

        <div className="dir-picker-path">{data?.path ?? "/sources"}</div>

        <div className="dir-picker-list">
          {isLoading ? (
            <div className="empty-state">Loading…</div>
          ) : !data?.exists ? (
            <div className="empty-state">That folder can't be found inside the backend.</div>
          ) : (
            <>
              {data.parent !== null && (
                <button className="dir-entry dir-up" onClick={() => setPath(data.parent ?? undefined)}>
                  <IconArrowUp size={13} /> Up one level
                </button>
              )}
              {data.entries.length === 0 && (
                <div className="empty-state" style={{ padding: 20 }}>
                  No sub-folders here. Use <strong>Use this folder</strong> to pick it, or go up to look
                  elsewhere. (Your NAS must be mounted into the backend to appear here.)
                </div>
              )}
              {data.entries.map((e) => (
                <button key={e.path} className="dir-entry" onClick={() => setPath(e.path)}>
                  <IconFolder size={13} /> {e.name}
                </button>
              ))}
            </>
          )}
        </div>

        <div className="dir-picker-footer">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!data?.exists}
            onClick={() => data && onSelect(data.path)}
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}

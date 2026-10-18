import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { ImageOut } from "../api/types";
import { ThumbnailGrid } from "./ThumbnailGrid";
import { summarise } from "../utils/rollSummary";
import { plural } from "../utils/plural";

// The roll that just landed, as a contact sheet: name, capture span, cameras,
// count, the photos, and the way into the Library on exactly these. Replaces
// the "N photos added" line after an import.
const SHEET_LIMIT = 120;

export function ImportRollSheet({
  sessionId,
  added,
  albumName,
}: {
  sessionId: string;
  added: ImageOut[];
  albumName: string | null;
}) {
  const navigate = useNavigate();
  const { data: session } = useQuery({
    queryKey: ["import-session", sessionId],
    queryFn: () => api.import.get(sessionId),
  });
  const { span, cameras } = summarise(added);
  const meta = [plural(added.length, "photo"), span, cameras.join(", "), albumName ? `added to “${albumName}”` : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className="import-roll-sheet" role="status" aria-live="polite">
      <div className="import-roll-head">
        <div className="import-roll-title">
          <strong className="import-roll-name">{session?.source_path ?? " "}</strong>
          <span className="import-roll-meta">{meta}</span>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => navigate(`/?roll=${sessionId}`)}>
          Open in Library
        </button>
      </div>
      <div className="import-roll-grid">
        <ThumbnailGrid images={added.slice(0, SHEET_LIMIT)} groupByDate={false} />
        {added.length > SHEET_LIMIT && (
          <p className="import-roll-more">And {(added.length - SHEET_LIMIT).toLocaleString()} more in the Library.</p>
        )}
      </div>
    </section>
  );
}

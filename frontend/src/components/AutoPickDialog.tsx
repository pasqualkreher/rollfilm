import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, editVersion } from "../api/client";
import type { ImageOut, SearchResultOut } from "../api/types";
import { useEscapeToClose } from "../utils/modalKeys";
import { Dropdown } from "./Dropdown";
import { TagFilter } from "./TagFilter";
import { IconCheck, IconPin, IconSparkle, IconTag } from "./Icons";

// A reference can come from the library index (thumb_version) or a full
// photo (edit_rev): either way the thumbnail URL needs its cache key.
export interface PickReference {
  id: string;
  original_filename: string;
  edit_rev?: number | null;
  thumb_version?: string;
}
function thumbKey(image: PickReference): string {
  return image.thumb_version || (image.edit_rev ? String(image.edit_rev) : "");
}

// Auto pick: the photos of the library that go with a reference, narrowed by
// tags or a place if wanted - "the holiday, and of that what looks like this
// one". Opened from the Library's selection bar and right-click menu, the
// photo view and the canvas filmstrip; what the chosen photos are FOR is the
// caller's (select them, add them somewhere, export them), rendered through
// `renderActions`. The library's similar-photos search does the finding.
const COUNTS = [5, 10, 20, 50] as const;
const ANYWHERE = "";
const NO_LOCATION = "__none__";

export function AutoPickDialog({
  references,
  initialReference,
  coreOf,
  excludeIds = [],
  renderActions,
  onClose,
  closing = false,
}: {
  // The photos the reference is chosen from (the selection, the canvas's
  // pool, or the one photo being looked at).
  references: PickReference[];
  // Preselected reference; null = the whole set (needs `coreOf`), else the
  // first reference.
  initialReference: string | null;
  // With this, "Whole set" is offered: the photo nearest the centre of these
  // stands in as the reference (the canvas as a whole).
  coreOf?: ImageOut[];
  // Never offered: what the caller already has.
  excludeIds?: string[];
  // The footer's buttons for the ticked photos.
  renderActions: (chosen: string[], close: () => void) => ReactNode;
  onClose: () => void;
  closing?: boolean;
}) {
  const [reference, setReference] = useState<string | null>(
    initialReference ?? (coreOf ? null : references[0]?.id ?? null)
  );
  const [count, setCount] = useState<(typeof COUNTS)[number]>(10);
  const [tags, setTags] = useState<string[]>([]);
  const [country, setCountry] = useState<string>(ANYWHERE);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const exclude = useMemo(() => new Set(excludeIds), [excludeIds]);
  useEscapeToClose(!closing, onClose);

  const { data: allTags } = useQuery({ queryKey: ["tags"], queryFn: () => api.tags.list() });
  const { data: facets } = useQuery({ queryKey: ["facets", {}], queryFn: () => api.images.facets({}) });

  // "Whole set": its core photo stands in as the reference.
  const core = useQuery({
    queryKey: ["pick-core", (coreOf ?? []).map((p) => p.id).join(",")],
    queryFn: () => api.images.pickCore((coreOf ?? []).map((p) => p.id), 1),
    enabled: reference === null && (coreOf?.length ?? 0) > 0,
    retry: false,
  });
  const effectiveReference = reference ?? core.data?.[0]?.image.id ?? null;

  const picks = useQuery({
    queryKey: ["auto-pick", effectiveReference, count, tags, country, excludeIds],
    queryFn: () =>
      api.images.autoPick({
        reference_ids: [effectiveReference!],
        count,
        exclude_ids: excludeIds,
        tags: tags.length ? tags : null,
        country: country === ANYWHERE ? null : country,
      }),
    enabled: effectiveReference !== null,
    retry: false,
  });
  const results: SearchResultOut[] = useMemo(
    () => (picks.data ?? []).filter((r) => !exclude.has(r.image.id)),
    [picks.data, exclude]
  );
  // A fresh result list starts fully ticked.
  useEffect(() => setUnticked(new Set()), [picks.data]);

  const chosen = results.filter((r) => !unticked.has(r.image.id)).map((r) => r.image.id);
  const notReady =
    (core.error as Error | null)?.message?.includes("not ready") || (picks.error as Error | null)?.message?.includes("not ready");
  const busy = core.isFetching || picks.isFetching;
  const standIn = reference === null && effectiveReference ? coreOf?.find((p) => p.id === effectiveReference) ?? null : null;

  const placeOptions = [
    { value: ANYWHERE, label: "Anywhere" },
    ...(facets?.regions ?? []).map((r) => ({ value: r.value, label: `${r.value} (${r.count})` })),
    ...(facets && facets.no_location_count > 0 ? [{ value: NO_LOCATION, label: `No location (${facets.no_location_count})` }] : []),
  ];

  return (
    <div className={`modal-overlay${closing ? " pm-closing" : ""}`}>
      <div className="modal auto-pick-modal" role="dialog" aria-modal="true" aria-label="Find similar">
        <div className="auto-pick-head">
          <h3>
            <IconSparkle size={15} /> Find similar
          </h3>
          <span className="auto-pick-hint">Photos from your library that go with the reference. Narrow by tags or place if you like.</span>
        </div>

        <div className="auto-pick-body">
          <div className="auto-pick-row">
            <span className="auto-pick-label">Reference</span>
            {references.length === 0 && !coreOf?.length ? (
              <span className="auto-pick-muted">Select a photo first.</span>
            ) : (
              <div className="auto-pick-refs">
                {coreOf && coreOf.length > 0 && (
                  <button
                    type="button"
                    className={`auto-pick-ref auto-pick-ref--all${reference === null ? " is-active" : ""}`}
                    onClick={() => setReference(null)}
                    title="The whole set: its most typical photo stands in"
                  >
                    Whole set
                  </button>
                )}
                {references.map((image) => (
                  <button
                    key={image.id}
                    type="button"
                    className={`auto-pick-ref${reference === image.id ? " is-active" : ""}`}
                    onClick={() => setReference(image.id)}
                    title={image.original_filename}
                    disabled={references.length === 1 && !coreOf}
                  >
                    <img src={api.images.thumbnailUrl(image.id, thumbKey(image), "small")} alt="" draggable={false} />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="auto-pick-row auto-pick-row--filters">
            <span className="auto-pick-label">Narrow</span>
            <TagFilter
              icon={<IconTag size={13} />}
              options={allTags ?? []}
              value={tags}
              onChange={setTags}
              emptyLabel="Any tags"
              title="Only photos carrying all of these tags"
            />
            <Dropdown
              ariaLabel="Place"
              icon={<IconPin size={13} />}
              value={country}
              onChange={setCountry}
              options={placeOptions}
              searchable
            />
          </div>

          <div className="auto-pick-row">
            <span className="auto-pick-label">How many</span>
            <span className="segmented" role="group" aria-label="How many photos">
              {COUNTS.map((n) => (
                <button key={n} type="button" className={count === n ? "active" : ""} onClick={() => setCount(n)}>
                  {n}
                </button>
              ))}
            </span>
            {standIn && <span className="auto-pick-muted">Standing in: {standIn.original_filename}</span>}
          </div>

          <div className="auto-pick-results">
            {notReady ? (
              <p className="auto-pick-muted">Rollfilm is still analysing this photo. Try again in a moment.</p>
            ) : busy ? (
              <p className="auto-pick-muted">Looking…</p>
            ) : effectiveReference === null ? null : results.length === 0 ? (
              <p className="auto-pick-muted">Nothing found with these filters.</p>
            ) : (
              <div className="auto-pick-grid">
                {results.map(({ image }) => {
                  const on = !unticked.has(image.id);
                  return (
                    <button
                      key={image.id}
                      type="button"
                      className={`auto-pick-tile${on ? " is-on" : ""}`}
                      aria-pressed={on}
                      title={image.original_filename}
                      onClick={() =>
                        setUnticked((set) => {
                          const next = new Set(set);
                          if (next.has(image.id)) next.delete(image.id);
                          else next.add(image.id);
                          return next;
                        })
                      }
                    >
                      <img src={api.images.thumbnailUrl(image.id, editVersion(image), "small")} alt="" draggable={false} />
                      <span className="auto-pick-tick">
                        <IconCheck size={11} />
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="auto-pick-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <span className="auto-pick-foot-actions">{renderActions(chosen, onClose)}</span>
        </div>
      </div>
    </div>
  );
}

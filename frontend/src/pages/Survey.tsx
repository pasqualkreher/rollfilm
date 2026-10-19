import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { api, editVersion } from "../api/client";
import type { ColorLabel, Flag, ImageOut, LibraryIndexImage } from "../api/types";
import { RatingStars } from "../components/RatingStars";
import { ColorLabelPicker } from "../components/ColorLabelPicker";
import { FlagPicker } from "../components/FlagPicker";
import { COLOR_KEYS, FLAG_KEYS, SURVEY_MIN, takesTyping } from "../utils/selection";
import { isModalOpen } from "../utils/modalKeys";
import { peekLastViewedImage, rememberLastViewedImage } from "../utils/lastViewed";
import { preloadImage } from "../utils/preload";

// Two to six photos side by side, to decide between them: the keys of any
// grid act on the framed photo (stars, colour, A / X / U), X also takes it out
// of the survey, Esc goes back to the grid with the selection kept. A click or
// Enter opens the framed photo in the photo view, which pages through the
// survey's photos only; Esc there comes back here. Opened with N or the
// right-click menu (utils/selection.surveyState).
export interface SurveyState {
  imageIds: string[];
  // The grid's order (kept for callers; the survey itself pages only its own).
  order?: string[];
  returnTo: string;
  // Written into this history entry before a photo is opened, so coming back
  // finds the survey as it was left (see SurveyView.open).
  removed?: string[];
  active?: number;
}

export function Survey() {
  const location = useLocation();
  const state = location.state as SurveyState | null;
  if (!state || !Array.isArray(state.imageIds) || state.imageIds.length < SURVEY_MIN) {
    return <Navigate to="/" replace />;
  }
  return <SurveyView key={state.imageIds.join(",")} state={state} />;
}

type Patch = { rating?: number; color_label?: ColorLabel; flag?: Flag | "" };

function SurveyView({ state }: { state: SurveyState }) {
  const { imageIds: ids, returnTo } = state;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Back from the photo view: the frame goes to the photo that was on screen
  // there, the rest of the survey comes from the history entry.
  const [active, setActive] = useState(() => {
    const last = peekLastViewedImage();
    const i = last ? ids.indexOf(last) : -1;
    return i >= 0 && !state.removed?.includes(last!) ? i : state.active ?? 0;
  });
  // Taken out with X: the cell stays (nothing else moves), only its photo goes.
  const [removed, setRemoved] = useState<Set<string>>(() => new Set(state.removed ?? []));
  const kept = useMemo(() => ids.filter((id) => !removed.has(id)), [ids, removed]);

  const rows = useQueries({
    queries: ids.map((id) => ({ queryKey: ["image", id], queryFn: () => api.images.get(id) })),
  });
  const byId = useMemo(() => {
    const map = new Map<string, ImageOut>();
    rows.forEach((r, i) => {
      if (r.data) map.set(ids[i], r.data);
    });
    return map;
  }, [rows, ids]);

  // Every preview is wanted at once; ask for them as soon as the rows are in.
  useEffect(() => {
    for (const row of byId.values()) preloadImage(api.images.previewUrl(row.id, editVersion(row)));
  }, [byId]);
  // The grids refetch once, when the survey is left.
  useEffect(() => () => void queryClient.invalidateQueries({ queryKey: ["images"] }), [queryClient]);

  async function patch(id: string, p: Patch) {
    await api.images.update(id, p);
    const { flag, ...rest } = p;
    const tile: { rating?: number; color_label?: ColorLabel; flag?: Flag | null } =
      flag === undefined ? rest : { ...rest, flag: flag || null };
    queryClient.setQueryData<ImageOut>(["image", id], (old) => (old ? { ...old, ...tile } : old));
    queryClient.setQueriesData<{ images: LibraryIndexImage[] }>({ queryKey: ["images", "index"] }, (old) =>
      old ? { ...old, images: old.images.map((im) => (im.id === id ? { ...im, ...tile } : im)) } : old
    );
  }

  function remaining(from: number, dir: 1 | -1): number {
    for (let k = 1; k <= ids.length; k++) {
      const i = (from + dir * k + ids.length) % ids.length;
      if (!removed.has(ids[i])) return i;
    }
    return from;
  }

  function remove(id: string) {
    const next = new Set(removed);
    next.add(id);
    setRemoved(next);
    if (ids[active] === id) {
      for (let k = 1; k <= ids.length; k++) {
        const i = (active + k) % ids.length;
        if (!next.has(ids[i])) {
          setActive(i);
          return;
        }
      }
    }
  }

  function leave() {
    const current = ids[active];
    if (current) rememberLastViewedImage(current);
    navigate(returnTo, { state: { reselect: kept.length > 0 ? kept : ids } });
  }

  // The photo view over the survey's photos. The survey's own state goes
  // into its history entry first: Esc in the photo view is navigate(-1), which
  // mounts this view again from that entry.
  function openAt(i: number) {
    const id = ids[i];
    if (!id || removed.has(id)) return;
    navigate(".", { replace: true, state: { ...state, removed: [...removed], active: i } satisfies SurveyState });
    navigate(`/image/${id}`, { state: { imageIds: kept } });
  }
  function open() {
    openAt(active);
  }

  // Fresh closures each render, one window listener (see utils/selection).
  const latest = useRef({ active, removed, byId, patch, remove, leave, remaining, open, kept });
  latest.current = { active, removed, byId, patch, remove, leave, remaining, open, kept };
  useEffect(() => {
    function act(key: string): boolean {
      const { active, removed, byId, patch, remove } = latest.current;
      const id = ids[active];
      const row = id ? byId.get(id) : undefined;
      if (!id || removed.has(id) || !row) return false;
      if (key.length === 1 && key >= "0" && key <= "5") {
        void patch(id, { rating: Number(key) });
      } else if (key in COLOR_KEYS) {
        const label = COLOR_KEYS[key as keyof typeof COLOR_KEYS];
        void patch(id, { color_label: row.color_label === label ? "none" : label });
      } else if (key.toLowerCase() in FLAG_KEYS) {
        const flag = FLAG_KEYS[key.toLowerCase() as keyof typeof FLAG_KEYS];
        if (flag === "reject") {
          void patch(id, { flag: "reject" });
          remove(id);
        } else {
          void patch(id, { flag: flag && row.flag === flag ? "" : flag });
        }
      } else {
        return false;
      }
      return true;
    }
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && takesTyping(target)) return;
      if (isModalOpen()) return;
      const { active, leave, remaining, open } = latest.current;
      if (e.key === "Escape") {
        e.preventDefault();
        leave();
        return;
      }
      const plain = !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (!plain) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        setActive(remaining(active, e.key === "ArrowRight" ? 1 : -1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        open();
      } else if (!e.shiftKey && act(e.key)) {
        e.preventDefault();
      }
    }
    // The menu bar's Photo menu, on the framed photo.
    function onAppMenu(e: Event) {
      const { action, value } = (e as CustomEvent<{ action: string; value?: string | number }>).detail;
      if (isModalOpen()) return;
      const { active, byId, patch, remove, kept } = latest.current;
      const id = ids[active];
      const row = id ? byId.get(id) : undefined;
      if (!id || !row) return;
      if (action === "photo:rate") void patch(id, { rating: Number(value) });
      else if (action === "photo:color") void patch(id, { color_label: String(value) as ColorLabel });
      else if (action === "photo:flag") {
        const flag = String(value ?? "") as Flag | "";
        void patch(id, { flag });
        if (flag === "reject") remove(id);
      } else if (action === "photo:edit") navigate(`/image/${id}/edit`, { state: { imageIds: kept } });
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pm:app-menu", onAppMenu);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pm:app-menu", onAppMenu);
    };
  }, [ids, navigate]);

  const n = ids.length;
  const columns = Math.min(n, 3);
  const rowsCount = n > 3 ? 2 : 1;
  const left = kept.length;

  return (
    <div className="page survey-page">
      <div className="survey-bar">
        <span className="survey-bar-title">Survey</span>
        <span className="count-pill">{left} of {n}</span>
        <span className="survey-bar-hint">← → frame · 0–5 stars · 6–9 colour · A pick · X reject &amp; take out · click / ↩ open · Esc back</span>
        <button type="button" className="btn btn-sm" onClick={leave}>
          Done
        </button>
      </div>
      <div
        className="survey-grid"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rowsCount}, minmax(0, 1fr))` }}
      >
        {ids.map((id, i) => {
          const row = byId.get(id);
          const gone = removed.has(id);
          return (
            <figure
              key={id}
              className={`survey-cell${i === active ? " active" : ""}${gone ? " removed" : ""}`}
              onClick={() => {
                if (gone) return;
                setActive(i);
                openAt(i);
              }}
            >
              <div className="survey-stage">
                {row && !gone && (
                  <img src={api.images.previewUrl(row.id, editVersion(row))} alt={row.original_filename} decoding="async" draggable={false} />
                )}
              </div>
              <figcaption className="survey-caption">
                <span className="survey-caption-name">{gone ? "Taken out" : row?.original_filename ?? " "}</span>
                {row && !gone && (
                  <>
                    <RatingStars rating={row.rating} onChange={(rating) => void patch(id, { rating })} />
                    <ColorLabelPicker
                      value={row.color_label}
                      onChange={(label) => void patch(id, { color_label: row.color_label === label ? "none" : label })}
                    />
                    <FlagPicker
                      value={row.flag}
                      onChange={(flag) => {
                        void patch(id, { flag });
                        if (flag === "reject") remove(id);
                      }}
                    />
                  </>
                )}
              </figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}

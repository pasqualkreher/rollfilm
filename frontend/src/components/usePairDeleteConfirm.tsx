import { useCallback, useRef, useState } from "react";
import { api } from "../api/client";
import { deleteConfirmMessage, membershipWarning } from "../utils/deleteMessage";
import { useAskDeletePartner } from "../state/viewPrefs";

// Only the field deleteConfirmMessage needs, so the library's slim index
// entries qualify alongside full ImageOut rows.
type DeletableItem = { source_root_id: string | null };

interface Request {
  // The photos the user actually acted on (the current photo, or the current
  // selection). Always deleted.
  baseIds: string[];
  baseItems: DeletableItem[];
  // The hidden RAW/JPEG partners of the base photos. Deleted too unless the
  // user opts to keep them in the prompt below.
  partnerIds: string[];
  partnerItems: DeletableItem[];
}

// A plain "delete these, yes/no?" confirm, or the "only this file / the whole
// pair?" chooser - both rendered as the same skin-styled modal.
// `warning` is the "n of them are in an album or canvas" line, when it applies.
type Pending =
  | {
      kind: "confirm";
      message: string;
      warning: string | null;
      ids: string[];
      resolve: (ids: string[] | null) => void;
    }
  | {
      kind: "choose";
      baseIds: string[];
      partnerIds: string[];
      warning: string | null;
      resolve: (ids: string[] | null) => void;
    };

// Ask the server how many of these photos an album or canvas uses. A failed
// lookup must not block the delete - the dialog simply goes without the line.
async function usageWarning(ids: string[]): Promise<string | null> {
  try {
    return membershipWarning(await api.images.usage(ids), false);
  } catch {
    return null;
  }
}

// Shared "which files should the delete take?" flow for every delete button.
//
// A RAW+JPEG pair is one shot, so historically deleting either half took both.
// With the "ask what to delete" setting on, we instead prompt: only the shown
// file(s), or the whole pair. The setting off keeps the old take-both default.
// Either way the confirmation is a skin-styled modal (not the OS confirm box),
// so it matches the rest of the app.
//
// Returns { dialog, confirmDelete }: render `dialog` somewhere in the page and
// `await confirmDelete(request)` from the delete handler. Resolves to the list
// of ids to delete, or null if the user backed out.
export function usePairDeleteConfirm() {
  const askPartner = useAskDeletePartner();
  const [pending, setPending] = useState<Pending | null>(null);
  // confirmDelete is recreated when askPartner flips; keep the latest in a ref
  // so the returned callback stays stable for callers' effect deps.
  const askRef = useRef(askPartner);
  askRef.current = askPartner;

  const confirmDelete = useCallback(async (req: Request): Promise<string[] | null> => {
    const allIds = [...req.baseIds, ...req.partnerIds];
    // Setting on with a partner in play: let the user pick only the shown
    // file(s) or the whole pair.
    if (askRef.current && req.partnerIds.length > 0) {
      const warning = await usageWarning(allIds);
      return new Promise((resolve) =>
        setPending({
          kind: "choose",
          baseIds: req.baseIds,
          partnerIds: req.partnerIds,
          warning,
          resolve,
        })
      );
    }
    // Otherwise a single confirm. With a partner (setting off) the default is
    // still to take both halves - a pair is one shot.
    const takesPartner = req.partnerIds.length > 0;
    const ids = takesPartner ? allIds : req.baseIds;
    const message = takesPartner
      ? deleteConfirmMessage([...req.baseItems, ...req.partnerItems], req.partnerIds.length)
      : deleteConfirmMessage(req.baseItems);
    const warning = await usageWarning(ids);
    return new Promise((resolve) => setPending({ kind: "confirm", message, warning, ids, resolve }));
  }, []);

  function finish(ids: string[] | null) {
    pending?.resolve(ids);
    setPending(null);
  }

  let dialog: React.ReactNode = null;
  if (pending?.kind === "confirm") {
    dialog = (
      <div className="modal-overlay" onClick={() => finish(null)}>
        <div className="modal pair-delete-modal" onClick={(e) => e.stopPropagation()}>
          <div className="pair-delete-body">
            <p className="pair-delete-message">{pending.message}</p>
            {pending.warning && <p className="pair-delete-warning">{pending.warning}</p>}
            <div className="pair-delete-actions">
              <button className="btn danger danger-filled" onClick={() => finish(pending.ids)}>
                Delete
              </button>
              <button className="btn ghost" onClick={() => finish(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  } else if (pending?.kind === "choose") {
    const { baseIds, partnerIds } = pending;
    dialog = (
      <div className="modal-overlay" onClick={() => finish(null)}>
        <div className="modal pair-delete-modal" onClick={(e) => e.stopPropagation()}>
          <div className="pair-delete-body">
            <h3>{baseIds.length === 1 ? "Delete photo" : `Delete ${baseIds.length} photos`}</h3>
            <p className="settings-desc" style={{ margin: 0 }}>
              {baseIds.length === 1
                ? "This photo has a RAW/JPEG partner. What would you like to delete?"
                : "Some of these photos have a RAW/JPEG partner. What would you like to delete?"}
            </p>
            {pending.warning && <p className="pair-delete-warning">{pending.warning}</p>}
            <div className="pair-delete-actions">
              <button
                className="btn danger danger-filled"
                onClick={() => finish([...baseIds, ...partnerIds])}
              >
                {baseIds.length === 1
                  ? "Delete both (RAW + JPEG)"
                  : `Delete selected + ${partnerIds.length} partner${partnerIds.length === 1 ? "" : "s"}`}
              </button>
              <button className="btn danger" onClick={() => finish(baseIds)}>
                {baseIds.length === 1 ? "Delete only this file" : "Delete only the selected"}
              </button>
              <button className="btn ghost" onClick={() => finish(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return { dialog, confirmDelete };
}

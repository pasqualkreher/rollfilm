import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

// App-skinned replacements for window.confirm / window.alert. The native
// dialogs render in the OS look, ignore the app's theme entirely and (in
// Electron) block the whole window - these draw the same .modal chrome as the
// folder picker, so every popup matches the program's skin.
//
// Usage: const dialogs = useAppDialogs();
//        if (await dialogs.confirm({ title, message })) { ... }
//        await dialogs.alert({ title, message });

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // Destructive confirms get a red action button instead of the accent one.
  danger?: boolean;
}

interface AlertOptions {
  title?: string;
  message: string;
  okLabel?: string;
}

interface DialogRequest {
  kind: "confirm" | "alert";
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

interface DialogApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  alert: (opts: AlertOptions) => Promise<void>;
}

const DialogContext = createContext<DialogApi | null>(null);

export function useAppDialogs(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useAppDialogs must be used inside <DialogProvider>");
  return ctx;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<DialogRequest | null>(null);
  // Requests can arrive while a dialog is already open (rare, but a background
  // error can race a user-triggered confirm) - they wait here in order. The
  // ref mirror of `current` lets the plain callbacks below stay free of state
  // updater functions, whose double-invocation in StrictMode would otherwise
  // double-shift the queue.
  const queueRef = useRef<DialogRequest[]>([]);
  const currentRef = useRef<DialogRequest | null>(null);

  const show = useCallback((req: DialogRequest | null) => {
    currentRef.current = req;
    setCurrent(req);
  }, []);

  const request = useCallback(
    (req: DialogRequest) => {
      if (currentRef.current) queueRef.current.push(req);
      else show(req);
    },
    [show]
  );

  const close = useCallback(
    (ok: boolean) => {
      const cur = currentRef.current;
      if (!cur) return;
      cur.resolve(ok);
      show(queueRef.current.shift() ?? null);
    },
    [show]
  );

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => request({ ...opts, kind: "confirm", resolve })),
    [request]
  );

  const alert = useCallback(
    (opts: AlertOptions) =>
      new Promise<void>((resolve) =>
        request({
          kind: "alert",
          title: opts.title,
          message: opts.message,
          confirmLabel: opts.okLabel,
          resolve: () => resolve(),
        })
      ),
    [request]
  );

  // Escape dismisses like the native dialogs do (cancel for confirm, OK for
  // alert). Captured, so an underlying lightbox/menu with its own Escape
  // handler doesn't also close while a dialog is on top of it.
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        close(current.kind === "alert");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [current, close]);

  const api = useMemo(() => ({ confirm, alert }), [confirm, alert]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {current && (
        <div className="modal-overlay" onClick={() => close(current.kind === "alert")}>
          <div
            className="modal confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-label={current.title ?? current.message}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-modal-body">
              {current.title && <h3>{current.title}</h3>}
              <p>{current.message}</p>
            </div>
            <div className="confirm-modal-actions">
              {current.kind === "confirm" && (
                <button className="btn" onClick={() => close(false)}>
                  {current.cancelLabel ?? "Cancel"}
                </button>
              )}
              <button
                className={`btn ${current.danger ? "danger" : "primary"}`}
                autoFocus
                onClick={() => close(true)}
              >
                {current.confirmLabel ?? "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
}

import { useEffect, useRef } from "react";
import { useAppDialogs } from "./AppDialogs";
import { failureReason } from "../utils/apiError";

// A write the user asked for (rate, tag, delete, add to an album) that fails
// with nobody catching it used to fail without a word: the wait popup closed
// and nothing else happened. This is the net under all of them - whatever
// rejection reaches the window unhandled is said out loud.
//
// Only writes: api/client.ts starts those messages with the HTTP method. A
// preview render or a poll that fails in the background is not something to
// interrupt the user for, and the queries show their own error states.
const WRITE_FAILED = /^(POST|PUT|PATCH|DELETE) \S+ failed: /;

// The same failure is not announced again within this long - an autosave that
// keeps failing must not reopen the dialog on every attempt.
const REPEAT_QUIET_MS = 30_000;

export function UnhandledErrors() {
  const dialogs = useAppDialogs();
  const showing = useRef(false);
  const last = useRef<{ message: string; at: number } | null>(null);

  useEffect(() => {
    function onRejection(e: PromiseRejectionEvent) {
      const raw = (e.reason as Error | undefined)?.message;
      if (typeof raw !== "string" || !WRITE_FAILED.test(raw)) return;
      const message = failureReason(e.reason);
      const now = Date.now();
      if (showing.current) return;
      if (last.current?.message === message && now - last.current.at < REPEAT_QUIET_MS) return;
      last.current = { message, at: now };
      showing.current = true;
      void dialogs
        .alert({ title: "That didn’t work", message })
        .then(() => {
          showing.current = false;
        });
    }
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, [dialogs]);

  return null;
}

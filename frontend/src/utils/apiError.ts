// A failed request carries the backend's explanation as a JSON body inside the
// thrown message ('... failed: 409 {"detail":"…"}'). Where the user reads the
// error - "that name is taken" is the whole point of the message - unwrap the
// detail instead of showing the raw HTTP line.
export function errorText(e: unknown): string {
  const raw = (e as Error)?.message ?? String(e);
  const brace = raw.indexOf("{");
  if (brace !== -1) {
    try {
      const detail = JSON.parse(raw.slice(brace)).detail;
      if (typeof detail === "string") return detail;
    } catch {
      /* not JSON after all - fall through to the raw message */
    }
  }
  return raw;
}

// The same, without the "GET /images/index?… failed: " the request layer puts
// in front: for a message shown where the user can't do anything with the
// address of the request, only with what went wrong.
export function failureReason(e: unknown): string {
  const text = errorText(e).replace(/^[A-Z]+ \S+ failed: /, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

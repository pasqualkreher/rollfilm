// The Library's filter set lives in its URL (see pages/Library.tsx), which the
// sidebar's plain "/" link knows nothing about: a trip to Albums or Settings
// and back landed in the unfiltered library every time. The last filter set
// is remembered here for the length of the session and put back when the
// library is opened without one. "Clear filters" empties the URL and with it
// this memory, so there is always a way back to everything.
let remembered = "";

// The search query is not a filter to come back to: it is typed for one look.
const TRANSIENT_KEYS = ["q"];

export function rememberLibraryFilters(params: URLSearchParams): void {
  const kept = new URLSearchParams(params);
  for (const key of TRANSIENT_KEYS) kept.delete(key);
  remembered = kept.toString();
}

export function rememberedLibraryFilters(): string {
  return remembered;
}

// For arrivals that must show everything - a finished import lands in the
// library to show the photos that just went in, and a filter left on from
// before would hide them.
export function forgetLibraryFilters(): void {
  remembered = "";
}
